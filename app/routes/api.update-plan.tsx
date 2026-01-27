/**
 * API Route: Update Subscription Plan
 * Handles plan changes and cache cleanup
 */

import { type ActionFunctionArgs, json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { isValidPlan, type Plan, getPlanLimits } from "../utils/planUtils";
import { cleanupCacheForPlan, getCacheStats, type CleanupStats } from "../utils/planCacheCleanup";

interface UpdatePlanRequest {
  plan: string;
}

interface UpdatePlanResponse {
  success: boolean;
  plan: Plan;
  cleanupStats: CleanupStats;
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

    // Note: Background sync doesn't work in serverless environments.
    // The actual sync is triggered by the frontend via /api/sync-missing-products
    if (isUpgrade) {
      console.log(`📦 [API/UpdatePlan] Plan upgrade: ${currentPlan} → ${newPlan} (products will sync via frontend)`);
    }

    // Cleanup cache based on new plan (for downgrades)
    // This is a "best effort" operation - if cleanup fails, the plan update is still valid
    console.log("🧹 [API/UpdatePlan] Starting cache cleanup...");
    let cleanupStats: Awaited<ReturnType<typeof cleanupCacheForPlan>>;
    try {
      cleanupStats = await cleanupCacheForPlan(session.shop, newPlan);
      console.log("✅ [API/UpdatePlan] Cleanup complete:", cleanupStats);
    } catch (cleanupError) {
      console.error("⚠️ [API/UpdatePlan] Cache cleanup failed (plan update still successful):", cleanupError);
      // Return default stats if cleanup failed - the plan update was still successful
      cleanupStats = {
        deletedProducts: 0,
        deletedProductImages: 0,
        deletedProductOptions: 0,
        deletedProductMetafields: 0,
        deletedProductTranslations: 0,
        deletedCollections: 0,
        deletedArticles: 0,
        deletedPages: 0,
        deletedPolicies: 0,
        deletedThemeContent: 0,
        deletedThemeTranslations: 0,
        deletedContentTranslations: 0,
      };
    }

    // Get cache stats after cleanup
    const cacheStatsAfter = await getCacheStats(session.shop);
    console.log("📊 [API/UpdatePlan] Cache stats after:", cacheStatsAfter);

    const response: UpdatePlanResponse = {
      success: true,
      plan: newPlan,
      cleanupStats,
      cacheStats: {
        before: cacheStatsBefore,
        after: cacheStatsAfter,
      },
      message: `Successfully switched to ${newPlan} plan`,
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
