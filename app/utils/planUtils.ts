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

export type ResourceType =
  | "products"
  | "locales"
  | "collections"
  | "articles"
  | "pages"
  | "themeTranslations";

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
 * Get the minimum plan required to access a content type.
 * Returns null if all plans have access (e.g. products, collections).
 */
export function getMinimumPlanForContentType(contentType: ContentType): Plan | null {
  const planOrder: Plan[] = ["free", "basic", "pro", "max"];
  for (const plan of planOrder) {
    if (PLAN_CONFIG[plan].contentTypes.includes(contentType)) {
      return plan === "free" ? null : plan;
    }
  }
  return "pro"; // fallback
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


/**
 * Check if a plan has access to the Variant Image Manager feature
 */
export function canAccessVariantImageManager(plan: Plan): boolean {
  return getPlanLimits(plan).variantImageManager;
}

// ---------------------------------------------------------------------------
// Monthly image-operation quota — pure helpers (single source of truth)
// ---------------------------------------------------------------------------
//
// Billable image operations = Bulk-Upload + WebP conversion (real compute/
// bandwidth cost; AI is merchant-funded BYO). The quota is rolling per calendar
// month and enforced LAZILY at the upload/convert routes (mirrors how
// maxProducts is enforced lazily, not via cleanup). It is usage data, not
// entitlement data, so it is deliberately NOT a sync phase — getSyncScope and
// planCacheCleanup stay untouched. See docs/ROADMAP.md §Limit-Review Befund 3.

/**
 * Monthly billable-image-operation cap for a plan. 0 = feature unavailable
 * (Free/Basic have no image manager anyway).
 */
export function getMonthlyImageOperationsLimit(plan: Plan): number {
  return getPlanLimits(plan).monthlyImageOperations;
}

/**
 * Current quota period key in UTC, format "YYYY-MM". The counter table keys
 * rows by (shop, period); a new month starts a fresh row (lazy reset, no cron).
 */
export function currentImageOpPeriod(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * True if `n` more image operations fit within the plan's monthly quota given
 * the current count. limit === 0 ⇒ always false (feature disabled), matching
 * the isAtLimit convention. No Infinity case — image ops are always capped.
 */
export function isWithinImageOperationQuota(
  plan: Plan,
  currentCount: number,
  n: number = 1
): boolean {
  const limit = getMonthlyImageOperationsLimit(plan);
  if (limit === 0) return false;
  return currentCount + n <= limit;
}

// ============================================================================
// Production lock — temporary gating while the app is under Shopify review.
// Hides features that were added on `develop` after the version submitted for
// review. Remove these once the new feature set is approved and ready to ship.
// ============================================================================

/**
 * Server-only: true when running with APP_ENV=production (Railway prod).
 * Do NOT call from client code — use `newFeaturesEnabled` from PlanContext.
 */
export function isProductionLocked(): boolean {
  return process.env.APP_ENV === "production";
}

/**
 * Variant Image Manager visibility, combining plan tier + production lock.
 */
export function canAccessVariantImageManagerInEnv(plan: Plan, newFeaturesEnabled: boolean): boolean {
  return newFeaturesEnabled && canAccessVariantImageManager(plan);
}

/**
 * Image Processing tab (new sub-tabs: Bulk Alt Text Templates, new Bulk Upload flow).
 * No plan check — the tab exists for all paying plans on develop.
 */
export function canAccessImageProcessingTab(newFeaturesEnabled: boolean): boolean {
  return newFeaturesEnabled;
}

/**
 * Settings → Image Manager card (theme editor deeplinks, enabled toggle, etc.).
 */
export function canAccessImageManagerSettingsTab(plan: Plan, newFeaturesEnabled: boolean): boolean {
  return newFeaturesEnabled && (plan === "pro" || plan === "max");
}

// ---------------------------------------------------------------------------
// Sync scope — single source of truth for "what may a plan sync"
// ---------------------------------------------------------------------------
//
// Both sync paths (services/initial-sync.service.ts and the recurring
// BackgroundSyncService.syncAll) consult ONLY getSyncScope, so the sync stays
// automatically correct whenever the central plan config (config/plans.ts)
// changes. A disabled phase means "do not fetch" — pruning already-cached but
// no-longer-entitled data stays the responsibility of planCacheCleanup.ts
// (the downgrade path), never the sync. The derivation deliberately mirrors
// planCacheCleanup so scope and cleanup can never disagree.

export type SyncPhase =
  | "products"
  | "collections"
  | "articles"
  | "pages"
  | "policies"
  | "themes"
  | "metaobjects"
  | "menus";

export interface PhaseScope {
  enabled: boolean;
  /** Numeric cap where the sync service supports one; undefined = no cap param. */
  max?: number;
}

export type SyncScope = Record<SyncPhase, PhaseScope>;

/**
 * Derives the per-phase sync scope for a plan, purely from getPlanLimits().
 * `enabled` combines contentTypes + cacheEnabled + numeric caps so the scope
 * auto-corrects on any central-config change.
 *
 * Note: "themes" is not part of the ContentType union — its entitlement is
 * derived from cacheEnabled.themes && maxThemeTranslations > 0, mirroring
 * planCacheCleanup.ts exactly (a plan whose themes get pruned on downgrade is
 * exactly a plan where themes.enabled is false).
 */
export function getSyncScope(plan: Plan): SyncScope {
  const l = getPlanLimits(plan);
  const has = (t: ContentType) => l.contentTypes.includes(t);
  return {
    products: { enabled: l.cacheEnabled.products && l.maxProducts > 0, max: l.maxProducts },
    collections: { enabled: has("collections") && l.cacheEnabled.collections, max: l.maxCollections },
    articles: { enabled: has("articles") && l.cacheEnabled.articles && l.maxArticles > 0, max: l.maxArticles },
    pages: { enabled: has("pages") && l.cacheEnabled.pages && l.maxPages > 0, max: l.maxPages },
    policies: { enabled: has("policies") && l.cacheEnabled.policies },
    themes: { enabled: l.cacheEnabled.themes && l.maxThemeTranslations > 0 },
    metaobjects: { enabled: has("metaobjects") },
    menus: { enabled: has("menus") },
  };
}

const ALL_SYNC_PHASES: SyncPhase[] = [
  "products", "collections", "articles", "pages",
  "policies", "themes", "metaobjects", "menus",
];

/**
 * True if moving from `prev` to `next` grants MORE of any content type — a
 * phase becomes newly entitled, or a capped phase's cap increases. Pure
 * function of the central config (future-proof if limits/order change).
 * Returns false for lateral/downgrade moves.
 */
export function planGrantsMore(prev: Plan, next: Plan): boolean {
  const a = getSyncScope(prev);
  const b = getSyncScope(next);
  for (const phase of ALL_SYNC_PHASES) {
    const pa = a[phase];
    const pb = b[phase];
    if (pb.enabled && !pa.enabled) return true; // newly entitled
    if (
      pb.enabled && pa.enabled &&
      pb.max !== undefined && pa.max !== undefined &&
      pb.max > pa.max
    ) {
      return true; // higher cap
    }
  }
  return false;
}
