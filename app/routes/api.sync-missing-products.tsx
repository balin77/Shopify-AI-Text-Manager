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

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("🚀 [SYNC-MISSING] Starting FAST sync of missing products...");

  try {
    const { admin, session } = await authenticate.admin(request);

    // Get current plan limits
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    const plan = (settings?.subscriptionPlan || "basic") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    console.log(`[SYNC-MISSING] Shop: ${session.shop}, Plan: ${plan}, Max products: ${planLimits.maxProducts}`);

    // Get existing products from database
    const existingProducts = await db.product.findMany({
      where: { shop: session.shop },
      select: { id: true },
    });
    const existingIds = new Set(existingProducts.map(p => p.id));

    console.log(`[SYNC-MISSING] Found ${existingProducts.length} existing products in database`);

    // Check if we need to sync more products
    if (existingProducts.length >= planLimits.maxProducts) {
      console.log(`[SYNC-MISSING] Already at plan limit, no sync needed`);
      return json({
        success: true,
        synced: 0,
        total: existingProducts.length,
        message: "Already at plan limit",
      });
    }

    // FAST: Fetch ALL products with their data in ONE bulk request
    const maxToFetch = planLimits.maxProducts === Infinity ? 250 : planLimits.maxProducts;

    console.log(`[SYNC-MISSING] Fetching up to ${maxToFetch} products from Shopify (bulk)...`);

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

    console.log(`[SYNC-MISSING] Fetched ${shopifyProducts.length} products from Shopify`);

    // Filter to only products we don't have
    const missingProducts = shopifyProducts.filter((p: any) => !existingIds.has(p.id));

    if (missingProducts.length === 0) {
      console.log(`[SYNC-MISSING] No missing products to sync`);
      return json({
        success: true,
        synced: 0,
        total: existingProducts.length,
        message: "All products already synced",
      });
    }

    console.log(`[SYNC-MISSING] Saving ${missingProducts.length} new products to database...`);

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
          console.log(`[SYNC-MISSING] Progress: ${synced}/${missingProducts.length}`);
        }
      } catch (error: any) {
        console.error(`[SYNC-MISSING] Failed to save ${product.id}:`, error.message);
        failed++;
      }
    }

    console.log(`✅ [SYNC-MISSING] FAST sync complete: ${synced} synced, ${failed} failed`);

    return json({
      success: true,
      synced,
      failed,
      total: existingProducts.length + synced,
      message: `Synced ${synced} products`,
    });
  } catch (error: any) {
    console.error("❌ [SYNC-MISSING] Error:", error);
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
