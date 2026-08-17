/**
 * Plan Utility Functions
 * Helper functions for checking plan limits and access
 */

import { PLAN_CONFIG, PLAN_DISPLAY_NAMES, type Plan, type ContentType, type PlanLimits, type SeoPlanLimits } from "../config/plans";

// Re-export types for convenience
export type { Plan, ContentType, PlanLimits, SeoPlanLimits } from "../config/plans";

/** Tier order, lowest first — the one place the ranking is written down. */
const PLAN_ORDER: Plan[] = ["free", "basic", "pro", "max"];

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
  const currentIndex = PLAN_ORDER.indexOf(currentPlan);

  if (currentIndex === -1 || currentIndex === PLAN_ORDER.length - 1) {
    return null; // Already at max or invalid plan
  }

  return PLAN_ORDER[currentIndex + 1];
}

/**
 * Hierarchical plan check: does `current` rank at or above `required`?
 * Use this to gate features that need a minimum subscription tier
 * (e.g. Direct Translations requires "max").
 */
export function meetsPlan(current: Plan, required: Plan): boolean {
  return PLAN_ORDER.indexOf(current) >= PLAN_ORDER.indexOf(required);
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
  for (const plan of PLAN_ORDER) {
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

/** Real PSI runs this plan may make per UTC day. See PlanLimits.dailyPageSpeedRuns. */
export function getDailyPageSpeedRunsLimit(plan: Plan): number {
  return getPlanLimits(plan).dailyPageSpeedRuns;
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

// ---------------------------------------------------------------------------
// SEO-tab entitlements — pure helpers over PlanLimits.seo
// ---------------------------------------------------------------------------
//
// Pro has the full SEO feature surface; Max buys automation (nightly audit),
// memory (history), scale (multi-property GSC) and throughput (bulk batches,
// IndexNow quota). See docs/plans/SEO_TAB_IMPLEMENTATION_PLAN.md §Plan-Matrix.
//
// Boolean access is DERIVED from the numbers (0 = locked) rather than stored a
// second time, so a quota and its feature flag can never disagree — the same
// approach getSyncScope takes. Section VISIBILITY stays with
// SeoSectionDef.planGate (enforced in SeoSectionLayout); these helpers govern
// what happens inside a section and belong in the loader/action/service.

/** All SEO entitlements for a plan. */
export function getSeoLimits(plan: Plan): SeoPlanLimits {
  return getPlanLimits(plan).seo;
}

/**
 * Gateable SEO capabilities. The diagnostic sections (overview/audit,
 * structured data, hreflang, redirects, PageSpeed, AEO) are deliberately absent
 * — they are open on every tier and must stay that way.
 */
export type SeoFeature =
  | "scheduledAudit"   // nightly automatic store audit (Max)
  | "scoreHistory"     // score/ranking trend over time (Pro 30d / Max 365d)
  | "keywords"         // target-keyword tracking (Basic+)
  | "searchConsole"    // Google Search Console integration (Pro+)
  | "indexNow";        // IndexNow / instant indexing (Pro+)

/** True if the plan may use the given SEO capability at all. */
export function canAccessSeoFeature(plan: Plan, feature: SeoFeature): boolean {
  const seo = getSeoLimits(plan);
  switch (feature) {
    case "scheduledAudit":
      return seo.scheduledAudit;
    case "scoreHistory":
      return seo.scoreHistoryDays > 0;
    case "keywords":
      return seo.maxTrackedKeywords > 0;
    case "searchConsole":
      return seo.gscProperties > 0;
    case "indexNow":
      return seo.monthlyIndexNowSubmissions > 0;
    default: {
      // Exhaustiveness guard: adding a SeoFeature without a case here is a
      // compile error, not a feature that silently locks on every plan.
      const exhaustive: never = feature;
      return exhaustive;
    }
  }
}

/**
 * Lowest plan that unlocks an SEO capability, for upsell copy. Returns null
 * when there is nothing to upsell — either every tier already has it (like
 * getMinimumPlanForContentType) or no tier does, in which case pointing a Max
 * merchant at Max would be nonsense.
 */
export function getMinimumPlanForSeoFeature(feature: SeoFeature): Plan | null {
  for (const plan of PLAN_ORDER) {
    if (canAccessSeoFeature(plan, feature)) {
      return plan === "free" ? null : plan;
    }
  }
  return null;
}

/** Nightly automatic audit — the headline Max differentiator. */
export function canUseScheduledSeoAudit(plan: Plan): boolean {
  return getSeoLimits(plan).scheduledAudit;
}

/** Days of score/ranking history to keep and chart. 0 = newest snapshot only. */
export function getSeoScoreHistoryDays(plan: Plan): number {
  return getSeoLimits(plan).scoreHistoryDays;
}

/** Distinct tracked keywords allowed per shop. 0 = keyword tracking locked. */
export function getMaxTrackedKeywords(plan: Plan): number {
  return getSeoLimits(plan).maxTrackedKeywords;
}

/**
 * True if `n` more tracked keywords fit. limit === 0 ⇒ always false (feature
 * disabled), matching isWithinImageOperationQuota.
 *
 * Only NEW keywords are checked. A shop that lands over the cap by downgrading
 * keeps every row it has (see SeoPlanLimits.maxTrackedKeywords) — this simply
 * returns false until it is back under the limit.
 */
export function isWithinKeywordQuota(plan: Plan, currentCount: number, n: number = 1): boolean {
  const limit = getMaxTrackedKeywords(plan);
  if (limit === 0) return false;
  return currentCount + n <= limit;
}

/** True if the shop holds more keywords than its (current) plan allows. */
export function isOverKeywordQuota(plan: Plan, currentCount: number): boolean {
  return currentCount > getMaxTrackedKeywords(plan);
}

/** Connectable Google Search Console properties. */
export function getMaxGscProperties(plan: Plan): number {
  return getSeoLimits(plan).gscProperties;
}

/** True if one more GSC property may be connected on this plan. */
export function canConnectGscProperty(plan: Plan, connectedCount: number): boolean {
  return connectedCount < getMaxGscProperties(plan);
}

/** GSC lookback window in days (Pro 28 / Max 480 ≈ the API's own 16 months). */
export function getGscHistoryDays(plan: Plan): number {
  return getSeoLimits(plan).gscHistoryDays;
}

/** Rolling monthly IndexNow submission quota. 0 = IndexNow unavailable. */
export function getMonthlyIndexNowLimit(plan: Plan): number {
  return getSeoLimits(plan).monthlyIndexNowSubmissions;
}

/**
 * True if `n` more IndexNow submissions fit this month. Uses the same UTC
 * period key as the image quota (currentImageOpPeriod) — usage data, lazily
 * enforced, no cron and no downgrade cleanup.
 */
export function isWithinIndexNowQuota(plan: Plan, currentCount: number, n: number = 1): boolean {
  const limit = getMonthlyIndexNowLimit(plan);
  if (limit === 0) return false;
  return currentCount + n <= limit;
}

/** Items processed per bulk-fix / bulk-meta run. */
export function getSeoBulkBatchSize(plan: Plan): number {
  return getSeoLimits(plan).bulkBatchSize;
}

// ============================================================================
// Feature gates — image processing suite (Pro+)
// VariantImageManager, WebP conversion, bulk image upload, bulk alt-text, and
// the related Settings tabs are gated to Pro and Max. Free/Basic see Shopify's
// native product gallery, untouched.
// The `_newFeaturesEnabled` parameter is a legacy env-flag kept for the
// production-rollout machinery (isProductionLocked); the actual gate is the
// plan's `variantImageManager` flag.
// ============================================================================

export function isProductionLocked(): boolean {
  return false;
}

export function canAccessVariantImageManagerInEnv(plan: Plan, _newFeaturesEnabled: boolean): boolean {
  return getPlanLimits(plan).variantImageManager;
}

export function canAccessImageProcessingTab(plan: Plan, _newFeaturesEnabled: boolean): boolean {
  return getPlanLimits(plan).variantImageManager;
}

export function canAccessImageManagerSettingsTab(plan: Plan, _newFeaturesEnabled: boolean): boolean {
  return getPlanLimits(plan).variantImageManager;
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
