/**
 * API Route: Sync Missing Products (FAST VERSION)
 *
 * Syncs products from Shopify that are not yet in the database.
 * Uses BULK fetch to get all products in ONE request, then saves to DB.
 * Does NOT fetch translations - those are loaded on-demand when editing.
 *
 * This is MUCH faster than the old approach (1 request vs 20+ per product).
 */

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { getPlanLimits } from "../utils/planUtils";
import { logger } from "~/utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  logger.debug("[SYNC-MISSING] Starting FAST sync of missing products...", { context: "SyncMissing" });

  try {
    const { admin, session } = await authenticate.admin(request);

    // Get current plan limits
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    const plan = (settings?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    logger.debug("[SYNC-MISSING] Shop and plan details", { context: "SyncMissing", shop: session.shop, plan, maxProducts: planLimits.maxProducts });

    // Get existing products from database (include productType to detect NULL entries)
    const existingProducts = await db.product.findMany({
      where: { shop: session.shop },
      select: { id: true, productType: true },
    });
    const existingIds = new Set(existingProducts.map(p => p.id));
    const productsWithNullType = new Set(
      existingProducts.filter(p => p.productType === null).map(p => p.id)
    );

    logger.debug("[SYNC-MISSING] Found existing products in database", { context: "SyncMissing", count: existingProducts.length, nullProductType: productsWithNullType.size });

    // Check if we need to sync more products (but always allow repair of NULL productTypes)
    const atPlanLimit = existingProducts.length >= planLimits.maxProducts;
    if (atPlanLimit && productsWithNullType.size === 0) {
      logger.debug("[SYNC-MISSING] Already at plan limit and no repairs needed", { context: "SyncMissing" });
      return json({
        success: true,
        synced: 0,
        repaired: 0,
        total: existingProducts.length,
        message: "Already at plan limit",
      });
    }

    // FAST: Fetch ALL products with their data in ONE bulk request
    const maxToFetch = planLimits.maxProducts === Infinity ? 250 : planLimits.maxProducts;

    logger.debug("[SYNC-MISSING] Fetching products from Shopify (bulk)", { context: "SyncMissing", maxToFetch });

    const response = await admin.graphql(
      `#graphql
        query getProductsBulk($first: Int!) {
          products(first: $first) {
            edges {
              node {
                id
                title
                descriptionHtml
                handle
                status
                productType
                updatedAt
                seo {
                  title
                  description
                }
                featuredImage {
                  url
                  altText
                }
                media(first: 20) {
                  edges {
                    node {
                      ... on MediaImage {
                        id
                        alt
                        image {
                          url
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
      { variables: { first: maxToFetch } }
    );

    const data = await response.json();
    const shopifyProducts = data.data?.products?.edges?.map((e: any) => e.node) || [];

    logger.debug("[SYNC-MISSING] Fetched products from Shopify", { context: "SyncMissing", count: shopifyProducts.length });

    // Filter to products we don't have OR existing products with NULL productType
    const missingProducts = shopifyProducts.filter((p: any) => !existingIds.has(p.id));
    const productsToRepair = shopifyProducts.filter((p: any) =>
      productsWithNullType.has(p.id) && p.productType
    );

    if (missingProducts.length === 0 && productsToRepair.length === 0) {
      logger.debug("[SYNC-MISSING] No missing products to sync and no NULL productTypes to repair", { context: "SyncMissing" });
      return json({
        success: true,
        synced: 0,
        repaired: 0,
        total: existingProducts.length,
        message: "All products already synced",
      });
    }

    logger.debug("[SYNC-MISSING] Products to process", { context: "SyncMissing", missing: missingProducts.length, toRepair: productsToRepair.length });

    // Repair existing products with NULL productType (fast: only update productType)
    let repaired = 0;
    for (const product of productsToRepair) {
      try {
        await db.product.update({
          where: { shop_id: { shop: session.shop, id: product.id } },
          data: { productType: product.productType },
        });
        repaired++;
      } catch (error: any) {
        logger.error("[SYNC-MISSING] Failed to repair productType", { context: "SyncMissing", productId: product.id, error: error.message });
      }
    }

    if (repaired > 0) {
      logger.debug("[SYNC-MISSING] Repaired NULL productTypes", { context: "SyncMissing", repaired });
    }

    // Save all products to database
    let synced = 0;
    let failed = 0;

    for (const product of missingProducts) {
      try {
        // Upsert product (basic data only - no translations)
        await db.product.upsert({
          where: {
            shop_id: {
              shop: session.shop,
              id: product.id,
            },
          },
          create: {
            id: product.id,
            shop: session.shop,
            title: product.title,
            descriptionHtml: product.descriptionHtml || "",
            handle: product.handle,
            status: product.status,
            productType: product.productType || null,
            seoTitle: product.seo?.title || null,
            seoDescription: product.seo?.description || null,
            featuredImageUrl: product.featuredImage?.url || null,
            featuredImageAlt: product.featuredImage?.altText || null,
            shopifyUpdatedAt: new Date(product.updatedAt),
            lastSyncedAt: new Date(),
          },
          update: {
            title: product.title,
            descriptionHtml: product.descriptionHtml || "",
            handle: product.handle,
            status: product.status,
            productType: product.productType || null,
            seoTitle: product.seo?.title || null,
            seoDescription: product.seo?.description || null,
            featuredImageUrl: product.featuredImage?.url || null,
            featuredImageAlt: product.featuredImage?.altText || null,
            shopifyUpdatedAt: new Date(product.updatedAt),
            lastSyncedAt: new Date(),
          },
        });

        // Save images if plan allows
        if (planLimits.cacheEnabled.productImages) {
          const mediaImages = product.media?.edges
            ?.filter((edge: any) => edge.node.id && edge.node.image?.url)
            .map((edge: any) => edge.node) || [];

          if (mediaImages.length > 0) {
            // Delete existing images first
            await db.productImage.deleteMany({ where: { productId: product.id } });

            // Create new images
            await db.productImage.createMany({
              data: mediaImages.map((media: any, index: number) => ({
                productId: product.id,
                url: media.image.url,
                altText: media.alt || null,
                mediaId: media.id,
                position: index,
              })),
            });
          }
        }

        synced++;

        // Log progress every 10 products
        if (synced % 10 === 0) {
          logger.debug("[SYNC-MISSING] Progress", { context: "SyncMissing", synced, total: missingProducts.length });
        }
      } catch (error: any) {
        logger.error("[SYNC-MISSING] Failed to save product", { context: "SyncMissing", productId: product.id, error: error.message });
        failed++;
      }
    }

    logger.debug("[SYNC-MISSING] FAST sync complete", { context: "SyncMissing", synced, failed, repaired });

    return json({
      success: true,
      synced,
      repaired,
      failed,
      total: existingProducts.length + synced,
      message: `Synced ${synced} products${repaired > 0 ? `, repaired ${repaired} productTypes` : ""}`,
    });
  } catch (error: any) {
    logger.error("[SYNC-MISSING] Error", { context: "SyncMissing", error: error.message, stack: error.stack });
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
