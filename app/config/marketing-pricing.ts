/**
 * The plan matrix of the public `/pricing` page.
 *
 * Every number and every tick is READ from the configs the app itself
 * enforces — `PLAN_CONFIG` (limits), `BILLING_PLANS` / `MANAGED_BILLING_PLANS`
 * (prices), the SEO sections' `planGate` and the route gates named below. A
 * public price list that restates them is the one that drifts: a limit raised
 * in plans.ts would keep showing the old number here, and a merchant who
 * bought on that number has been misled. The copy (labels, help lines, the
 * words for a value) lives in the marketing bundles under `pricing`.
 *
 * Client-safe and side-effect free: the page renders the matrix in component
 * scope, so nothing here may import a server module.
 */

import { BILLING_PLANS, MANAGED_BILLING_PLANS, type BillingPlan } from "./billing";
import { MANAGED_AI_TASTER_ACTIONS } from "./managed-ai-budget";
import { PLAN_CONFIG, type ContentType, type Plan, type PlanLimits } from "./plans";
import { SEO_SECTIONS } from "./seo-sections";
import { AUTO_TRANSLATE_MIN_PLAN } from "../services/translations/translation-change-policy.shared";

export const PRICING_PLANS: readonly Plan[] = ["free", "basic", "pro", "max"];

/** The plan the page recommends to most shops — marked on its card and column. */
export const PRICING_HIGHLIGHT: Plan = "pro";

/** Every paid plan starts with the same trial; read from the billing config. */
export const PRICING_TRIAL_DAYS = BILLING_PLANS.basic.trialDays ?? 0;

export const PRICING_TASTER_ACTIONS = MANAGED_AI_TASTER_ACTIONS;

/** Monthly price of a plan, with or without the AI included. 0 for Free. */
export function planPrice(plan: Plan, withAi: boolean): number {
  if (plan === "free") return 0;
  const paid = plan as Exclude<BillingPlan, "free">;
  return (withAi ? MANAGED_BILLING_PLANS : BILLING_PLANS)[paid].price;
}

/** Tier order, local so this module stays free of planUtils' imports. */
const TIER: Record<Plan, number> = { free: 0, basic: 1, pro: 2, max: 3 };
const atLeast = (plan: Plan, required: Plan) => TIER[plan] >= TIER[required];

/** A section's own `planGate`, so the page cannot disagree with the nav lock. */
function seoSectionOpen(id: string, plan: Plan): boolean {
  const section = SEO_SECTIONS.find((s) => s.id === id);
  if (!section) return false;
  return section.planGate ? atLeast(plan, section.planGate) : true;
}

/**
 * One table cell. A number renders through its row's `format` template
 * (`{n} per month`); `Infinity` is "unlimited"; `0` on a numeric row is a
 * cross, because a limit of zero means the feature is not in that plan.
 */
export type PricingCell =
  | boolean
  | number
  | { text: "featuredOnly" | "allImages" };

export type PricingGroupId = "content" | "workflow" | "images" | "seo";

export type PricingRowId =
  | "products"
  | "collections"
  | "pages"
  | "articles"
  | "policies"
  | "menus"
  | "metaobjects"
  | "themeTranslations"
  | "checkoutTexts"
  | "notifications"
  | "directTranslations"
  | "languages"
  | "ownKey"
  | "aiInstructions"
  | "bulkEditor"
  | "csvImport"
  | "translateMissing"
  | "autoTranslate"
  | "productImages"
  | "imageSuite"
  | "mediaPerLanguage"
  | "imageOperations"
  | "seoAudit"
  | "pageSpeed"
  | "keywords"
  | "aiDiscovery"
  | "crawl"
  | "searchConsole"
  | "internalLinks"
  | "sitemap"
  | "indexNow"
  | "scoreHistory"
  | "scheduled"
  | "seoBulk";

export type PricingRow = { id: PricingRowId; value: (limits: PlanLimits, plan: Plan) => PricingCell };

const has = (type: ContentType) => (limits: PlanLimits) => limits.contentTypes.includes(type);
/** A count that only exists where the content type is in the plan at all. */
const countOf = (type: ContentType, count: (l: PlanLimits) => number) => (limits: PlanLimits) =>
  limits.contentTypes.includes(type) ? count(limits) : 0;

export const PRICING_GROUPS: ReadonlyArray<{ id: PricingGroupId; rows: PricingRow[] }> = [
  {
    id: "content",
    rows: [
      { id: "products", value: (l) => l.maxProducts },
      { id: "collections", value: (l) => l.maxCollections },
      { id: "pages", value: countOf("pages", (l) => l.maxPages) },
      { id: "articles", value: countOf("articles", (l) => l.maxArticles) },
      { id: "policies", value: has("policies") },
      { id: "menus", value: has("menus") },
      { id: "metaobjects", value: has("metaobjects") },
      { id: "themeTranslations", value: countOf("templates", (l) => l.maxThemeTranslations) },
      { id: "checkoutTexts", value: has("delivery") },
      { id: "notifications", value: has("system") },
      { id: "directTranslations", value: has("directTranslations") },
    ],
  },
  {
    id: "workflow",
    rows: [
      { id: "languages", value: (l) => l.maxLocales },
      { id: "ownKey", value: () => true },
      { id: "aiInstructions", value: (l) => l.aiInstructionsEditable },
      // Route gates: app.bulk.tsx / app.bulk.export.tsx (basic),
      // app.bulk.import.tsx and app.bulk_.translate.tsx (pro).
      { id: "bulkEditor", value: (_l, p) => atLeast(p, "basic") },
      { id: "csvImport", value: (_l, p) => atLeast(p, "pro") },
      { id: "translateMissing", value: (_l, p) => atLeast(p, "pro") },
      { id: "autoTranslate", value: (_l, p) => atLeast(p, AUTO_TRANSLATE_MIN_PLAN) },
    ],
  },
  {
    id: "images",
    rows: [
      { id: "productImages", value: (l) => ({ text: l.productImages === "all" ? "allImages" : "featuredOnly" }) },
      { id: "imageSuite", value: (l) => l.variantImageManager },
      // Images and videos per language/market: the product replacement is gated
      // with the image manager (canAccessVariantImageManagerInEnv), theme images
      // ride the theme editor, which is Pro and up as well.
      { id: "mediaPerLanguage", value: (l) => l.variantImageManager },
      { id: "imageOperations", value: (l) => l.monthlyImageOperations },
    ],
  },
  {
    id: "seo",
    rows: [
      { id: "seoAudit", value: () => true },
      { id: "pageSpeed", value: (l) => l.dailyPageSpeedRuns },
      { id: "keywords", value: (l, p) => (seoSectionOpen("keywords", p) ? l.seo.maxTrackedKeywords : 0) },
      { id: "aiDiscovery", value: (_l, p) => seoSectionOpen("aeo", p) },
      { id: "crawl", value: (_l, p) => seoSectionOpen("crawl", p) },
      { id: "searchConsole", value: (l, p) => (seoSectionOpen("searchConsole", p) ? l.seo.gscHistoryDays : 0) },
      { id: "internalLinks", value: (_l, p) => seoSectionOpen("internalLinks", p) },
      { id: "sitemap", value: (_l, p) => seoSectionOpen("sitemap", p) },
      { id: "indexNow", value: (l, p) => (seoSectionOpen("indexNow", p) ? l.seo.monthlyIndexNowSubmissions : 0) },
      { id: "scoreHistory", value: (l) => l.seo.scoreHistoryDays },
      { id: "scheduled", value: (l) => l.seo.scheduledAudit && l.seo.scheduledCrawl },
      { id: "seoBulk", value: (l) => l.seo.bulkBatchSize },
    ],
  },
];

export function pricingCell(row: PricingRow, plan: Plan): PricingCell {
  return row.value(PLAN_CONFIG[plan], plan);
}

const truthy = (cell: PricingCell) => cell !== false && cell !== 0;

/** Rows the card's limits line already states. */
const LIMITS_LINE_ROWS: ReadonlySet<PricingRowId> = new Set(["products", "collections"]);

/**
 * What a plan's card lists, DERIVED from the matrix so a feature moved to
 * another tier in the app's config moves on the card too: for Free every row
 * it includes, for a paid plan every row it unlocks over the plan below it.
 * Table order, so the card reads like the table.
 */
export function planCardRows(plan: Plan): PricingRow[] {
  const index = PRICING_PLANS.indexOf(plan);
  const previous = index > 0 ? PRICING_PLANS[index - 1] : null;
  return PRICING_GROUPS.flatMap((group) => group.rows).filter((row) => {
    if (LIMITS_LINE_ROWS.has(row.id)) return false;
    if (!truthy(pricingCell(row, plan))) return false;
    return previous === null || !truthy(pricingCell(row, previous));
  });
}

/** The plan a paid card says "everything in … plus" about. */
export function previousPlan(plan: Plan): Plan | null {
  const index = PRICING_PLANS.indexOf(plan);
  return index > 0 ? PRICING_PLANS[index - 1] : null;
}
