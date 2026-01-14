/**
 * Plan Utility Functions
 * Helper functions for checking plan limits and access
 */

import { PLAN_CONFIG, PLAN_DISPLAY_NAMES, type Plan, type ContentType, type PlanLimits } from "../config/plans";

// Re-export types for convenience
export type { Plan, ContentType, PlanLimits } from "../config/plans";

/**
 * Get the limits and features for a given plan
 */
export function getPlanLimits(plan: Plan): PlanLimits {
  return PLAN_CONFIG[plan];
}

/**
 * Check if a plan has access to a specific content type
 */
export function canAccessContentType(plan: Plan, contentType: ContentType): boolean {
  const limits = getPlanLimits(plan);
  return limits.contentTypes.includes(contentType);
}

/**
 * Check if the current product count is within the plan's limit
 */
export function isWithinProductLimit(plan: Plan, currentCount: number): boolean {
  const limits = getPlanLimits(plan);
  return currentCount < limits.maxProducts;
}

/**
 * Get the next higher plan for upgrade suggestions
 */
export function getNextPlanUpgrade(currentPlan: Plan): Plan | null {
  const planOrder: Plan[] = ["free", "basic", "pro", "max"];
  const currentIndex = planOrder.indexOf(currentPlan);

  if (currentIndex === -1 || currentIndex === planOrder.length - 1) {
    return null; // Already at max or invalid plan
  }

  return planOrder[currentIndex + 1];
}

/**
 * Get the display name for a plan
 */
export function getPlanDisplayName(plan: Plan): string {
  return PLAN_DISPLAY_NAMES[plan];
}

/**
 * Validate if a string is a valid plan
 */
export function isValidPlan(value: string): value is Plan {
  return ["free", "basic", "pro", "max"].includes(value);
}

/**
 * Get the maximum products allowed for a plan
 */
export function getMaxProducts(plan: Plan): number {
  return getPlanLimits(plan).maxProducts;
}

/**
 * Check if AI instructions are editable in the given plan
 */
export function canEditAIInstructions(plan: Plan): boolean {
  return getPlanLimits(plan).aiInstructionsEditable;
}

/**
 * Check if product images (beyond featured) should be cached
 */
export function shouldCacheAllProductImages(plan: Plan): boolean {
  return getPlanLimits(plan).productImages === "all";
}

/**
 * Get all content types accessible in a plan
 */
export function getAccessibleContentTypes(plan: Plan): ContentType[] {
  return getPlanLimits(plan).contentTypes;
}

/**
 * Get a user-friendly description of plan limits
 */
export function getPlanLimitDescription(plan: Plan): string {
  const limits = getPlanLimits(plan);
  const productLimit = limits.maxProducts === Infinity ? "Unlimited" : `${limits.maxProducts}`;
  const contentCount = limits.contentTypes.length;

  return `${productLimit} products, ${contentCount} content types`;
}

/**
 * Check if a specific cache type is enabled for the plan
 */
export function isCacheEnabled(plan: Plan, cacheType: keyof PlanLimits["cacheEnabled"]): boolean {
  return getPlanLimits(plan).cacheEnabled[cacheType];
}
