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
import { PLAN_CONFIG } from "./plans";

export const COMPETITORS = ["translate-and-adapt", "weglot", "transcy", "langshop"] as const;

export type CompetitorId = (typeof COMPETITORS)[number];

/** Product names are not translated. */
export const COMPETITOR_NAMES: Record<CompetitorId, string> = {
  "translate-and-adapt": "Translate & Adapt",
  weglot: "Weglot",
  transcy: "Transcy",
  langshop: "LangShop",
};

/**
 * `higherPlan` is the answer the per-level view needs and "no" must never
 * stand in for: the app CAN do it, only not on the plan being looked at.
 */
export type Support = "yes" | "partial" | "no" | "unstated" | "higherPlan";

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
  /** Whether the app can do it on ANY plan. */
  ours: Support;
  them: Record<CompetitorId, Support>;
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
    byPlan: {
      contentpilot: ["higherPlan", "higherPlan", "yes", "yes"],
      weglot: ["higherPlan", "higherPlan", "higherPlan", "higherPlan", "yes", "yes", "yes"],
    },
  },
  {
    id: "aiProvider",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "yes", langshop: "yes" },
    byPlan: {
      transcy: ["higherPlan", "yes", "yes", "yes", "yes", "yes"],
      langshop: ["higherPlan", "higherPlan", "yes", "yes", "yes", "yes", "yes"],
    },
  },
  {
    id: "glossary",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "yes", transcy: "yes", langshop: "yes" },
    byPlan: {
      transcy: ["higherPlan", "higherPlan", "yes", "yes", "yes", "yes"],
      langshop: ["higherPlan", "yes", "yes", "yes", "yes", "yes", "yes"],
    },
  },
  {
    id: "themeCheckout",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "yes", weglot: "yes", transcy: "yes", langshop: "yes" },
    byPlan: {
      contentpilot: ["higherPlan", "higherPlan", "yes", "yes"],
    },
  },
  {
    id: "thirdPartyApps",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "yes", transcy: "yes", langshop: "yes" },
    byPlan: {
      contentpilot: ["higherPlan", "higherPlan", "higherPlan", "yes"],
      langshop: ["higherPlan", "higherPlan", "yes", "yes", "yes", "yes", "yes"],
    },
  },
  {
    id: "followChanges",
    group: "translation",
    ours: "yes",
    them: { "translate-and-adapt": "unstated", weglot: "yes", transcy: "yes", langshop: "partial" },
    byPlan: {
      contentpilot: ["higherPlan", "higherPlan", "higherPlan", "yes"],
      transcy: ["higherPlan", "higherPlan", "yes", "yes", "yes", "yes"],
      langshop: ["higherPlan", "higherPlan", "partial", "partial", "partial", "partial", "partial"],
    },
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
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "partial" },
    byPlan: {
      contentpilot: ["higherPlan", "yes", "yes", "yes"],
      langshop: ["higherPlan", "partial", "partial", "partial", "partial", "partial", "partial"],
    },
  },
  {
    id: "seoToolkit",
    group: "seo",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no" },
    byPlan: {
      contentpilot: ["partial", "partial", "yes", "yes"],
    },
  },
  {
    id: "aiVisibility",
    group: "seo",
    ours: "yes",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "no", langshop: "no" },
    byPlan: {
      contentpilot: ["partial", "yes", "yes", "yes"],
    },
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
    byPlan: {
      contentpilot: ["higherPlan", "higherPlan", "yes", "yes"],
    },
  },
  {
    id: "imagesPerLanguage",
    group: "international",
    ours: "no",
    them: { "translate-and-adapt": "partial", weglot: "yes", transcy: "yes", langshop: "unstated" },
    byPlan: {
      transcy: ["higherPlan", "higherPlan", "yes", "yes", "yes", "yes"],
    },
  },
  {
    id: "currency",
    group: "international",
    ours: "no",
    them: { "translate-and-adapt": "no", weglot: "no", transcy: "yes", langshop: "yes" },
    byPlan: {
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
export type PlanLanguages = number | "unlimited" | "twoAutomatic" | "onRequest";

/**
 * How much translating a plan buys. Each provider meters something different
 * — words, AI tokens, nothing at all — so this is a tagged value and the copy
 * says it in the provider's own unit rather than converting between units no
 * one can convert between.
 */
export type PlanVolume =
  | { kind: "ownKey" }
  | { kind: "onRequest" }
  | { kind: "included" }
  | { kind: "unlimitedWords" }
  | { kind: "words"; amount: number }
  | { kind: "tokensMonth"; amount: number }
  | { kind: "tokensMonthOwnKey"; amount: number }
  /** Unlimited machine words plus a monthly AI-token allowance (Transcy). */
  | { kind: "wordsPlusTokens"; amount: number }
  | { kind: "wordsPlusTokensOwnKey"; amount: number };

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
  /** Where this plan's price comes from a source in another currency than the table's. */
  currency?: "EUR" | "USD";
  languages: PlanLanguages;
  /** Product limit; `null` = no product limit; "unstated" = the provider's table leaves it blank. */
  products: number | null | "unstated";
  volume: PlanVolume;
};

export type PriceTable = {
  currency: "EUR" | "USD";
  /** Free trial of the PAID plans in days; `null` = the app has no paid plan to try. */
  trialDays: number | null;
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
      { id: "free", name: "Free", monthly: 0, languages: "unlimited", products: PLAN_CONFIG.free.maxProducts, volume: OWN_KEY },
      { id: "basic", name: "Basic", monthly: BILLING_PLANS.basic.price, languages: "unlimited", products: PLAN_CONFIG.basic.maxProducts, volume: OWN_KEY },
      { id: "pro", name: "Pro", monthly: BILLING_PLANS.pro.price, languages: "unlimited", products: PLAN_CONFIG.pro.maxProducts, volume: OWN_KEY },
      { id: "max", name: "Max", monthly: BILLING_PLANS.max.price, languages: "unlimited", products: PLAN_CONFIG.max.maxProducts, volume: OWN_KEY },
    ],
  },
  "translate-and-adapt": {
    currency: "USD",
    trialDays: null,
    plans: [{ id: "free", name: "Free", monthly: 0, languages: "twoAutomatic", products: null, volume: { kind: "included" } }],
  },
  weglot: {
    currency: "USD",
    trialDays: 14,
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: 1, products: null, volume: { kind: "words", amount: 2000 } },
      { id: "starter", name: "Starter", monthly: 17, languages: 1, products: null, volume: { kind: "words", amount: 10000 } },
      { id: "business", name: "Business", monthly: 32, languages: 3, products: null, volume: { kind: "words", amount: 50000 } },
      { id: "pro", name: "Pro", monthly: 87, languages: 5, products: null, volume: { kind: "words", amount: 250000 } },
      // Weglot's own website lists three larger plans the App Store does not,
      // priced in EUROS (owner's screenshot, 2026-09-30). Shown in the currency
      // Weglot states rather than converted.
      { id: "advanced", name: "Advanced", monthly: 299, currency: "EUR", languages: 10, products: null, volume: { kind: "words", amount: 1000000 } },
      { id: "extended", name: "Extended", monthly: 699, currency: "EUR", languages: 20, products: null, volume: { kind: "words", amount: 5000000 } },
      { id: "enterprise", name: "Enterprise", monthly: null, onRequest: true, languages: "onRequest", products: null, volume: { kind: "onRequest" } },
    ],
  },
  transcy: {
    currency: "USD",
    trialDays: 7,
    // Transcy's own plan comparison, as the owner pasted it (2026-09-30).
    plans: [
      { id: "free", name: "Free", monthly: 0, languages: 1, products: "unstated", volume: { kind: "unlimitedWords" } },
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
  const base = app === "contentpilot" ? row.ours : row.them[app];
  const perPlan = row.byPlan?.[app];
  if (!perPlan) return base;
  const plans = COMPARE_PRICES[app].plans;
  return perPlan[Math.min(level, plans.length - 1)] ?? base;
}
