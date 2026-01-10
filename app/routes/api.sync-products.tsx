import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { ProductSyncService } from "../services/product-sync.service";

/**
 * API Route: Initial Product Sync
 *
 * Synchronizes all products from Shopify to local database.
 * This should be called once after app installation or when
 * re-syncing is needed.
 *
 * Usage: POST /api/sync-products
 *
 * Optional query params:
 * - force=true: Re-sync even if products already exist
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("🔄 [SYNC-PRODUCTS] Starting initial product sync...");

  try {
    const { admin, session } = await authenticate.admin(request);

    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "true";

    console.log(`[SYNC-PRODUCTS] Shop: ${session.shop}`);
    console.log(`[SYNC-PRODUCTS] Force re-sync: ${force}`);

    const { db } = await import("../db.server");

    // Check if products already exist
    if (!force) {
      const existingCount = await db.product.count({
        where: { shop: session.shop },
      });

      if (existingCount > 0) {
        console.log(`[SYNC-PRODUCTS] Found ${existingCount} existing products, skipping sync`);
        return json({
          success: true,
          message: `Already synced ${existingCount} products. Use ?force=true to re-sync.`,
          synced: 0,
          existing: existingCount,
        });
      }
    }

    // Fetch all products from Shopify
    console.log("[SYNC-PRODUCTS] Fetching products from Shopify...");

    const response = await admin.graphql(
      `#graphql
        query getProducts($first: Int!) {
          products(first: $first) {
            edges {
              node {
                id
              }
            }
          }
        }`,
      { variables: { first: 250 } }
    );

    const data = await response.json();
    const productIds = data.data?.products?.edges?.map((e: any) => e.node.id) || [];

    console.log(`[SYNC-PRODUCTS] Found ${productIds.length} products to sync`);

    if (productIds.length === 0) {
      return json({
        success: true,
        message: "No products found in shop",
        synced: 0,
      });
    }

    // Sync each product
    const syncService = new ProductSyncService(admin, session.shop);
    let synced = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const productId of productIds) {
      try {
        console.log(`[SYNC-PRODUCTS] Syncing product ${synced + 1}/${productIds.length}: ${productId}`);
        await syncService.syncProduct(productId);
        synced++;
      } catch (error: any) {
        console.error(`[SYNC-PRODUCTS] Failed to sync ${productId}:`, error.message);
        failed++;
        errors.push(`${productId}: ${error.message}`);
      }
    }

    console.log(`[SYNC-PRODUCTS] ✓ Sync complete! Synced: ${synced}, Failed: ${failed}`);

    return json({
      success: true,
      message: `Synced ${synced} products (${failed} failed)`,
      synced,
      failed,
      errors: errors.slice(0, 10), // Only return first 10 errors
    });
  } catch (error: any) {
    console.error("[SYNC-PRODUCTS] Error:", error);
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
