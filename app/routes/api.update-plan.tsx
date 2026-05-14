/**
 * API Route: Update Subscription Plan
 * Handles plan changes and cache cleanup
 */

import { type ActionFunctionArgs, json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { type Plan, getPlanLimits } from "../utils/planUtils";
import { cleanupCacheForPlan, getCacheStats, type CleanupStats } from "../utils/planCacheCleanup";
import { logger } from "~/utils/logger.server";
import { parseJsonBody, UpdatePlanSchema } from "~/utils/validation";

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
  try {
    const { session, admin } = await authenticate.admin(request);

    const parsed = await parseJsonBody(request, UpdatePlanSchema);
    if (!parsed.success) {
      logger.error("[API/UpdatePlan] Invalid request body", { context: "UpdatePlan", error: parsed.error });
      return json({ success: false, error: parsed.error }, { status: parsed.status });
    }
    const { plan: newPlan } = parsed.data;

    // Get current plan and product count
    const currentSettings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    const currentPlan = (currentSettings?.subscriptionPlan || "free") as Plan;
    const currentProductCount = await db.product.count({
      where: { shop: session.shop },
    });

    // Get current cache stats before cleanup
    const cacheStatsBefore = await getCacheStats(session.shop);

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

    // Determine if we need to sync more products (upgrade scenario)
    const currentPlanLimits = getPlanLimits(currentPlan);
    const newPlanLimits = getPlanLimits(newPlan);

    // Cleanup cache based on new plan (for downgrades)
    let cleanupStats: Awaited<ReturnType<typeof cleanupCacheForPlan>>;
    try {
      cleanupStats = await cleanupCacheForPlan(session.shop, newPlan);
    } catch (cleanupError) {
      logger.warn("[API/UpdatePlan] Cache cleanup failed (plan update still successful)", { context: "UpdatePlan", error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
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

    const cacheStatsAfter = await getCacheStats(session.shop);
    logger.info("[API/UpdatePlan] Plan updated", { context: "UpdatePlan", from: currentPlan, to: newPlan, shop: session.shop });

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
    logger.error("[API/UpdatePlan] Error", { context: "UpdatePlan", error: error instanceof Error ? error.message : String(error) });
    return json(
      {
        success: false,
        error: "Failed to update plan",
      },
      { status: 500 }
    );
  }
};
