/**
 * API Route: Update Subscription Plan
 * Handles plan changes and cache cleanup
 */

import { type ActionFunctionArgs, json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { isValidPlan, type Plan } from "../utils/planUtils";
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
    const { session } = await authenticate.admin(request);
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

    // Cleanup cache based on new plan
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
