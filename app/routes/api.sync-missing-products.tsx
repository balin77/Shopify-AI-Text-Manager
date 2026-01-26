/**
 * API Route: Sync Missing Products
 *
 * Syncs products from Shopify that are not yet in the database.
 * Used after plan upgrades to fetch additional products.
 *
 * Returns the count of synced products for progress tracking.
 */

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { getPlanLimits } from "../utils/planUtils";
import { ProductSyncService } from "../services/product-sync.service";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("🔄 [SYNC-MISSING] Starting sync of missing products...");

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

    // Fetch products from Shopify
    const maxToFetch = planLimits.maxProducts === Infinity ? 250 : planLimits.maxProducts;

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
      { variables: { first: maxToFetch } }
    );

    const data = await response.json();
    const shopifyProductIds = data.data?.products?.edges?.map((e: any) => e.node.id) || [];

    console.log(`[SYNC-MISSING] Found ${shopifyProductIds.length} products in Shopify`);

    // Find products not in our database
    const missingProductIds = shopifyProductIds.filter((id: string) => !existingIds.has(id));

    if (missingProductIds.length === 0) {
      console.log(`[SYNC-MISSING] No missing products to sync`);
      return json({
        success: true,
        synced: 0,
        total: existingProducts.length,
        message: "All products already synced",
      });
    }

    console.log(`[SYNC-MISSING] Found ${missingProductIds.length} products to sync`);

    // Sync missing products in PARALLEL (5 at a time for speed)
    const syncService = new ProductSyncService(admin, session.shop);
    let synced = 0;
    let failed = 0;

    // Process in batches of 5 for parallel syncing
    const BATCH_SIZE = 5;
    for (let i = 0; i < missingProductIds.length; i += BATCH_SIZE) {
      const batch = missingProductIds.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (productId: string) => {
          await syncService.syncProduct(productId);
          return productId;
        })
      );

      // Count results
      for (const result of results) {
        if (result.status === "fulfilled") {
          synced++;
        } else {
          failed++;
          console.error(`[SYNC-MISSING] Failed:`, result.reason?.message || result.reason);
        }
      }

      console.log(`[SYNC-MISSING] Progress: ${synced + failed}/${missingProductIds.length} (${synced} ok, ${failed} failed)`);
    }

    console.log(`✅ [SYNC-MISSING] Sync complete: ${synced} synced, ${failed} failed`);

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
