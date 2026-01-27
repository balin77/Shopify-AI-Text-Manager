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

// ============================================
// New Limit Check Functions
// ============================================

export type ResourceType =
  | "products"
  | "locales"
  | "collections"
  | "articles"
  | "pages"
  | "themeTranslations";

/**
 * Check if the current locale count is within the plan's limit
 */
export function isWithinLocaleLimit(plan: Plan, currentCount: number): boolean {
  const limits = getPlanLimits(plan);
  return currentCount <= limits.maxLocales;
}

/**
 * Check if the current collection count is within the plan's limit
 */
export function isWithinCollectionLimit(plan: Plan, currentCount: number): boolean {
  const limits = getPlanLimits(plan);
  return currentCount <= limits.maxCollections;
}

/**
 * Check if the current article count is within the plan's limit
 */
export function isWithinArticleLimit(plan: Plan, currentCount: number): boolean {
  const limits = getPlanLimits(plan);
  return currentCount <= limits.maxArticles;
}

/**
 * Check if the current page count is within the plan's limit
 */
export function isWithinPageLimit(plan: Plan, currentCount: number): boolean {
  const limits = getPlanLimits(plan);
  return currentCount <= limits.maxPages;
}

/**
 * Check if the current theme translation count is within the plan's limit
 */
export function isWithinThemeTranslationsLimit(plan: Plan, currentCount: number): boolean {
  const limits = getPlanLimits(plan);
  return currentCount <= limits.maxThemeTranslations;
}

/**
 * Get the maximum value for a specific resource type
 */
export function getMaxForResource(plan: Plan, resourceType: ResourceType): number {
  const limits = getPlanLimits(plan);
  switch (resourceType) {
    case "products":
      return limits.maxProducts;
    case "locales":
      return limits.maxLocales;
    case "collections":
      return limits.maxCollections;
    case "articles":
      return limits.maxArticles;
    case "pages":
      return limits.maxPages;
    case "themeTranslations":
      return limits.maxThemeTranslations;
    default:
      return 0;
  }
}

/**
 * Check if the current count is within the limit for a specific resource type
 */
export function isWithinLimit(plan: Plan, resourceType: ResourceType, currentCount: number): boolean {
  const max = getMaxForResource(plan, resourceType);
  return currentCount <= max;
}

/**
 * Calculate usage percentage for a resource type (0-100)
 * Returns 0 if max is 0 (feature disabled)
 */
export function getUsagePercentage(plan: Plan, resourceType: ResourceType, currentCount: number): number {
  const max = getMaxForResource(plan, resourceType);
  if (max === 0) return 0;
  if (max === Infinity) return 0;
  return Math.min(100, Math.round((currentCount / max) * 100));
}

/**
 * Check if approaching the limit for a resource type
 * Default threshold is 80%
 */
export function isApproachingLimit(
  plan: Plan,
  resourceType: ResourceType,
  currentCount: number,
  threshold: number = 0.8
): boolean {
  const max = getMaxForResource(plan, resourceType);
  if (max === 0 || max === Infinity) return false;
  return currentCount >= max * threshold;
}

/**
 * Check if at or over the limit for a resource type
 */
export function isAtLimit(plan: Plan, resourceType: ResourceType, currentCount: number): boolean {
  const max = getMaxForResource(plan, resourceType);
  if (max === 0) return true; // Feature disabled = always at limit
  if (max === Infinity) return false;
  return currentCount >= max;
}

/**
 * Get all resources that are approaching their limits
 */
export function getResourcesApproachingLimits(
  plan: Plan,
  counts: Record<ResourceType, number>,
  threshold: number = 0.8
): ResourceType[] {
  const resources: ResourceType[] = ["products", "locales", "collections", "articles", "pages", "themeTranslations"];
  return resources.filter(resource =>
    isApproachingLimit(plan, resource, counts[resource], threshold)
  );
}
