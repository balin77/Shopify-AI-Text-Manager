/**
 * The comparison pages of the public website (`/compare`, `/compare/<app>`):
 * which apps are compared, which rows the table has, and what each app
 * answers per row. The WORDS live in `i18n/marketing/compare/`; this file
 * holds only the facts, so the three languages cannot disagree about them.
 *
 * Every answer is taken from the provider's own public App Store listing and
 * help pages (the month is `checkedAt` in the copy — update it whenever a fact here moves) and restated in
 * docs/reference/COMPETITIVE_ANALYSIS.md §2.1 with its sources. Two rules:
 *
 *  - "unstated" is not "no". Where a provider does not say whether it can do
 *    something, the page says exactly that. Claiming a gap we have not seen is
 *    the fastest way to lose a visitor who knows the other app.
 *  - Our own gaps are rows too (currency conversion, images per language).
 *    A comparison that only lists rows we win reads as an advert, and an
 *    honest one is the reason this page is worth ranking for.
 */

import { BILLING_PLANS, MANAGED_BILLING_PLANS } from "./billing";
import { MANAGED_AI_TASTER_ACTIONS } from "./managed-ai-budget";
import { PLAN_CONFIG } from "./plans";

/** Translation apps — the first topic, and the one the page opened with. */
export const TRANSLATION_COMPETITORS = [
  "translate-and-adapt",
  "weglot",
  "transcy",
  "langshop",
  "t-lab",
  "langify",
  "gtranslate",
] as const;

/** SEO apps — the five largest by reviews, checked 2026-10-01 (COMPETITIVE_ANALYSIS.md §2.2). */
export const SEO_COMPETITORS = ["avada-seo", "storeseo", "seowill", "tinyseo", "booster"] as const;

/** AI content apps — the five largest by reviews, checked 2026-10-01 (§2.3). */
export const AI_CONTENT_COMPETITORS = ["avada-blog", "profitonium", "tapita", "essential-blog", "storeya"] as const;

/** Variant image apps, checked 2026-10-01 (§2.4). */
export const VARIANT_IMAGE_COMPETITORS = [
  "rubik",
  "sa-variant-images",
  "op-color-swatch",
  "variant-image-wizard",
  "gg-image-slider",
] as const;

export const COMPETITORS = [
  ...TRANSLATION_COMPETITORS,
  ...SEO_COMPETITORS,
  ...AI_CONTENT_COMPETITORS,
  ...VARIANT_IMAGE_COMPETITORS,
] as const;

export type CompetitorId = (typeof COMPETITORS)[number];

export type TranslationCompetitorId = (typeof TRANSLATION_COMPETITORS)[number];

/** Product names are not translated. */
export const COMPETITOR_NAMES: Record<CompetitorId, string> = {
  "translate-and-adapt": "Translate & Adapt",
  weglot: "Weglot",
  transcy: "Transcy",
  langshop: "LangShop",
  "t-lab": "T Lab",
  langify: "Langify",
  gtranslate: "GTranslate",
  "avada-seo": "Avada AI SEO",
  storeseo: "StoreSEO",
  seowill: "SEOWILL",
  tinyseo: "TinySEO",
  booster: "Booster SEO",
  "avada-blog": "Avada Blog",
  profitonium: "Profitonium",
  tapita: "Tapita AI Blog",
  "essential-blog": "Essential AI Blog",
  storeya: "StoreYa AI Description",
  rubik: "Rubik Variant Images",
  "sa-variant-images": "SA Variant Image Automator",
  "op-color-swatch": "OP Color Swatch",
  "variant-image-wizard": "Variant Image Wizard",
  "gg-image-slider": "GG Image Slider",
};

/**
 * `higherPlan` is the answer the per-level view needs and "no" must never
 * stand in for: the app CAN do it, only not on the plan being looked at.
 */
export type Support = "yes" | "partial" | "no" | "unstated" | "higherPlan";

export type CompareGroupId =
  | "translation"
  | "content"
  | "seo"
  | "media"
  | "international"
  // SEO topic
  | "seoBasics"
  | "seoTechnical"
  | "seoSearch"
  | "aiSearch"
  // AI content topic
  | "aiEngine"
  | "aiTexts"
  | "aiWorkflow"
  // Variant images topic
  | "gallery"
  | "assignment"
  | "swatches"
  | "imageExtras";

export const COMPARE_GROUPS: CompareGroupId[] = ["translation", "content", "seo", "media", "international"];

export type CompareRowId =
  | "autoTranslate"
  | "nativeStorage"
  | "brandVoice"
  | "aiProvider"
  | "glossary"
  | "themeCheckout"
  | "thirdPartyApps"
  | "followChanges"
  | "aiWriting"
  | "bulkEditor"
  | "seoToolkit"
  | "aiVisibility"
  | "altText"
  | "imageManager"
  | "imagesPerLanguage"
  | "currency"
  // SEO topic
  | "metaAi"
  | "structuredData"
  | "storeAudit"
  | "seoPerLanguage"
  | "siteCrawl"
  | "brokenLinks"
  | "redirects"
  | "internalLinks"
  | "sitemapControl"
  | "pageSpeed"
  | "speedOptimization"
  | "imageCompression"
  | "searchConsole"
  | "keywordTracking"
  | "keywordVolume"
  | "indexNow"
  | "localSeo"
  | "aiDiscoveryFiles"
  | "aiCrawlers"
  | "aiReferral"
  | "catalogReadiness"
  // AI content topic
  | "ownKey"
  | "includedAi"
  | "productDescriptions"
  | "blogArticles"
  | "imageToText"
  | "aiImages"
  | "marketingTexts"
  | "bulkGeneration"
  | "createWithAi"
  | "translateGenerated"
  // Variant images topic
  | "multiImagePerVariant"
  | "variantFilter"
  | "noLayoutShift"
  | "zoomLightbox"
  | "videoAnd3d"
  | "autoAssign"
  | "keyGenerator"
  | "dragDrop"
  | "bulkUpload"
  | "swatchesProduct"
  | "swatchesCollection"
  | "combinedListings"
  | "altTranslation";

export type CompareRow = {
  id: CompareRowId;
  group: CompareGroupId;
  /** Whether the app can do it on ANY plan. */
  ours: Support;
  /** Only the apps of the row's own topic; an app missing here reads "unstated". */
  them: Partial<Record<CompetitorId, Support>>;
  /**
   * Per plan, in the order of `COMPARE_PRICES[app].plans`, where the answer
   * depends on the plan. An app not listed here answers the same on every
   * plan. Every provider is described the same way, ours included: naming
   * only our own plan limits made the others look all-inclusive.
   */
  byPlan?: Partial<Record<PriceAppId, Support[]>>;
};

export const COMPARE_ROWS: CompareRow[] = [
  {
    id: "autoTranslate",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "partial", weglot: "yes", transcy: "yes", langshop: "yes", "t-lab": "yes", langify: "yes", gtranslate: "yes" },
    byPlan: {
      langify: ["higherPlan", "yes", "yes", "yes"],
    },
  },
  {
    id: "nativeStorage",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "yes", weglot: "no", transcy: "yes", langshop: "yes", "t-lab": "partial", langify: "partial", gtranslate: "no" },
    // Transcy's free plan translates in the visitor's browser (google.translate.js,
    // "non-edit languages"); only the paid plans write into Shopify.
    byPlan: {
      transcy: ["higherPlan", "yes", "yes", "yes", "yes", "yes"],
    },
  },
  {
    id: "brandVoice",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "yes", transcy: "yes", langshop: "yes", "t-lab": "partial", langify: "partial", gtranslate: "unstated" },
    byPlan: {
      langify: ["higherPlan", "partial", "partial", "partial"],
      "t-lab": ["partial", "partial", "partial", "yes"],
      transcy: ["higherPlan", "yes", "yes", "yes", "yes", "yes"],
      contentpilot: ["higherPlan", "higherPlan", "yes", "yes"],
      weglot: ["higherPlan", "higherPlan", "higherPlan", "higherPlan", "yes", "yes", "yes"],
    },
  },
  {
    id: "aiProvider",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "yes", langshop: "yes", "t-lab": "yes", langify: "partial", gtranslate: "unstated" },
    byPlan: {
      langify: ["higherPlan", "higherPlan", "partial", "partial"],
      "t-lab": ["higherPlan", "higherPlan", "higherPlan", "yes"],
      transcy: ["higherPlan", "yes", "yes", "yes", "yes", "yes"],
      langshop: ["higherPlan", "higherPlan", "yes", "yes", "yes", "yes", "yes"],
    },
  },
  {
    id: "glossary",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "yes", transcy: "yes", langshop: "yes", "t-lab": "yes", langify: "yes", gtranslate: "partial" },
    byPlan: {
      langify: ["higherPlan", "yes", "yes", "yes"],
      transcy: ["higherPlan", "higherPlan", "yes", "yes", "yes", "yes"],
      langshop: ["higherPlan", "yes", "yes", "yes", "yes", "yes", "yes"],
    },
  },
  {
    id: "themeCheckout",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "yes", weglot: "yes", transcy: "yes", langshop: "yes", "t-lab": "partial", langify: "yes", gtranslate: "partial" },
    byPlan: {
      contentpilot: ["higherPlan", "higherPlan", "yes", "yes"],
    },
  },
  {
    id: "thirdPartyApps",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "yes", transcy: "yes", langshop: "yes", "t-lab": "yes", langify: "yes", gtranslate: "yes" },
    byPlan: {
      gtranslate: ["higherPlan", "yes", "yes", "yes", "yes"],
      langify: ["higherPlan", "yes", "yes", "yes"],
      contentpilot: ["higherPlan", "higherPlan", "higherPlan", "yes"],
      langshop: ["higherPlan", "higherPlan", "yes", "yes", "yes", "yes", "yes"],
    },
  },
  {
    id: "followChanges",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "partial", weglot: "yes", transcy: "yes", langshop: "partial", "t-lab": "partial", langify: "partial", gtranslate: "partial" },
    byPlan: {
      langify: ["higherPlan", "higherPlan", "partial", "partial"],
      "t-lab": ["partial", "partial", "partial", "yes"],
      contentpilot: ["higherPlan", "higherPlan", "higherPlan", "yes"],
      transcy: ["higherPlan", "higherPlan", "yes", "yes", "yes", "yes"],
      langshop: ["higherPlan", "higherPlan", "partial", "partial", "partial", "partial", "partial"],
    },
  },
  {
    id: "aiWriting",
    group: "content",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no", "t-lab": "unstated", langify: "unstated", gtranslate: "unstated" },
  },
  {
    id: "bulkEditor",
    group: "content",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "partial", "t-lab": "unstated", langify: "unstated", gtranslate: "unstated" },
    byPlan: {
      contentpilot: ["higherPlan", "yes", "yes", "yes"],
      langshop: ["higherPlan", "partial", "partial", "partial", "partial", "partial", "partial"],
    },
  },
  {
    id: "seoToolkit",
    group: "seo",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no", "t-lab": "unstated", langify: "partial", gtranslate: "partial" },
    byPlan: {
      gtranslate: ["higherPlan", "partial", "partial", "partial", "partial"],
      contentpilot: ["partial", "partial", "yes", "yes"],
    },
  },
  {
    id: "aiVisibility",
    group: "seo",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no", "t-lab": "unstated", langify: "unstated", gtranslate: "partial" },
    byPlan: {
      gtranslate: ["higherPlan", "partial", "partial", "partial", "partial"],
      contentpilot: ["partial", "yes", "yes", "yes"],
    },
  },
  {
    id: "altText",
    group: "media",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no", "t-lab": "unstated", langify: "unstated", gtranslate: "unstated" },
  },
  {
    id: "imageManager",
    group: "media",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no", "t-lab": "unstated", langify: "unstated", gtranslate: "unstated" },
    byPlan: {
      contentpilot: ["higherPlan", "higherPlan", "yes", "yes"],
    },
  },
  {
    id: "imagesPerLanguage",
    group: "international",
    ours: "no",
    them: { "translate-and-adapt": "partial", weglot: "yes", transcy: "yes", langshop: "unstated", "t-lab": "yes", langify: "yes", gtranslate: "unstated" },
    byPlan: {
      langify: ["higherPlan", "yes", "yes", "yes"],
      transcy: ["higherPlan", "higherPlan", "yes", "yes", "yes", "yes"],
    },
  },
  {
    id: "currency",
    group: "international",
    ours: "no",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "yes", langshop: "yes", "t-lab": "yes", langify: "no", gtranslate: "unstated" },
    byPlan: {
      "t-lab": ["higherPlan", "higherPlan", "yes", "yes"],
      transcy: ["higherPlan", "yes", "yes", "yes", "yes", "yes"],
    },
  },
];

export function isCompetitorId(value: string | undefined): value is CompetitorId {
  return typeof value === "string" && (COMPETITORS as readonly string[]).includes(value);
}

export function comparePath(competitor: CompetitorId): string {
  return `/compare/${competitor}`;
}

// ── The other topics ─────────────────────────────────────────────────────
//
// Each topic compares ContentPilot against a DIFFERENT kind of app with its
// own rows: an SEO app answered on translation rows would read "no" almost
// everywhere, which is true and tells a visitor nothing. Our column is the
// same plan ladder in every topic, which is the point the page makes — one
// plan covers all four.
//
// Competitor answers: docs/reference/COMPETITIVE_ANALYSIS.md §2.2–2.4 and the
// evidence files in docs/reference/competitive-research/ (2026-10-01). Where a
// store listing and the provider's own pages disagree, the answer more
// favourable to the competitor is taken — understating another app is the
// one error this page may not make — and the cell's note says so where it
// matters.

const H = "higherPlan" as const;
/** Pro and up — the variant image manager, crawl, Search Console, IndexNow … */
const FROM_PRO: Support[] = [H, H, "yes", "yes"];
/** Basic and up — keywords, the AI-search section. */
const FROM_BASIC: Support[] = [H, "yes", "yes", "yes"];
/** Free covers the featured image only, Basic and up every product image. */
const FEATURED_ONLY_ON_FREE: Support[] = ["partial", "yes", "yes", "yes"];

export const SEO_GROUPS: CompareGroupId[] = ["seoBasics", "seoTechnical", "seoSearch", "aiSearch"];

export const SEO_ROWS: CompareRow[] = [
  {
    id: "metaAi",
    group: "seoBasics",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "yes", seowill: "partial", tinyseo: "yes", booster: "yes" },
    byPlan: { seowill: [H, "partial", "partial"] },
  },
  {
    id: "bulkEditor",
    group: "seoBasics",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "yes", seowill: "yes", tinyseo: "partial", booster: "partial" },
    byPlan: { seowill: ["partial", "yes", "yes"], tinyseo: [H, H, "partial", "partial"] },
  },
  {
    id: "altText",
    group: "seoBasics",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "yes", seowill: "partial", tinyseo: "unstated", booster: "yes" },
    byPlan: { contentpilot: FEATURED_ONLY_ON_FREE },
  },
  {
    id: "structuredData",
    group: "seoBasics",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "yes", seowill: "yes", tinyseo: "yes", booster: "yes" },
    byPlan: { storeseo: ["partial", "yes", "yes", "yes", "yes"], seowill: [H, "yes", "yes"], tinyseo: ["partial", "yes", "yes", "yes"], booster: [H, "yes", "yes", "yes"] },
  },
  {
    id: "storeAudit",
    group: "seoBasics",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "yes", seowill: "yes", tinyseo: "yes", booster: "yes" },
  },
  {
    id: "seoPerLanguage",
    group: "seoBasics",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "yes", seowill: "partial", tinyseo: "unstated", booster: "unstated" },
    byPlan: { "avada-seo": [H, "yes", "yes"], storeseo: [H, H, H, "yes", "yes"] },
  },
  {
    id: "siteCrawl",
    group: "seoTechnical",
    ours: "yes",
    them: { "avada-seo": "partial", storeseo: "unstated", seowill: "partial", tinyseo: "partial", booster: "partial" },
    byPlan: { contentpilot: FROM_PRO },
  },
  {
    id: "brokenLinks",
    group: "seoTechnical",
    ours: "yes",
    them: { "avada-seo": "partial", storeseo: "partial", seowill: "partial", tinyseo: "partial", booster: "partial" },
    byPlan: { contentpilot: FROM_PRO, tinyseo: [H, H, "partial", "partial"] },
  },
  {
    id: "redirects",
    group: "seoTechnical",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "partial", seowill: "yes", tinyseo: "yes", booster: "yes" },
    byPlan: { seowill: [H, "yes", "yes"], tinyseo: [H, H, "yes", "yes"], booster: [H, "yes", "yes", "yes"] },
  },
  {
    id: "internalLinks",
    group: "seoTechnical",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "unstated", seowill: "yes", tinyseo: "partial", booster: "unstated" },
    byPlan: { contentpilot: FROM_PRO, "avada-seo": [H, "yes", "yes"], seowill: [H, H, "yes"] },
  },
  {
    id: "sitemapControl",
    group: "seoTechnical",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "yes", seowill: "partial", tinyseo: "yes", booster: "partial" },
    byPlan: { contentpilot: FROM_PRO, "avada-seo": ["partial", "yes", "yes"], tinyseo: [H, H, "yes", "yes"], booster: [H, "partial", "partial", "partial"] },
  },
  {
    id: "pageSpeed",
    group: "seoTechnical",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "unstated", seowill: "yes", tinyseo: "unstated", booster: "partial" },
  },
  {
    id: "speedOptimization",
    group: "seoTechnical",
    ours: "no",
    them: { "avada-seo": "yes", storeseo: "unstated", seowill: "yes", tinyseo: "yes", booster: "no" },
    byPlan: { tinyseo: [H, "yes", "yes", "yes"] },
  },
  {
    id: "imageCompression",
    group: "seoTechnical",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "yes", seowill: "yes", tinyseo: "yes", booster: "yes" },
    byPlan: { contentpilot: FROM_PRO, booster: [H, H, "yes", "yes"] },
  },
  {
    id: "searchConsole",
    group: "seoSearch",
    ours: "yes",
    them: { "avada-seo": "yes", storeseo: "yes", seowill: "yes", tinyseo: "yes", booster: "yes" },
    byPlan: { contentpilot: FROM_PRO, storeseo: [H, "yes", "yes", "yes", "yes"], seowill: [H, "yes", "yes"], booster: [H, H, "yes", "yes"] },
  },
  {
    id: "keywordTracking",
    group: "seoSearch",
    ours: "yes",
    them: { "avada-seo": "partial", storeseo: "yes", seowill: "yes", tinyseo: "yes", booster: "partial" },
    byPlan: { contentpilot: FROM_BASIC, seowill: [H, "yes", "yes"], tinyseo: [H, H, H, "yes"] },
  },
  {
    id: "keywordVolume",
    group: "seoSearch",
    ours: "no",
    them: { "avada-seo": "yes", storeseo: "yes", seowill: "yes", tinyseo: "partial", booster: "unstated" },
  },
  {
    id: "indexNow",
    group: "seoSearch",
    ours: "yes",
    them: { "avada-seo": "partial", storeseo: "partial", seowill: "partial", tinyseo: "yes", booster: "unstated" },
    byPlan: { contentpilot: FROM_PRO, "avada-seo": [H, "partial", "partial"], storeseo: [H, "partial", "partial", "partial", "partial"], seowill: [H, "partial", "partial"], tinyseo: [H, H, "yes", "yes"] },
  },
  {
    id: "localSeo",
    group: "seoSearch",
    ours: "no",
    them: { "avada-seo": "partial", storeseo: "partial", seowill: "yes", tinyseo: "unstated", booster: "partial" },
    byPlan: { storeseo: [H, "partial", "partial", "partial", "partial"], seowill: [H, "partial", "yes"], booster: [H, H, "partial", "partial"] },
  },
  {
    id: "aiDiscoveryFiles",
    group: "aiSearch",
    ours: "yes",
    them: { "avada-seo": "unstated", storeseo: "yes", seowill: "partial", tinyseo: "yes", booster: "partial" },
    byPlan: { contentpilot: FROM_BASIC, seowill: [H, "partial", "partial"], tinyseo: [H, H, "yes", "yes"] },
  },
  {
    id: "aiCrawlers",
    group: "aiSearch",
    ours: "yes",
    them: { "avada-seo": "partial", storeseo: "unstated", seowill: "unstated", tinyseo: "unstated", booster: "unstated" },
    byPlan: { contentpilot: FROM_BASIC, "avada-seo": [H, "partial", "partial"] },
  },
  {
    id: "aiReferral",
    group: "aiSearch",
    ours: "yes",
    them: { "avada-seo": "unstated", storeseo: "yes", seowill: "unstated", tinyseo: "unstated", booster: "unstated" },
    byPlan: { contentpilot: FROM_BASIC, storeseo: [H, "yes", "yes", "yes", "yes"] },
  },
  {
    id: "catalogReadiness",
    group: "aiSearch",
    ours: "yes",
    them: { "avada-seo": "unstated", storeseo: "partial", seowill: "unstated", tinyseo: "unstated", booster: "unstated" },
    byPlan: { contentpilot: FROM_BASIC },
  },
];

export const AI_CONTENT_GROUPS: CompareGroupId[] = ["aiEngine", "aiTexts", "aiWorkflow"];

export const AI_CONTENT_ROWS: CompareRow[] = [
  {
    id: "aiProvider",
    group: "aiEngine",
    ours: "yes",
    them: { "avada-blog": "partial", profitonium: "yes", tapita: "unstated", "essential-blog": "unstated", storeya: "unstated" },
  },
  {
    id: "ownKey",
    group: "aiEngine",
    ours: "yes",
    them: { "avada-blog": "unstated", profitonium: "unstated", tapita: "unstated", "essential-blog": "unstated", storeya: "unstated" },
  },
  {
    id: "includedAi",
    group: "aiEngine",
    ours: "yes",
    them: { "avada-blog": "yes", profitonium: "yes", tapita: "yes", "essential-blog": "yes", storeya: "yes" },
    byPlan: { contentpilot: ["partial", "yes", "yes", "yes"] },
  },
  {
    id: "brandVoice",
    group: "aiEngine",
    ours: "yes",
    them: { "avada-blog": "yes", profitonium: "yes", tapita: "yes", "essential-blog": "partial", storeya: "partial" },
    byPlan: { contentpilot: FROM_PRO, profitonium: [H, "yes", "yes", "yes", "yes"] },
  },
  {
    id: "productDescriptions",
    group: "aiTexts",
    ours: "yes",
    them: { "avada-blog": "unstated", profitonium: "yes", tapita: "unstated", "essential-blog": "no", storeya: "yes" },
  },
  {
    id: "metaAi",
    group: "aiTexts",
    ours: "yes",
    them: { "avada-blog": "partial", profitonium: "yes", tapita: "partial", "essential-blog": "unstated", storeya: "yes" },
    byPlan: { "avada-blog": [H, "partial", "partial"], profitonium: [H, "yes", "yes", "yes", "yes"], storeya: [H, "yes", "yes", "yes"] },
  },
  {
    id: "altText",
    group: "aiTexts",
    ours: "yes",
    them: { "avada-blog": "unstated", profitonium: "yes", tapita: "unstated", "essential-blog": "unstated", storeya: "unstated" },
    byPlan: { contentpilot: FEATURED_ONLY_ON_FREE },
  },
  {
    id: "blogArticles",
    group: "aiTexts",
    ours: "partial",
    them: { "avada-blog": "yes", profitonium: "unstated", tapita: "yes", "essential-blog": "yes", storeya: "yes" },
    byPlan: { contentpilot: [H, H, "partial", "partial"] },
  },
  {
    id: "imageToText",
    group: "aiTexts",
    ours: "yes",
    them: { "avada-blog": "unstated", profitonium: "yes", tapita: "unstated", "essential-blog": "unstated", storeya: "unstated" },
  },
  {
    id: "aiImages",
    group: "aiTexts",
    ours: "no",
    them: { "avada-blog": "yes", profitonium: "unstated", tapita: "yes", "essential-blog": "yes", storeya: "partial" },
    byPlan: { storeya: [H, "partial", "partial", "partial"] },
  },
  {
    id: "marketingTexts",
    group: "aiTexts",
    ours: "no",
    them: { "avada-blog": "unstated", profitonium: "unstated", tapita: "unstated", "essential-blog": "unstated", storeya: "partial" },
    byPlan: { storeya: [H, "partial", "partial", "partial"] },
  },
  {
    id: "bulkGeneration",
    group: "aiWorkflow",
    ours: "yes",
    them: { "avada-blog": "partial", profitonium: "yes", tapita: "yes", "essential-blog": "yes", storeya: "yes" },
    byPlan: { "avada-blog": [H, "partial", "partial"], profitonium: [H, "yes", "yes", "yes", "yes"], tapita: [H, "yes"], "essential-blog": [H, "yes", "yes", "yes"], storeya: [H, "yes", "yes", "yes"] },
  },
  {
    id: "createWithAi",
    group: "aiWorkflow",
    ours: "yes",
    them: { "avada-blog": "unstated", profitonium: "unstated", tapita: "unstated", "essential-blog": "no", storeya: "unstated" },
  },
  {
    id: "translateGenerated",
    group: "aiWorkflow",
    ours: "yes",
    them: { "avada-blog": "yes", profitonium: "partial", tapita: "yes", "essential-blog": "partial", storeya: "partial" },
    byPlan: { "avada-blog": [H, "yes", "yes"], profitonium: [H, "partial", "partial", "partial", "partial"], tapita: [H, "yes"] },
  },
];

export const VARIANT_IMAGE_GROUPS: CompareGroupId[] = ["gallery", "assignment", "swatches", "imageExtras"];

export const VARIANT_IMAGE_ROWS: CompareRow[] = [
  {
    id: "multiImagePerVariant",
    group: "gallery",
    ours: "yes",
    them: { rubik: "yes", "sa-variant-images": "yes", "op-color-swatch": "yes", "variant-image-wizard": "yes", "gg-image-slider": "yes" },
    byPlan: { contentpilot: FROM_PRO, "gg-image-slider": [H, "yes"] },
  },
  {
    id: "variantFilter",
    group: "gallery",
    ours: "yes",
    them: { rubik: "yes", "sa-variant-images": "yes", "op-color-swatch": "yes", "variant-image-wizard": "yes", "gg-image-slider": "yes" },
    byPlan: { contentpilot: FROM_PRO, "gg-image-slider": [H, "yes"] },
  },
  {
    id: "noLayoutShift",
    group: "gallery",
    ours: "yes",
    them: { rubik: "partial", "sa-variant-images": "partial", "op-color-swatch": "no", "variant-image-wizard": "unstated", "gg-image-slider": "partial" },
    byPlan: { contentpilot: FROM_PRO },
  },
  {
    id: "zoomLightbox",
    group: "gallery",
    ours: "yes",
    them: { rubik: "partial", "sa-variant-images": "partial", "op-color-swatch": "unstated", "variant-image-wizard": "yes", "gg-image-slider": "yes" },
    byPlan: { contentpilot: FROM_PRO, "gg-image-slider": [H, "yes"] },
  },
  {
    id: "videoAnd3d",
    group: "gallery",
    ours: "yes",
    them: { rubik: "yes", "sa-variant-images": "yes", "op-color-swatch": "unstated", "variant-image-wizard": "yes", "gg-image-slider": "yes" },
    byPlan: { contentpilot: FROM_PRO, "variant-image-wizard": [H, H, "yes"], "gg-image-slider": [H, "yes"] },
  },
  {
    id: "autoAssign",
    group: "assignment",
    ours: "yes",
    them: { rubik: "yes", "sa-variant-images": "partial", "op-color-swatch": "partial", "variant-image-wizard": "partial", "gg-image-slider": "partial" },
    byPlan: { contentpilot: FROM_PRO, "gg-image-slider": [H, "partial"] },
  },
  {
    id: "keyGenerator",
    group: "assignment",
    ours: "yes",
    them: { rubik: "unstated", "sa-variant-images": "unstated", "op-color-swatch": "unstated", "variant-image-wizard": "unstated", "gg-image-slider": "unstated" },
    byPlan: { contentpilot: FROM_PRO },
  },
  {
    id: "dragDrop",
    group: "assignment",
    ours: "yes",
    them: { rubik: "yes", "sa-variant-images": "yes", "op-color-swatch": "unstated", "variant-image-wizard": "yes", "gg-image-slider": "no" },
    byPlan: { contentpilot: FROM_PRO },
  },
  {
    id: "bulkUpload",
    group: "assignment",
    ours: "yes",
    them: { rubik: "no", "sa-variant-images": "unstated", "op-color-swatch": "unstated", "variant-image-wizard": "partial", "gg-image-slider": "no" },
    byPlan: { contentpilot: FROM_PRO },
  },
  {
    id: "swatchesProduct",
    group: "swatches",
    ours: "no",
    them: { rubik: "yes", "sa-variant-images": "no", "op-color-swatch": "yes", "variant-image-wizard": "yes", "gg-image-slider": "unstated" },
  },
  {
    id: "swatchesCollection",
    group: "swatches",
    ours: "no",
    them: { rubik: "yes", "sa-variant-images": "no", "op-color-swatch": "yes", "variant-image-wizard": "unstated", "gg-image-slider": "unstated" },
  },
  {
    id: "combinedListings",
    group: "swatches",
    ours: "no",
    them: { rubik: "no", "sa-variant-images": "no", "op-color-swatch": "partial", "variant-image-wizard": "partial", "gg-image-slider": "unstated" },
    byPlan: { "variant-image-wizard": [H, H, "partial"] },
  },
  {
    id: "imageCompression",
    group: "imageExtras",
    ours: "yes",
    them: { rubik: "unstated", "sa-variant-images": "no", "op-color-swatch": "unstated", "variant-image-wizard": "unstated", "gg-image-slider": "partial" },
    byPlan: { contentpilot: FROM_PRO },
  },
  {
    id: "altText",
    group: "imageExtras",
    ours: "yes",
    them: { rubik: "unstated", "sa-variant-images": "no", "op-color-swatch": "unstated", "variant-image-wizard": "unstated", "gg-image-slider": "unstated" },
    byPlan: { contentpilot: FEATURED_ONLY_ON_FREE },
  },
  {
    id: "altTranslation",
    group: "imageExtras",
    ours: "yes",
    them: { rubik: "unstated", "sa-variant-images": "unstated", "op-color-swatch": "unstated", "variant-image-wizard": "unstated", "gg-image-slider": "unstated" },
  },
];

export type CompareTopicId = "translation" | "seo" | "aiContent" | "variantImages";

export const COMPARE_TOPIC_ORDER: CompareTopicId[] = ["translation", "seo", "aiContent", "variantImages"];

export type PlanRowId = "languages" | "products" | "volume";

export type CompareTopic = {
  id: CompareTopicId;
  /** URL segment under /compare; `null` = /compare itself. */
  slug: string | null;
  competitors: readonly CompetitorId[];
  /** Columns the table opens with; the rest sit behind its `+`. */
  initial: readonly CompetitorId[];
  groups: CompareGroupId[];
  rows: CompareRow[];
  /** Which plan limits the "Plan" block lists; languages and translation volume mean nothing for an SEO app. */
  planRows: readonly PlanRowId[];
  /** The "AI providers" plan row — only where engines are what is compared. */
  showEngines: boolean;
  /**
   * Live on the public site. An unpublished topic answers 404 in production
   * and is a noindex preview elsewhere (`?preview`), so provisional facts can
   * be looked at without being published.
   */
  published: boolean;
};

export const COMPARE_TOPICS: Record<CompareTopicId, CompareTopic> = {
  translation: {
    id: "translation",
    slug: null,
    competitors: TRANSLATION_COMPETITORS,
    initial: ["translate-and-adapt", "weglot", "transcy", "langshop"],
    groups: COMPARE_GROUPS,
    rows: COMPARE_ROWS,
    planRows: ["languages", "products", "volume"],
    showEngines: true,
    published: true,
  },
  seo: {
    id: "seo",
    slug: "seo",
    competitors: SEO_COMPETITORS,
    initial: ["avada-seo", "storeseo", "seowill", "booster"],
    groups: SEO_GROUPS,
    rows: SEO_ROWS,
    planRows: ["products", "volume"],
    showEngines: false,
    published: true,
  },
  aiContent: {
    id: "aiContent",
    slug: "ai-content",
    competitors: AI_CONTENT_COMPETITORS,
    initial: ["avada-blog", "profitonium", "tapita", "storeya"],
    groups: AI_CONTENT_GROUPS,
    rows: AI_CONTENT_ROWS,
    planRows: ["volume"],
    showEngines: true,
    published: true,
  },
  variantImages: {
    id: "variantImages",
    slug: "variant-images",
    competitors: VARIANT_IMAGE_COMPETITORS,
    initial: ["rubik", "sa-variant-images", "op-color-swatch", "variant-image-wizard"],
    groups: VARIANT_IMAGE_GROUPS,
    rows: VARIANT_IMAGE_ROWS,
    planRows: ["products"],
    showEngines: false,
    published: true,
  },
};

export function topicPath(topic: CompareTopicId): string {
  const slug = COMPARE_TOPICS[topic].slug;
  return slug ? `/compare/${slug}` : "/compare";
}

export function topicBySlug(slug: string | undefined): CompareTopicId | null {
  return COMPARE_TOPIC_ORDER.find((id) => slug !== undefined && COMPARE_TOPICS[id].slug === slug) ?? null;
}

export function topicOfCompetitor(competitor: CompetitorId): CompareTopicId {
  return COMPARE_TOPIC_ORDER.find((id) => COMPARE_TOPICS[id].competitors.includes(competitor)) ?? "translation";
}

/** Topics a visitor can reach: the published ones, plus every one in a preview. */
export function visibleTopics(preview: boolean): CompareTopicId[] {
  return COMPARE_TOPIC_ORDER.filter((id) => preview || COMPARE_TOPICS[id].published);
}

/** Competitors with a live `/compare/<app>` page — the sitemap and llms.txt list these. */
export const LIVE_COMPETITORS: CompetitorId[] = COMPETITORS.filter(
  (id) => COMPARE_TOPICS[topicOfCompetitor(id)].published,
);

/**
 * The price comparison: every app's plans as its provider lists them — a
 * name, a monthly price in the provider's own currency, and nothing else.
 * What each plan INCLUDES is copy (`pricing.plans` in the compare bundle),
 * because it has to be said in three languages; the numbers live here so the
 * three cannot disagree.
 *
 * Ours are read off `BILLING_PLANS`, the table Shopify actually charges from,
 * so the page cannot advertise a price the app does not bill. When the
 * AI-included variant reaches `develop`, it becomes a second price on the same
 * rows (`withAi`), not four more plans — the same "second axis" the billing
 * config itself uses.
 */
export type PriceAppId = "contentpilot" | CompetitorId;

export const PRICE_APPS: PriceAppId[] = ["contentpilot", ...COMPETITORS];

/** How many languages a plan translates. */
export type PlanLanguages =
  | number
  | "unlimited"
  /** Ours: every language the shop has — the ceiling is Shopify's, not the plan's. */
  | "shopifyMax"
  | "someAutomatic"
  | "onRequest"
  /** Some languages translated by AI, more addable by hand (T Lab). */
  | { automatic: number; total: number };

/**
 * How much translating a plan buys. Each provider meters something different
 * — words, AI tokens, nothing at all — so this is a tagged value and the copy
 * says it in the provider's own unit rather than converting between units no
 * one can convert between.
 */
export type PlanVolume =
  | { kind: "ownKey" }
  /** No machine translation in the plan at all (Langify Free). */
  | { kind: "manualOnly" }
  /** T Lab: a one-time allowance per language, counted in products, not per month. */
  | { kind: "oncePerLanguage" }
  | { kind: "oncePerLanguageOrOwnKey" }
  /** Langify: words credited once at sign-up, not per month. */
  | { kind: "wordsOnce"; amount: number }
  | { kind: "onRequest" }
  | { kind: "included" }
  | { kind: "unlimitedWords" }
  | { kind: "words"; amount: number }
  | { kind: "tokensMonth"; amount: number }
  | { kind: "tokensMonthOwnKey"; amount: number }
  /** Unlimited machine words plus a monthly AI-token allowance (Transcy). */
  | { kind: "wordsPlusTokens"; amount: number }
  | { kind: "wordsPlusTokensOwnKey"; amount: number }
  // AI quotas of the SEO and AI content apps, in the provider's own unit.
  | { kind: "credits"; amount: number }
  | { kind: "creditsMonth"; amount: number }
  | { kind: "creditsOnce"; amount: number }
  | { kind: "tokensOnce"; amount: number }
  | { kind: "postsMonth"; amount: number }
  | { kind: "descriptionsManual"; amount: number }
  | { kind: "aiUpToProducts"; amount: number }
  | { kind: "unlimitedAi" };

export type PricePlan = {
  /** Key into the copy's per-plan description. */
  id: string;
  /** The provider's own plan name — not translated. */
  name: string;
  /** Monthly price; 0 = free; `null` = the provider only lists a yearly price. */
  monthly: number | null;
  /** Yearly price, only where the provider lists no monthly one. */
  yearly?: number;
  /** No published price at all ("contact us"). */
  onRequest?: true;
  /**
   * The price follows the merchant's SHOPIFY plan, not the features: one plan
   * row with the cheapest and the dearest monthly price (`monthly` is null).
   */
  monthlyRange?: [number, number];
  /** Who may use this plan at all, where the provider limits it. */
  restriction?: "devStoresOnly" | "freeThemesOnly";
  /** Where this plan's price comes from a source in another currency than the table's. */
  currency?: "EUR" | "USD";
  languages: PlanLanguages;
  /** Product limit; `null` = no product limit; "unstated" = the provider's table leaves it blank. */
  products: number | null | "unstated";
  volume: PlanVolume;
  /**
   * Ours only: the SECOND way to pay for the AI — a key of ours instead of
   * the merchant's. Free carries the one-time taster, each paid plan its
   * "+ AI" variant, read off `MANAGED_BILLING_PLANS` like the prices above.
   */
  includedAi?: IncludedAi;
};

export type IncludedAi =
  | { kind: "taster"; actions: number }
  | { kind: "plan"; monthly: number; tier: "basic" | "pro" | "max" };

/** The provider the included AI runs on — the default the Settings consent names. */
export const INCLUDED_AI_ENGINES = ["OpenAI"];

export type PriceTable = {
  /**
   * Plans not researched yet: the table shows "being checked" in every plan
   * row instead of a guessed price. Only an unpublished topic may carry one
   * (a test pins that).
   */
  pending?: true;
  currency: "EUR" | "USD";
  /** Free trial of the PAID plans in days; `null` = no paid plan to try; "unstated" = not published. */
  trialDays: number | null | "unstated";
  plans: PricePlan[];
};

/** Ours: no AI volume in the plan at all — the merchant's own key pays the provider directly. */
const OWN_KEY: PlanVolume = { kind: "ownKey" };

/** Rows of the price table: every app's plans lined up by position, free first. */
export function priceLevelCount(apps: readonly PriceAppId[]): number {
  return Math.max(...apps.map((app) => COMPARE_PRICES[app].plans.length));
}

export const COMPARE_PRICES: Record<PriceAppId, PriceTable> = {
  contentpilot: {
    currency: "EUR",
    trialDays: BILLING_PLANS.basic.trialDays ?? null,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "shopifyMax", products: PLAN_CONFIG.free.maxProducts, volume: OWN_KEY, includedAi: { kind: "taster", actions: MANAGED_AI_TASTER_ACTIONS } },
      { id: "basic", name: "Basic", monthly: BILLING_PLANS.basic.price, languages: "shopifyMax", products: PLAN_CONFIG.basic.maxProducts, volume: OWN_KEY, includedAi: { kind: "plan", monthly: MANAGED_BILLING_PLANS.basic.price, tier: "basic" } },
      { id: "pro", name: "Pro", monthly: BILLING_PLANS.pro.price, languages: "shopifyMax", products: PLAN_CONFIG.pro.maxProducts, volume: OWN_KEY, includedAi: { kind: "plan", monthly: MANAGED_BILLING_PLANS.pro.price, tier: "pro" } },
      { id: "max", name: "Max", monthly: BILLING_PLANS.max.price, languages: "shopifyMax", products: PLAN_CONFIG.max.maxProducts, volume: OWN_KEY, includedAi: { kind: "plan", monthly: MANAGED_BILLING_PLANS.max.price, tier: "max" } },
    ],
  },
  "translate-and-adapt": {
    currency: "USD",
    trialDays: null,
    // Two automatic languages: what the App Store listing and the app itself
    // offer (owner, 2026-09-30). Shopify's help page says "up to 8"; the app
    // is what a merchant gets, so it wins.
    plans: [{ id: "free", name: "Free", monthly: 0, languages: "someAutomatic", products: null, volume: { kind: "included" } }],
  },
  weglot: {
    currency: "USD",
    trialDays: 14,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: 1, products: null, volume: { kind: "words", amount: 2000 } },
      { id: "starter", name: "Starter", monthly: 17, languages: 1, products: null, volume: { kind: "words", amount: 10000 } },
      { id: "business", name: "Business", monthly: 32, languages: 3, products: null, volume: { kind: "words", amount: 50000 } },
      { id: "pro", name: "Pro", monthly: 87, languages: 5, products: null, volume: { kind: "words", amount: 200000 } },
      // Weglot's own website lists three larger plans the App Store does not.
      // USD as the website states it (it bills in EUR, "USD pricing is an
      // estimate"); verified against the website 2026-09-30.
      { id: "advanced", name: "Advanced", monthly: 329, languages: 10, products: null, volume: { kind: "words", amount: 1000000 } },
      { id: "extended", name: "Extended", monthly: 769, languages: 20, products: null, volume: { kind: "words", amount: 5000000 } },
      { id: "enterprise", name: "Enterprise", monthly: null, onRequest: true, languages: "onRequest", products: null, volume: { kind: "onRequest" } },
    ],
  },
  transcy: {
    currency: "USD",
    trialDays: 7,
    // Transcy's own plan comparison, as the owner pasted it (2026-09-30).
    plans: [
      // Free: products left blank in Transcy's table; the owner reads it as
      // "nothing can be translated on the free plan" (2026-09-30).
      { id: "free", name: "Free", monthly: 0, languages: 1, products: 0, volume: { kind: "unlimitedWords" } },
      { id: "localPlus", name: "Local Plus", monthly: 14.9, languages: 1, products: 100, volume: { kind: "wordsPlusTokens", amount: 150 } },
      { id: "regional", name: "Regional", monthly: 29, languages: 3, products: 200, volume: { kind: "wordsPlusTokens", amount: 300 } },
      { id: "continental", name: "Continental", monthly: 69, languages: 15, products: 300, volume: { kind: "wordsPlusTokensOwnKey", amount: 500 } },
      { id: "crossBorder", name: "Cross-Border", monthly: 99, languages: 50, products: 1500, volume: { kind: "wordsPlusTokensOwnKey", amount: 1000 } },
      { id: "global", name: "Global", monthly: 599, languages: 147, products: null, volume: { kind: "wordsPlusTokensOwnKey", amount: 5000 } },
    ],
  },
  langshop: {
    currency: "USD",
    trialDays: 14,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: 1, products: 50, volume: { kind: "unlimitedWords" } },
      { id: "basic", name: "Basic", monthly: 10, languages: 1, products: 250, volume: { kind: "unlimitedWords" } },
      { id: "standard", name: "Standard", monthly: 40, languages: 3, products: 2000, volume: { kind: "unlimitedWords" } },
      { id: "advanced", name: "Advanced", monthly: 75, languages: 5, products: 5000, volume: { kind: "unlimitedWords" } },
      // LangShop's own plan comparison, as the owner pasted it (2026-09-30).
      { id: "pro", name: "Pro", monthly: 120, languages: 10, products: 10000, volume: { kind: "unlimitedWords" } },
      { id: "enterprise", name: "Enterprise", monthly: 250, languages: 20, products: 50000, volume: { kind: "unlimitedWords" } },
      { id: "unlimited", name: "Unlimited", monthly: 500, languages: 20, products: null, volume: { kind: "unlimitedWords" } },
    ],
  },
  // T Lab – AI Language Translate (Sherpas Design), App Store listing and its
  // help centre (checked 2026-09-30). Any number of languages by hand, N of
  // them by AI. The AI limit counts products (plus collections, articles and
  // pages) and is ONE-TIME per language — "lifetime, they do not reset
  // monthly". Premium: 15,000 products, unlimited with the merchant's own key.
  "t-lab": {
    currency: "USD",
    trialDays: "unstated",
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: { automatic: 1, total: 20 }, products: 500, volume: { kind: "oncePerLanguage" } },
      { id: "pro", name: "Pro", monthly: 11.99, languages: { automatic: 5, total: 20 }, products: 3000, volume: { kind: "oncePerLanguage" } },
      { id: "business", name: "Business", monthly: 29.99, languages: { automatic: 10, total: 20 }, products: 7000, volume: { kind: "oncePerLanguage" } },
      { id: "premium", name: "Premium", monthly: 59.99, languages: 20, products: 15000, volume: { kind: "oncePerLanguageOrOwnKey" } },
    ],
  },
  // Langify, its pricing page and help centre (checked 2026-09-30). Free is
  // manual only; the paid plans credit their machine-translation words ONCE
  // at sign-up, more only as word packs. "There is no limit on the amount of
  // text you can translate on any plan" — no product limit. No trial.
  langify: {
    currency: "USD",
    trialDays: "unstated",
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: 5, products: null, volume: { kind: "manualOnly" } },
      { id: "basic", name: "Basic", monthly: 17.5, languages: 20, products: null, volume: { kind: "wordsOnce", amount: 10000 } },
      { id: "growth", name: "Growth", monthly: 29.95, languages: 20, products: null, volume: { kind: "wordsOnce", amount: 50000 } },
      { id: "premium", name: "Premium", monthly: 59.95, languages: 20, products: null, volume: { kind: "wordsOnce", amount: 200000 } },
    ],
  },
  // GTranslate, its own plan table (2026-09-30). Free is a language widget
  // that translates in the visitor's browser (not indexed, not editable, no
  // commercial use); the paid plans serve translated pages from GTranslate's
  // "Translation Delivery Network". "All languages" is up to 103 per its help
  // centre. "Bilingual Startup" is one extra language;
  // Enterprise is listed only on gtranslate.io. 15-day trial.
  gtranslate: {
    currency: "USD",
    trialDays: 15,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: 103, products: "unstated", volume: { kind: "unlimitedWords" } },
      { id: "bilingual", name: "Bilingual Startup", monthly: 12, languages: 1, products: "unstated", volume: { kind: "unlimitedWords" } },
      { id: "startup", name: "Startup", monthly: 25, languages: 103, products: "unstated", volume: { kind: "unlimitedWords" } },
      { id: "business", name: "Business", monthly: 35, languages: 103, products: "unstated", volume: { kind: "unlimitedWords" } },
      { id: "enterprise", name: "Enterprise", monthly: 50, languages: 103, products: "unstated", volume: { kind: "unlimitedWords" } },
    ],
  },
  // ── SEO, AI content, variant images: checked 2026-10-01 against store
  //    listings, pricing pages and help centres (docs/reference/competitive-research/).
  "avada-seo": {
    currency: "USD",
    trialDays: 7,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: "unstated", volume: { kind: "creditsOnce", amount: 100 } },
      { id: "pro", name: "Pro", monthly: 34.95, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 1000 } },
      { id: "enterprise", name: "Enterprise", monthly: 99, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 10000 } },
    ],
  },
  storeseo: {
    currency: "USD",
    trialDays: 7,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: 25, volume: { kind: "credits", amount: 200 } },
      { id: "lite", name: "Lite", monthly: 14.99, languages: "onRequest", products: 100, volume: { kind: "credits", amount: 1000 } },
      { id: "essential", name: "Essential", monthly: 39.99, languages: "onRequest", products: 250, volume: { kind: "credits", amount: 5000 } },
      { id: "growth", name: "Growth", monthly: 99.99, languages: "onRequest", products: 1000, volume: { kind: "credits", amount: 12500 } },
      { id: "advanced", name: "Advanced", monthly: 249.99, languages: "onRequest", products: 10000, volume: { kind: "credits", amount: 50000 } },
    ],
  },
  seowill: {
    currency: "USD",
    trialDays: 7,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: "unstated", volume: { kind: "credits", amount: 30 } },
      { id: "pro", name: "Pro", monthly: 29.99, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 200 } },
      { id: "premium", name: "Premium", monthly: 59.99, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 500 } },
    ],
  },
  tinyseo: {
    currency: "USD",
    trialDays: "unstated",
    plans: [
      { id: "payg", name: "Pay as you go", monthly: 0, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 10 } },
      { id: "beginner", name: "Beginner", monthly: 14, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 100 } },
      { id: "advanced", name: "Advanced", monthly: 23, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 300 } },
      { id: "expert", name: "Expert", monthly: 49, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 1000 } },
    ],
  },
  booster: {
    currency: "USD",
    trialDays: 14,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: "unstated", volume: { kind: "aiUpToProducts", amount: 250 } },
      { id: "pro", name: "Pro", monthly: 39, languages: "onRequest", products: "unstated", volume: { kind: "unlimitedAi" } },
      { id: "premium", name: "Premium", monthly: 69, languages: "onRequest", products: "unstated", volume: { kind: "unlimitedAi" } },
      { id: "concierge", name: "Concierge", monthly: 199, languages: "onRequest", products: "unstated", volume: { kind: "unlimitedAi" } },
    ],
  },
  "avada-blog": {
    currency: "USD",
    trialDays: 7,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: "unstated", volume: { kind: "tokensOnce", amount: 200000 } },
      { id: "pro", name: "Pro", monthly: 14.9, languages: "onRequest", products: "unstated", volume: { kind: "tokensMonth", amount: 1000000 } },
      { id: "bundle", name: "All-in-one bundle", monthly: 49, languages: "onRequest", products: "unstated", volume: { kind: "tokensMonth", amount: 1000000 } },
    ],
  },
  profitonium: {
    currency: "USD",
    trialDays: "unstated",
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 100 } },
      { id: "basic", name: "Basic", monthly: 19, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 2000 } },
      { id: "standard", name: "Standard", monthly: 49, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 11000 } },
      { id: "catalog", name: "Catalog", monthly: 129, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 40000 } },
      { id: "pro", name: "Pro", monthly: 249, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 110000 } },
    ],
  },
  tapita: {
    currency: "USD",
    trialDays: "unstated",
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: "unstated", volume: { kind: "creditsOnce", amount: 50 } },
      { id: "pro", name: "Pro", monthly: null, monthlyRange: [9.99, 69.99], languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 250 } },
    ],
  },
  "essential-blog": {
    currency: "USD",
    trialDays: "unstated",
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: "unstated", volume: { kind: "postsMonth", amount: 3 } },
      { id: "starter", name: "Starter", monthly: 9.99, languages: "onRequest", products: "unstated", volume: { kind: "postsMonth", amount: 30 } },
      { id: "essential", name: "Essential", monthly: 29.99, languages: "onRequest", products: "unstated", volume: { kind: "postsMonth", amount: 100 } },
      { id: "professional", name: "Professional", monthly: 99.99, languages: "onRequest", products: "unstated", volume: { kind: "postsMonth", amount: 300 } },
    ],
  },
  storeya: {
    currency: "USD",
    trialDays: "unstated",
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: "unstated", volume: { kind: "descriptionsManual", amount: 120 } },
      { id: "starter", name: "Starter", monthly: 15, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 2500 } },
      { id: "pro", name: "Pro", monthly: 30, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 12000 } },
      { id: "elite", name: "Elite", monthly: 100, languages: "onRequest", products: "unstated", volume: { kind: "creditsMonth", amount: 120000 } },
    ],
  },
  rubik: {
    currency: "USD",
    trialDays: 7,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: 1, volume: { kind: "onRequest" } },
      { id: "starter", name: "Starter", monthly: 25, languages: "onRequest", products: 100, volume: { kind: "onRequest" } },
      { id: "advanced", name: "Advanced", monthly: 50, languages: "onRequest", products: 1000, volume: { kind: "onRequest" } },
      { id: "premium", name: "Premium", monthly: 75, languages: "onRequest", products: null, volume: { kind: "onRequest" } },
    ],
  },
  "sa-variant-images": {
    currency: "USD",
    trialDays: 30,
    plans: [
      { id: "free", name: "Free", monthly: 0, restriction: "devStoresOnly", languages: "onRequest", products: null, volume: { kind: "onRequest" } },
      { id: "paid", name: "", monthly: null, monthlyRange: [5, 99.9], languages: "onRequest", products: null, volume: { kind: "onRequest" } },
    ],
  },
  "op-color-swatch": {
    currency: "USD",
    trialDays: 30,
    plans: [
      { id: "free", name: "Free", monthly: 0, restriction: "devStoresOnly", languages: "onRequest", products: null, volume: { kind: "onRequest" } },
      { id: "paid", name: "", monthly: null, monthlyRange: [11.9, 99.9], languages: "onRequest", products: null, volume: { kind: "onRequest" } },
    ],
  },
  "variant-image-wizard": {
    currency: "USD",
    trialDays: 14,
    plans: [
      { id: "free", name: "Free", monthly: 0, restriction: "freeThemesOnly", languages: "onRequest", products: 5, volume: { kind: "onRequest" } },
      { id: "starter", name: "Starter", monthly: 4.99, restriction: "freeThemesOnly", languages: "onRequest", products: null, volume: { kind: "onRequest" } },
      { id: "pro", name: "Pro", monthly: 7.99, languages: "onRequest", products: null, volume: { kind: "onRequest" } },
    ],
  },
  "gg-image-slider": {
    currency: "USD",
    trialDays: 7,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: "onRequest", products: null, volume: { kind: "onRequest" } },
      { id: "paid", name: "", monthly: null, monthlyRange: [5.99, 17.99], languages: "onRequest", products: null, volume: { kind: "onRequest" } },
    ],
  },
};

/**
 * A price as text, WITHOUT Intl: this renders on the server and the client,
 * and a number formatter is exactly what the hydration rules keep out of the
 * first render. English writes the symbol first ("€9.90", "$17"), German and
 * Spanish after the number with a decimal comma ("9,90 €", "17 US$").
 */
export function formatComparePrice(amount: number, currency: "EUR" | "USD", locale: "en" | "de" | "es"): string {
  const fixed = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  if (locale === "en") return `${currency === "EUR" ? "€" : "$"}${fixed}`;
  const symbol = currency === "EUR" ? "€" : "US$";
  return `${fixed.replace(".", ",")} ${symbol}`;
}

/** "10,000" / "10.000" without Intl, for the same reason as the price. */
export function formatCompareNumber(amount: number, locale: "en" | "de" | "es"): string {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, locale === "en" ? "," : ".");
}

/**
 * The answer for one app on ONE plan. A level past the app's own ladder reads
 * its HIGHEST plan: "what does this app offer at most" is the fair answer when
 * the other apps have more plans, and the table says so in the header.
 */
export function supportAtLevel(row: CompareRow, app: PriceAppId, level: number): Support {
  const base = app === "contentpilot" ? row.ours : (row.them[app] ?? "unstated");
  const perPlan = row.byPlan?.[app];
  if (!perPlan) return base;
  const plans = COMPARE_PRICES[app].plans;
  return perPlan[Math.min(level, plans.length - 1)] ?? base;
}

/**
 * Which AI or translation engines a plan translates with — the question
 * behind "choice of AI provider", answered per plan. Provider names are
 * proper nouns and stay here; the words around them are copy.
 */
export type PlanEngines =
  /** Only through the merchant's own key (ours). */
  | { kind: "ownKey"; names: string[] }
  /** Engines the app offers, optionally more through an own key. */
  | { kind: "list"; names: string[]; ownKey?: string[] }
  /** Shopify's built-in machine translation. */
  | { kind: "shopify" }
  /** The provider's own AI; the engine cannot be chosen. */
  | { kind: "vendor" }
  /** Machine translation whose engine the provider does not name. */
  | { kind: "unstated" }
  /** No machine translation in this plan. */
  | { kind: "manual" };

const OUR_ENGINES: PlanEngines = {
  kind: "ownKey",
  names: ["Claude", "OpenAI", "Gemini", "Grok", "DeepSeek", "Hugging Face"],
};
const TRANSCY_AI = ["OpenAI", "Gemini", "Baidu", "Yandex", "Grok", "DeepSeek"];
const TRANSCY_OWN_KEY = ["OpenAI", "Gemini", "DeepL"];
const LANGSHOP_AI = ["OpenAI", "DeepL Pro", "Google Cloud"];

/** Per plan, in the order of `COMPARE_PRICES[app].plans` (a test pins the lengths). */
/**
 * Only apps whose ENGINES are compared (translation and AI content topics).
 * An app missing here shows "not stated" in the engine row.
 */
export const COMPARE_ENGINES: Partial<Record<PriceAppId, PlanEngines[]>> = {
  contentpilot: [OUR_ENGINES, OUR_ENGINES, OUR_ENGINES, OUR_ENGINES],
  "translate-and-adapt": [{ kind: "shopify" }],
  // Weglot sells "AI translation" with its own "AI Language Model" on every
  // plan and names no engine a merchant could pick.
  weglot: Array.from({ length: 7 }, (): PlanEngines => ({ kind: "vendor" })),
  // Transcy's plan comparison: "Free Engine: Google" on every plan, the LLMs
  // from Local Plus, own API keys from Continental.
  transcy: [
    { kind: "list", names: ["Google"] },
    { kind: "list", names: ["Google", ...TRANSCY_AI] },
    { kind: "list", names: ["Google", ...TRANSCY_AI] },
    { kind: "list", names: ["Google", ...TRANSCY_AI], ownKey: TRANSCY_OWN_KEY },
    { kind: "list", names: ["Google", ...TRANSCY_AI], ownKey: TRANSCY_OWN_KEY },
    { kind: "list", names: ["Google", ...TRANSCY_AI], ownKey: TRANSCY_OWN_KEY },
  ],
  // LangShop: "OpenAI, DeepL Pro, Google Cloud integrations" from Standard;
  // below that it translates by machine without naming the engine.
  langshop: [
    { kind: "unstated" },
    { kind: "unstated" },
    { kind: "list", names: LANGSHOP_AI },
    { kind: "list", names: LANGSHOP_AI },
    { kind: "list", names: LANGSHOP_AI },
    { kind: "list", names: LANGSHOP_AI },
    { kind: "list", names: LANGSHOP_AI },
  ],
  // T Lab: a standard engine "based on OpenAI ChatGPT" on every plan; Premium
  // adds the merchant's own key (help centre; the App Store names fewer).
  "t-lab": [
    { kind: "list", names: ["OpenAI"] },
    { kind: "list", names: ["OpenAI"] },
    { kind: "list", names: ["OpenAI"] },
    { kind: "list", names: ["OpenAI"], ownKey: ["OpenAI", "Anthropic", "DeepL", "DeepSeek", "Google Translate"] },
  ],
  // Langify: DeepL, Google for languages DeepL lacks; an AI beta (DeepSeek,
  // Gemma) from Growth.
  langify: [
    { kind: "manual" },
    { kind: "list", names: ["DeepL", "Google"] },
    { kind: "list", names: ["DeepL", "Google", "DeepSeek (Beta)", "Gemma (Beta)"] },
    { kind: "list", names: ["DeepL", "Google", "DeepSeek (Beta)", "Gemma (Beta)"] },
  ],
  // AI content apps (2026-10-01). Profitonium names GPT, Claude and Gemini for
  // every plan ("more model choices" from Standard); Essential and StoreYa list
  // only OpenAI models under "Works with"; Avada's model choice is unclear since
  // its May 2026 engine change, Tapita names none.
  "avada-blog": [{ kind: "unstated" }, { kind: "unstated" }, { kind: "unstated" }],
  profitonium: Array.from({ length: 5 }, (): PlanEngines => ({ kind: "list", names: ["OpenAI", "Anthropic", "Google Gemini"] })),
  tapita: [{ kind: "unstated" }, { kind: "unstated" }],
  "essential-blog": Array.from({ length: 4 }, (): PlanEngines => ({ kind: "list", names: ["OpenAI"] })),
  storeya: Array.from({ length: 4 }, (): PlanEngines => ({ kind: "list", names: ["OpenAI"] })),
  // GTranslate: "Machine translation" on Free, "AI translation" from Custom,
  // no engine named on either.
  gtranslate: [
    { kind: "unstated" },
    { kind: "vendor" },
    { kind: "vendor" },
    { kind: "vendor" },
    { kind: "vendor" },
  ],
};
