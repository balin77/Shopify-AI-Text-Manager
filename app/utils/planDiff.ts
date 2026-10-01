/**
 * Plan-card diffing — "what does THIS tier add over the one below it?"
 *
 * The Settings → Plan cards sit next to each other in tier order, so the only
 * thing a merchant actually scans for is the delta: which lines are new here,
 * and which ones carry a bigger number than on the card to the left. This
 * module derives that delta from PLAN_CONFIG so the cards never hardcode a
 * threshold — the old card had three hand-written ones (`>= 4` parallel
 * conversions, `>= 5000` image operations, `scheduledAudit`), which is exactly
 * the kind of copy that silently goes stale when a limit is re-tiered.
 *
 * The rule for every row is the same: compare the row's VALUE against the same
 * row on the previous tier. `null` means "this row is not rendered on that
 * tier", so a row appearing for the first time counts as a difference too. The
 * lowest tier has nothing below it and therefore highlights nothing.
 *
 * Pure + client-safe (config only, no Prisma, no Shopify) so the card and the
 * unit tests share one implementation.
 */

import { PLAN_CONFIG, type ContentType, type Plan, type PlanLimits } from "../config/plans";
import { getPreviousPlanTier } from "./planUtils";

/**
 * One comparable row of a plan card. A row that is conditionally rendered
 * resolves to `null` on the tiers that hide it.
 */
export type PlanCardRow =
  | "locales"
  | "images"
  | "webpConversion"
  | "imageOperations"
  | "imageTools"
  | "seoBulkBatch"
  | "seoKeywords"
  | "seoScoreHistory"
  | "seoSearchConsole"
  | "seoIndexNow"
  | "seoScheduledAudit"
  | "seoScheduledCrawl";

/**
 * The value each row shows, reduced to something comparable. Rows that render
 * more than one number (Search Console: properties × history window) fold them
 * into one key, because the row is bolded as a whole either way.
 *
 * `null` = row not rendered on this tier.
 */
const ROW_VALUE: Record<PlanCardRow, (config: PlanLimits) => string | number | null> = {
  locales: (c) => c.maxLocales,
  images: (c) => c.productImages,
  // Both image rows are gated in the card: WebP only inside the Pro+ image
  // suite, the operations quota only when it is non-zero.
  webpConversion: (c) => (c.variantImageManager ? c.maxConcurrentWebpConversions : null),
  imageOperations: (c) => (c.monthlyImageOperations > 0 ? c.monthlyImageOperations : null),
  // The image-tools block is one unit: either the five-entry Pro+ suite, or the
  // single Free/Basic line, whose copy depends on `productImages`.
  imageTools: (c) => (c.variantImageManager ? "suite" : `simple:${c.productImages}`),
  seoBulkBatch: (c) => c.seo.bulkBatchSize,
  seoKeywords: (c) => c.seo.maxTrackedKeywords || null,
  seoScoreHistory: (c) => c.seo.scoreHistoryDays || null,
  seoSearchConsole: (c) =>
    c.seo.gscProperties > 0 ? `${c.seo.gscProperties}×${c.seo.gscHistoryDays}` : null,
  seoIndexNow: (c) => c.seo.monthlyIndexNowSubmissions || null,
  seoScheduledAudit: (c) => (c.seo.scheduledAudit ? "on" : null),
  seoScheduledCrawl: (c) => (c.seo.scheduledCrawl ? "on" : null),
};

/**
 * The numeric limit printed behind a content type, or `null` for the types that
 * carry no number (blogs, policies, menus, metaobjects, …). Shared with the card
 * so the rendered text and the comparison can never drift apart.
 */
export function contentTypeLimit(config: PlanLimits, type: ContentType): number | null {
  switch (type) {
    case "products":
      return config.maxProducts;
    case "collections":
      return config.maxCollections;
    case "articles":
      return config.maxArticles;
    case "pages":
      return config.maxPages;
    case "templates":
      return config.maxThemeTranslations;
    default:
      return null;
  }
}

/** Which rows of `plan`'s card differ from the tier below it. */
export interface PlanCardHighlights {
  /** `true` when this row is new here or shows a different value than below. */
  rows: Record<PlanCardRow, boolean>;
  /** Content types that are new on this tier or whose limit went up/down. */
  contentTypes: Set<ContentType>;
  /**
   * `true` only when WebP concurrency is strictly HIGHER than on the tier
   * below — that is what the "2× faster" note claims. Distinct from
   * `rows.webpConversion`, which is also true where the row merely appears for
   * the first time (Pro unlocks the image suite at the same concurrency Basic
   * would have had, so it is new but not faster).
   */
  webpFasterThanPrevious: boolean;
  /** The tier this card was compared against — `null` on the lowest one. */
  previousPlan: Plan | null;
}

/**
 * Derive the highlight set for one plan card.
 *
 * Everything is `false` / empty for the lowest tier: with no card below it,
 * bolding would mark the whole card and mean nothing.
 */
export function getPlanCardHighlights(plan: Plan): PlanCardHighlights {
  const previousPlan = getPreviousPlanTier(plan);
  const rowKeys = Object.keys(ROW_VALUE) as PlanCardRow[];

  if (!previousPlan) {
    return {
      rows: Object.fromEntries(rowKeys.map((row) => [row, false])) as Record<PlanCardRow, boolean>,
      contentTypes: new Set(),
      webpFasterThanPrevious: false,
      previousPlan: null,
    };
  }

  const config = PLAN_CONFIG[plan];
  const previous = PLAN_CONFIG[previousPlan];

  const rows = Object.fromEntries(
    rowKeys.map((row) => [row, ROW_VALUE[row](config) !== ROW_VALUE[row](previous)]),
  ) as Record<PlanCardRow, boolean>;

  const contentTypes = new Set(
    config.contentTypes.filter(
      (type) =>
        !previous.contentTypes.includes(type) ||
        contentTypeLimit(config, type) !== contentTypeLimit(previous, type),
    ),
  );

  return {
    rows,
    contentTypes,
    webpFasterThanPrevious:
      config.maxConcurrentWebpConversions > previous.maxConcurrentWebpConversions,
    previousPlan,
  };
}
