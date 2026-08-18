/**
 * API Route: Sync Missing Products (FAST VERSION)
 *
 * Syncs products from Shopify that are not yet in the database.
 * Uses BULK fetch to get all products in ONE request, then saves to DB.
 * Does NOT fetch translations - those are loaded on-demand when editing.
 *
 * This is MUCH faster than the old approach (1 request vs 20+ per product).
 */

import { data as json } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { withDbRaceRetry } from "../utils/db-retry.server";
import { getPlanLimits } from "../utils/planUtils";
import { logger } from "~/utils/logger.server";
import {
  PRODUCT_ATTRIBUTE_SELECTION,
  PRODUCT_COLLECTIONS_SELECTION,
  productAttributeColumns,
  productCollectionRows,
} from "../services/attribute-sync.shared";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);

    // Get current plan limits
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    const plan = (settings?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    // Get existing products from database (include productType to detect NULL entries)
    const existingProducts = await db.product.findMany({
      where: { shop: session.shop },
      select: { id: true, productType: true },
    });
    const existingIds = new Set(existingProducts.map(p => p.id));
    const productsWithNullType = new Set(
      existingProducts.filter(p => p.productType === null).map(p => p.id)
    );

    // Check if we need to sync more products (but always allow repair of NULL productTypes)
    const atPlanLimit = existingProducts.length >= planLimits.maxProducts;
    if (atPlanLimit && productsWithNullType.size === 0) {
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
                updatedAt${PRODUCT_ATTRIBUTE_SELECTION}${PRODUCT_COLLECTIONS_SELECTION}
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

    // Filter to products we don't have OR existing products with NULL productType
    const missingProducts = shopifyProducts.filter((p: any) => !existingIds.has(p.id));
    const productsToRepair = shopifyProducts.filter((p: any) =>
      productsWithNullType.has(p.id) && p.productType
    );

    if (missingProducts.length === 0 && productsToRepair.length === 0) {
      return json({
        success: true,
        synced: 0,
        repaired: 0,
        total: existingProducts.length,
        message: "All products already synced",
      });
    }

    // Repair existing products with NULL productType (fast: only update productType)
    let repaired = 0;
    for (const product of productsToRepair) {
      try {
        await db.product.update({
          where: { shop_id: { shop: session.shop, id: product.id } },
          data: { productType: product.productType },
        });
        repaired++;
      } catch (error: unknown) {
        logger.error("[SYNC-MISSING] Failed to repair productType", { context: "SyncMissing", productId: product.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Save all products to database
    let synced = 0;
    let failed = 0;

    for (const product of missingProducts) {
      try {
        // Upsert product (basic data only - no translations)
        // R4-DI1: atomic + race-safe, mirroring saveToDatabase. Was a
        // bare deleteMany→createMany with NO transaction/retry; this
        // route is user-triggered in parallel with "Apply alt-text
        // templates", so a crash/contention between the two left the
        // product with zero/partial images until the next full sync.
        await withDbRaceRetry(() => db.$transaction(async (tx) => {
        // PLAN_CONTENT_CREATION Phase 0 — same rule as the other product write
        // paths: fetch and map the attribute block through the shared module,
        // or discovered products keep attributesSyncedAt null and read as
        // permanently "unknown".
        const attributes = productAttributeColumns(product);
        const membership = productCollectionRows(session.shop, product.id, product.collections);

        await tx.product.upsert({
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
            ...attributes,
            ...(membership ? { hasMoreCollections: membership.hasMore } : {}),
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
            ...attributes,
            ...(membership ? { hasMoreCollections: membership.hasMore } : {}),
            shopifyUpdatedAt: new Date(product.updatedAt),
            lastSyncedAt: new Date(),
          },
        });

        // Collection membership — rebuilt per product; skipped entirely when
        // the block was not delivered, so a narrower response can never be
        // written as "in 0 collections".
        if (membership) {
          await tx.productCollection.deleteMany({ where: { productId: product.id } });
          if (membership.rows.length > 0) {
            await tx.productCollection.createMany({ data: membership.rows, skipDuplicates: true });
          }
        }

        // Save images if plan allows
        if (planLimits.cacheEnabled.productImages) {
          const mediaImages = product.media?.edges
            ?.filter((edge: any) => edge.node.id && edge.node.image?.url)
            .map((edge: any) => edge.node) || [];

          if (mediaImages.length > 0) {
            // Delete existing images first
            await tx.productImage.deleteMany({ where: { productId: product.id } });

            // Create new images
            await tx.productImage.createMany({
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
        }, { maxWait: 15_000, timeout: 120_000 }));

        synced++;

        // Log progress every 10 products
        if (synced % 10 === 0) {
          logger.debug("[SYNC-MISSING] Progress", { context: "SyncMissing", synced, total: missingProducts.length });
        }
      } catch (error: unknown) {
        logger.error("[SYNC-MISSING] Failed to save product", { context: "SyncMissing", productId: product.id, error: error instanceof Error ? error.message : String(error) });
        failed++;
      }
    }

    if (synced > 0 || repaired > 0) {
      logger.info("[SYNC-MISSING] Complete", { context: "SyncMissing", synced, failed, repaired });
    }

    return json({
      success: true,
      synced,
      repaired,
      failed,
      total: existingProducts.length + synced,
      message: `Synced ${synced} products${repaired > 0 ? `, repaired ${repaired} productTypes` : ""}`,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("[SYNC-MISSING] Error", { context: "SyncMissing", error: msg, stack: error instanceof Error ? error.stack : undefined });
    return json(
      {
        success: false,
        error: "Failed to sync missing products",
      },
      { status: 500 }
    );
  }
};
