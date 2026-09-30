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

export const COMPETITORS = ["translate-and-adapt", "weglot", "transcy", "langshop"] as const;

export type CompetitorId = (typeof COMPETITORS)[number];

/** Product names are not translated. */
export const COMPETITOR_NAMES: Record<CompetitorId, string> = {
  "translate-and-adapt": "Translate & Adapt",
  weglot: "Weglot",
  transcy: "Transcy",
  langshop: "LangShop",
};

export type Support = "yes" | "partial" | "no" | "unstated";

export type CompareGroupId = "translation" | "content" | "seo" | "media" | "international";

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
  | "currency";

export type CompareRow = {
  id: CompareRowId;
  group: CompareGroupId;
  ours: Support;
  them: Record<CompetitorId, Support>;
};

export const COMPARE_ROWS: CompareRow[] = [
  {
    id: "autoTranslate",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "partial", weglot: "yes", transcy: "yes", langshop: "yes" },
  },
  {
    id: "nativeStorage",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "yes", weglot: "unstated", transcy: "yes", langshop: "yes" },
  },
  {
    id: "brandVoice",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "yes", transcy: "unstated", langshop: "yes" },
  },
  {
    id: "aiProvider",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "partial", langshop: "partial" },
  },
  {
    id: "glossary",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "yes", transcy: "yes", langshop: "yes" },
  },
  {
    id: "themeCheckout",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "yes", weglot: "yes", transcy: "yes", langshop: "yes" },
  },
  {
    id: "thirdPartyApps",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "yes", transcy: "yes", langshop: "yes" },
  },
  {
    id: "followChanges",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "unstated", weglot: "yes", transcy: "yes", langshop: "partial" },
  },
  {
    id: "aiWriting",
    group: "content",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no" },
  },
  {
    id: "bulkEditor",
    group: "content",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no" },
  },
  {
    id: "seoToolkit",
    group: "seo",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no" },
  },
  {
    id: "aiVisibility",
    group: "seo",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no" },
  },
  {
    id: "altText",
    group: "media",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no" },
  },
  {
    id: "imageManager",
    group: "media",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no" },
  },
  {
    id: "imagesPerLanguage",
    group: "international",
    ours: "no",
    them: { "translate-and-adapt": "partial", weglot: "yes", transcy: "yes", langshop: "unstated" },
  },
  {
    id: "currency",
    group: "international",
    ours: "no",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "yes", langshop: "yes" },
  },
];

export function isCompetitorId(value: string | undefined): value is CompetitorId {
  return typeof value === "string" && (COMPETITORS as readonly string[]).includes(value);
}

export function comparePath(competitor: CompetitorId): string {
  return `/compare/${competitor}`;
}
