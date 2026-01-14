/**
 * API Route: Update Subscription Plan
 * Handles plan changes and cache cleanup
 */

import { type ActionFunctionArgs, json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { isValidPlan, type Plan, getPlanLimits } from "../utils/planUtils";
import { cleanupCacheForPlan, getCacheStats, type CleanupStats } from "../utils/planCacheCleanup";
import { ProductSyncService } from "../services/product-sync.service";

interface UpdatePlanRequest {
  plan: string;
}

interface UpdatePlanResponse {
  success: boolean;
  plan: Plan;
  cleanupStats: CleanupStats;
  syncStats?: {
    synced: number;
    failed: number;
    resyncedForImages: number;
  };
  cacheStats: {
    before: Awaited<ReturnType<typeof getCacheStats>>;
    after: Awaited<ReturnType<typeof getCacheStats>>;
  };
  message: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("🔄 [API/UpdatePlan] Request received");

  try {
    // Authenticate
    const { session, admin } = await authenticate.admin(request);
    console.log("✅ [API/UpdatePlan] Authenticated:", session.shop);

    // Parse request body
    const body = (await request.json()) as UpdatePlanRequest;
    const { plan: newPlan } = body;

    console.log("🔄 [API/UpdatePlan] Requested plan:", newPlan);

    // Validate plan
    if (!isValidPlan(newPlan)) {
      console.error("❌ [API/UpdatePlan] Invalid plan:", newPlan);
      return json(
        {
          success: false,
          error: `Invalid plan: ${newPlan}. Must be one of: free, basic, pro, max`,
        },
        { status: 400 }
      );
    }

    // Get current plan and product count
    const currentSettings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    const currentPlan = (currentSettings?.subscriptionPlan || "basic") as Plan;
    const currentProductCount = await db.product.count({
      where: { shop: session.shop },
    });

    console.log(`📊 [API/UpdatePlan] Current plan: ${currentPlan}, Products: ${currentProductCount}`);

    // Get current cache stats before cleanup
    const cacheStatsBefore = await getCacheStats(session.shop);
    console.log("📊 [API/UpdatePlan] Cache stats before:", cacheStatsBefore);

    // Update plan in database
    await db.aISettings.upsert({
      where: { shop: session.shop },
      update: { subscriptionPlan: newPlan },
      create: {
        shop: session.shop,
        subscriptionPlan: newPlan,
        appLanguage: "de",
        preferredProvider: "huggingface",
      },
    });

    console.log("✅ [API/UpdatePlan] Plan updated in database");

    // Determine if we need to sync more products (upgrade scenario)
    const currentPlanLimits = getPlanLimits(currentPlan);
    const newPlanLimits = getPlanLimits(newPlan);
    const isUpgrade = newPlanLimits.maxProducts > currentPlanLimits.maxProducts;

    // Check if we're upgrading image access (from featured-only to all)
    const isImageUpgrade =
      currentPlanLimits.productImages === "featured-only" &&
      newPlanLimits.productImages === "all";

    let syncStats: { synced: number; failed: number; resyncedForImages: number } | undefined;

    // Handle upgrades (more products available) or image upgrades
    if ((isUpgrade && currentProductCount < newPlanLimits.maxProducts) || isImageUpgrade) {
      console.log(`🔄 [API/UpdatePlan] Upgrading from ${currentPlan} to ${newPlan}...`);

      const syncService = new ProductSyncService(admin, session.shop);
      let synced = 0;
      let failed = 0;
      let resyncedForImages = 0;

      // If upgrading image access, re-sync existing products to get all images
      if (isImageUpgrade) {
        const existingProducts = await db.product.findMany({
          where: { shop: session.shop },
          select: { id: true },
        });

        if (existingProducts.length > 0) {
          console.log(`🖼️ [API/UpdatePlan] Image upgrade detected - re-syncing ${existingProducts.length} existing products for all images...`);

          for (const product of existingProducts) {
            try {
              console.log(`[API/UpdatePlan] Re-syncing product for images ${resyncedForImages + 1}/${existingProducts.length}: ${product.id}`);
              await syncService.syncProduct(product.id);
              resyncedForImages++;
            } catch (error: any) {
              console.error(`[API/UpdatePlan] Failed to re-sync ${product.id}:`, error.message);
              failed++;
            }
          }

          console.log(`✅ [API/UpdatePlan] Re-synced ${resyncedForImages} existing products for all images`);
        }
      }

      // If upgrading product limit, sync additional products
      if (isUpgrade && currentProductCount < newPlanLimits.maxProducts) {
        console.log(`📦 [API/UpdatePlan] Product limit increased - checking for additional products to sync...`);

        // Fetch products from Shopify that we might not have yet
        const maxToSync = newPlanLimits.maxProducts === Infinity ? 250 : newPlanLimits.maxProducts;

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
          { variables: { first: maxToSync } }
        );

        const data = await response.json();
        const allProductIds = data.data?.products?.edges?.map((e: any) => e.node.id) || [];

        console.log(`📦 [API/UpdatePlan] Found ${allProductIds.length} products in Shopify`);

        // Get existing product IDs from database
        const existingProducts = await db.product.findMany({
          where: { shop: session.shop },
          select: { id: true },
        });
        const existingIds = new Set(existingProducts.map(p => p.id));

        // Find products we don't have yet
        const productsToSync = allProductIds.filter((id: string) => !existingIds.has(id));

        console.log(`🔄 [API/UpdatePlan] Need to sync ${productsToSync.length} new products`);

        // Now sync new products
        if (productsToSync.length > 0) {
          for (const productId of productsToSync) {
            try {
              console.log(`[API/UpdatePlan] Syncing new product ${synced + 1}/${productsToSync.length}: ${productId}`);
              await syncService.syncProduct(productId);
              synced++;
            } catch (error: any) {
              console.error(`[API/UpdatePlan] Failed to sync ${productId}:`, error.message);
              failed++;
            }
          }

          console.log(`✅ [API/UpdatePlan] Product sync complete: ${synced} new products synced, ${failed} failed`);
        }
      }

      syncStats = { synced, failed, resyncedForImages };
    }

    // Cleanup cache based on new plan (for downgrades)
    console.log("🧹 [API/UpdatePlan] Starting cache cleanup...");
    const cleanupStats = await cleanupCacheForPlan(session.shop, newPlan);
    console.log("✅ [API/UpdatePlan] Cleanup complete:", cleanupStats);

    // Get cache stats after cleanup
    const cacheStatsAfter = await getCacheStats(session.shop);
    console.log("📊 [API/UpdatePlan] Cache stats after:", cacheStatsAfter);

    const response: UpdatePlanResponse = {
      success: true,
      plan: newPlan,
      cleanupStats,
      syncStats,
      cacheStats: {
        before: cacheStatsBefore,
        after: cacheStatsAfter,
      },
      message: syncStats
        ? `Successfully switched to ${newPlan} plan. Synced ${syncStats.synced} new products${syncStats.resyncedForImages > 0 ? ` and re-synced ${syncStats.resyncedForImages} existing products to fetch all images` : ""}`
        : `Successfully switched to ${newPlan} plan`,
    };

    return json(response);
  } catch (error) {
    console.error("❌ [API/UpdatePlan] Error:", error);
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
};
