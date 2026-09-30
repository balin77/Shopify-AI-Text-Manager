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

import { BILLING_PLANS } from "./billing";

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

export type PricePlan = {
  /** Key into the copy's per-plan description. */
  id: string;
  /** The provider's own plan name — not translated. */
  name: string;
  /** Monthly price; 0 = free. */
  monthly: number;
};

export type PriceTable = {
  currency: "EUR" | "USD";
  plans: PricePlan[];
};

export const COMPARE_PRICES: Record<PriceAppId, PriceTable> = {
  contentpilot: {
    currency: "EUR",
    plans: [
      { id: "free", name: "Free", monthly: 0 },
      { id: "basic", name: "Basic", monthly: BILLING_PLANS.basic.price },
      { id: "pro", name: "Pro", monthly: BILLING_PLANS.pro.price },
      { id: "max", name: "Max", monthly: BILLING_PLANS.max.price },
    ],
  },
  "translate-and-adapt": {
    currency: "USD",
    plans: [{ id: "free", name: "Free", monthly: 0 }],
  },
  weglot: {
    currency: "USD",
    plans: [
      { id: "free", name: "Free", monthly: 0 },
      { id: "starter", name: "Starter", monthly: 17 },
      { id: "business", name: "Business", monthly: 32 },
      { id: "pro", name: "Pro", monthly: 87 },
    ],
  },
  transcy: {
    currency: "USD",
    plans: [
      { id: "free", name: "Free", monthly: 0 },
      { id: "localPlus", name: "Local Plus", monthly: 14.9 },
      { id: "regional", name: "Regional", monthly: 29 },
      { id: "continental", name: "Continental", monthly: 69 },
    ],
  },
  langshop: {
    currency: "USD",
    plans: [
      { id: "free", name: "Free", monthly: 0 },
      { id: "basic", name: "Basic", monthly: 10 },
      { id: "standard", name: "Standard", monthly: 34 },
      { id: "advanced", name: "Advanced", monthly: 68 },
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
