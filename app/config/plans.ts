/**
 * Subscription Plan Configuration
 * Defines limits and features for each plan tier
 */

import { PLAN_WEBP_CONCURRENCY } from "./webp-concurrency.js";

export type Plan = "free" | "basic" | "pro" | "max";

export type ContentType =
  | "products"
  | "collections"
  | "articles"
  | "blogs"
  | "pages"
  | "policies"
  | "templates"
  | "menus"
  | "metaobjects"
  | "directTranslations"
  // Full-translation-coverage rubrics (share the ThemeContent model):
  | "system"             // notifications, payment, packing slips (Pro+)
  | "delivery"           // shipping/delivery method names — checkout-facing (Basic+)
  | "sellingPlans"       // subscription plans (Pro+)
  | "onlineStoreExtras"; // filters + shop metadata + cookie banner (all tiers)

/**
 * SEO-tab entitlements (docs/plans/SEO_TAB_IMPLEMENTATION_PLAN.md §Plan-Matrix).
 *
 * Design rule: **Pro gets the full SEO feature surface, Max buys automation,
 * memory, scale and throughput.** Before this block the highest gate anywhere
 * in the SEO tab was `planGate: "pro"` (crawl, searchConsole, internalLinks,
 * sitemap, indexNow) — so a Max subscription unlocked nothing at all here.
 *
 * Everything below is a real recurring cost on our side (scheduled compute,
 * snapshot storage, Google API calls, queue throughput) — the same axis
 * `monthlyImageOperations` and `dailyPageSpeedRuns` already segment on. AI
 * tokens are merchant-funded (BYO), and locale count is a deliberate USP, so
 * neither is ever a gate.
 *
 * `SeoSectionDef.planGate` (config/seo-sections.ts) decides whether a section
 * is *visible*; the numbers here decide what happens *inside* it. Enforce them
 * server-side in the loader/action/service, never only in the UI.
 */
export interface SeoPlanLimits {
  /**
   * Nightly automatic store audit (SeoAuditAutoRunService) writing a fresh
   * SeoScoreSnapshot. Report-only — it never rewrites merchant content.
   */
  scheduledAudit: boolean;
  /**
   * Weekly automatic storefront crawl (SeoCrawlAutoRunService) writing a fresh
   * SeoCrawlSnapshot. Report-only, like the audit — it never rewrites content.
   * Weekly rather than nightly because a crawl fetches every page of the shop:
   * the cost scales with the catalog, and delivery problems (404s, redirect
   * chains, orphans) do not appear and vanish within a day.
   */
  scheduledCrawl: boolean;
  /**
   * Days of SeoScoreSnapshot / SeoKeywordSnapshot history kept and charted.
   * The newest snapshot always survives, so 0 means "current state, no trend".
   */
  scoreHistoryDays: number;
  /**
   * Distinct tracked SeoKeyword rows per shop (across all locales).
   * 0 = keyword tracking unavailable.
   *
   * Enforced at creation only. Rows already over the cap after a DOWNGRADE are
   * deliberately KEPT and merely frozen (no new keywords until the merchant is
   * back under it) — keywords are merchant-authored research, not re-syncable
   * cache, so planCacheCleanup must never delete them. See §Plan-Matrix.
   */
  maxTrackedKeywords: number;
  /**
   * Connectable Google Search Console properties (market domains). 0 = locked.
   *
   * Capped at 1 on every paid tier TODAY because
   * GoogleSearchConsoleConnection keys on `shop` alone — one property per
   * shop is all the schema can hold. Raising Max to 5 is a follow-up that
   * needs a composite key plus a property picker; until then the Pro→Max GSC
   * difference is `gscHistoryDays`, which is enforced for real.
   */
  gscProperties: number;
  /**
   * GSC lookback window in days. 480 ≈ the 16 months the Search Console API
   * itself retains; 28 is the rolling window smaller shops get.
   */
  gscHistoryDays: number;
  /** Rolling monthly IndexNow submission quota. 0 = IndexNow unavailable. */
  monthlyIndexNowSubmissions: number;
  /** Items per bulk-fix / bulk-meta run (queue throughput, mirrors WebP 2→6). */
  bulkBatchSize: number;
}

export interface PlanLimits {
  maxProducts: number;
  maxLocales: number;
  maxCollections: number;
  maxArticles: number;
  maxPages: number;
  maxThemeTranslations: number;
  maxConcurrentWebpConversions: number;
  /**
   * Rolling monthly cap on billable image operations (Bulk-Upload + WebP
   * conversion). Our real variable cost is image compute/bandwidth, not AI
   * (tokens are merchant-funded BYO). 0 = feature not available on this tier
   * (Free/Basic have no image manager anyway). Enforced lazily at the upload/
   * convert routes via app/utils/imageOperations.server.ts — it is usage data,
   * NOT entitlement data, so it deliberately stays out of getSyncScope /
   * planCacheCleanup. See docs/ROADMAP.md §Limit-Review Befund 3.
   */
  monthlyImageOperations: number;
  /**
   * Real PageSpeed Insights runs per UTC day (SEO → Ladezeit, and the planned
   * accessibility scan, which draws on the same budget).
   *
   * Same reasoning as monthlyImageOperations: PSI is billed against OUR
   * PAGESPEED_API_KEY and the quota is shared across every shop, unlike AI
   * tokens which are merchant-funded (BYO) and therefore uncapped. So this is
   * usage data, NOT entitlement data — the section itself is deliberately
   * ungated on every tier, only the volume is tiered. Cached results (30 min
   * TTL) never count; only runs that actually reach Google do.
   *
   * Enforced in services/seo/pagespeed.service.ts via countPageSpeedRunsToday.
   */
  dailyPageSpeedRuns: number;
  /** SEO-tab entitlements — see SeoPlanLimits above. */
  seo: SeoPlanLimits;
  productImages: "featured-only" | "all";
  contentTypes: ContentType[];
  aiInstructionsEditable: boolean;
  variantImageManager: boolean;
  cacheEnabled: {
    products: boolean;
    productImages: boolean;
    productOptions: boolean;
    productMetafields: boolean;
    collections: boolean;
    articles: boolean;
    pages: boolean;
    policies: boolean;
    themes: boolean;
  };
}

export const PLAN_CONFIG: Record<Plan, PlanLimits> = {
  free: {
    maxProducts: 50,
    // Locales are intentionally uncapped on every tier: AI tokens are
    // merchant-funded (BYO key), so extra languages cost us nothing. Language
    // generosity is a deliberate USP — segmentation happens via product count
    // and content breadth, not locale count. (Decision: 2026-05, ROADMAP §Limit-Review.)
    maxLocales: Infinity,
    maxCollections: 5,
    maxArticles: 0,
    maxPages: 0,
    maxThemeTranslations: 0,
    maxConcurrentWebpConversions: PLAN_WEBP_CONCURRENCY.free,
    monthlyImageOperations: 0,
    dailyPageSpeedRuns: 5,
    // SEO: the diagnostic sections (audit, structured data, hreflang,
    // redirects, PageSpeed) stay open — a shop that cannot see its own SEO
    // problems has no reason to upgrade. Everything with a recurring cost is
    // off here.
    seo: {
      scheduledAudit: false,
      scheduledCrawl: false,
      scoreHistoryDays: 0,
      maxTrackedKeywords: 0,
      gscProperties: 0,
      gscHistoryDays: 0,
      monthlyIndexNowSubmissions: 0,
      bulkBatchSize: 25,
    },
    productImages: "featured-only",
    contentTypes: ["products", "collections", "onlineStoreExtras"],
    aiInstructionsEditable: false,
    // Image processing suite (VariantImageManager, WebP conversion, bulk
    // upload, bulk alt-text) is Pro+ only — monthlyImageOperations is 0
    // here anyway, so without this flag the merchant saw the UI but every
    // action hit a quota error. Free/basic shoppers see Shopify's native
    // product gallery, unchanged.
    variantImageManager: false,
    cacheEnabled: {
      products: true, // limited to 50
      productImages: false, // only featured image
      productOptions: false,
      productMetafields: false,
      collections: true,
      articles: false,
      pages: false,
      policies: false,
      themes: false,
    },
  },
  basic: {
    maxProducts: 100,
    maxLocales: Infinity,
    maxCollections: 50,
    maxArticles: 0,
    maxPages: 20,
    maxThemeTranslations: 0,
    maxConcurrentWebpConversions: PLAN_WEBP_CONCURRENCY.basic,
    monthlyImageOperations: 0,
    dailyPageSpeedRuns: 20,
    // SEO: first tier with keyword tracking — a small quota, because every
    // tracked keyword turns into GSC enrichment calls once a shop connects
    // Search Console on Pro.
    seo: {
      scheduledAudit: false,
      scheduledCrawl: false,
      scoreHistoryDays: 0,
      maxTrackedKeywords: 25,
      gscProperties: 0,
      gscHistoryDays: 0,
      monthlyIndexNowSubmissions: 0,
      bulkBatchSize: 100,
    },
    productImages: "all",
    contentTypes: ["products", "collections", "pages", "policies", "delivery", "onlineStoreExtras"],
    aiInstructionsEditable: false,
    // Same Pro+ gate as free — see comment on free.variantImageManager above.
    variantImageManager: false,
    cacheEnabled: {
      products: true,
      productImages: true,
      productOptions: true,
      productMetafields: true,
      collections: true,
      articles: false,
      pages: true,
      policies: true,
      themes: false,
    },
  },
  pro: {
    maxProducts: 500,
    maxLocales: Infinity,
    maxCollections: 100,
    maxArticles: 100,
    maxPages: 50,
    maxThemeTranslations: 50000,
    maxConcurrentWebpConversions: PLAN_WEBP_CONCURRENCY.pro,
    monthlyImageOperations: 2000,
    dailyPageSpeedRuns: 40,
    // SEO: the complete feature surface — Search Console, crawl, internal
    // links, sitemap and IndexNow all unlock here, so Pro is never a crippled
    // tier. What it does not get is automation, long history, multi-property
    // and Max throughput.
    seo: {
      scheduledAudit: false,
      scheduledCrawl: false,
      scoreHistoryDays: 30,
      maxTrackedKeywords: 100,
      gscProperties: 1,
      gscHistoryDays: 28,
      monthlyIndexNowSubmissions: 5000,
      bulkBatchSize: 500,
    },
    productImages: "all",
    contentTypes: ["products", "collections", "articles", "blogs", "pages", "policies", "templates", "menus", "metaobjects", "system", "delivery", "sellingPlans", "onlineStoreExtras"],
    aiInstructionsEditable: true,
    variantImageManager: true,
    cacheEnabled: {
      products: true,
      productImages: true,
      productOptions: true,
      productMetafields: true,
      collections: true,
      articles: true,
      pages: true,
      policies: true,
      themes: true,
    },
  },
  max: {
    maxProducts: 2500,
    maxLocales: Infinity,
    maxCollections: 500,
    maxArticles: 300,
    maxPages: 200,
    maxThemeTranslations: 100000,
    maxConcurrentWebpConversions: PLAN_WEBP_CONCURRENCY.max,
    monthlyImageOperations: 10000,
    dailyPageSpeedRuns: 80,
    // SEO: the Pro→Max differentiators — it runs by itself (nightly audit),
    // it remembers (12 months of history), it scales across markets (5 GSC
    // properties, 16-month window) and it moves bulk work faster.
    seo: {
      scheduledAudit: true,
      scheduledCrawl: true,
      scoreHistoryDays: 365,
      maxTrackedKeywords: 1000,
      gscProperties: 1, // see SeoPlanLimits.gscProperties — multi-property is a follow-up
      gscHistoryDays: 480,
      monthlyIndexNowSubmissions: 50000,
      bulkBatchSize: 2500,
    },
    productImages: "all",
    contentTypes: ["products", "collections", "articles", "blogs", "pages", "policies", "templates", "menus", "metaobjects", "directTranslations", "system", "delivery", "sellingPlans", "onlineStoreExtras"],
    aiInstructionsEditable: true,
    variantImageManager: true,
    cacheEnabled: {
      products: true,
      productImages: true,
      productOptions: true,
      productMetafields: true,
      collections: true,
      articles: true,
      pages: true,
      policies: true,
      themes: true,
    },
  },
};

export const PLAN_DISPLAY_NAMES: Record<Plan, string> = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  max: "Max",
};

