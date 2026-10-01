import {
  COMPETITOR_NAMES,
  INCLUDED_AI_ENGINES,
  formatCompareNumber,
  formatComparePrice,
  type PriceAppId,
  type PricePlan,
  type PriceTable,
} from "../../config/marketing-compare";
import { MARKETING_SITE } from "../../config/marketing-site";
import type { CompareCopy } from "../../i18n/marketing/compare";
import type { MarketingLocale } from "../../services/marketing-locale.shared";

export function appName(app: PriceAppId): string {
  return app === "contentpilot" ? MARKETING_SITE.appName : COMPETITOR_NAMES[app];
}

/** "Free", "€9.90 / month" or "$1,200 / year" — the unit the provider itself uses. */
export function PlanPrice({
  plan,
  table,
  copy,
  locale,
}: {
  plan: PricePlan;
  table: PriceTable;
  copy: CompareCopy;
  locale: MarketingLocale;
}) {
  if (plan.monthly === 0) return <>{copy.pricing.free}</>;
  if (plan.onRequest) return <>{copy.pricing.onRequest}</>;
  const yearly = plan.monthly === null;
  const amount = yearly ? (plan.yearly ?? 0) : (plan.monthly as number);
  const text = formatComparePrice(amount, plan.currency ?? table.currency, locale).replace(/\d{4,}/, (digits) =>
    formatCompareNumber(Number(digits), locale),
  );
  return (
    <>
      {text}{" "}
      <span className="mk-compare-prices__unit">{yearly ? copy.pricing.perYear : copy.pricing.perMonth}</span>
    </>
  );
}

/** The three limits of a plan as text, in the provider's own unit. */
export function planLimitTexts(plan: PricePlan, copy: CompareCopy, locale: MarketingLocale) {
  const g = copy.glance;
  const n = (value: number) => formatCompareNumber(value, locale);
  const languages =
    plan.languages === "onRequest"
      ? g.values.onRequest
      : plan.languages === "unlimited"
        ? g.values.unlimited
        : plan.languages === "shopifyMax"
          ? g.values.shopifyMax
          : plan.languages === "someAutomatic"
          ? g.values.someAutomatic
          : typeof plan.languages === "object"
            ? g.values.automaticOf
                .replace("{auto}", n(plan.languages.automatic))
                .replace("{total}", n(plan.languages.total))
            : n(plan.languages);
  const products = plan.onRequest
    ? g.values.onRequest
    : plan.products === null
      ? g.values.noProductLimit
      : plan.products === "unstated"
        ? g.values.unstated
        : n(plan.products);
  const v = plan.volume;
  const volume =
    v.kind === "ownKey"
      ? g.values.ownKey
      : v.kind === "manualOnly"
        ? g.values.manualOnly
        : v.kind === "oncePerLanguage"
          ? g.values.oncePerLanguage
          : v.kind === "oncePerLanguageOrOwnKey"
            ? g.values.oncePerLanguageOrOwnKey
            : v.kind === "onRequest"
        ? g.values.onRequest
        : v.kind === "included"
          ? g.values.included
          : v.kind === "unlimitedWords"
            ? g.values.unlimitedWords
            : (
                {
                  words: g.values.words,
                  wordsOnce: g.values.wordsOnce,
                  tokensMonth: g.values.tokensMonth,
                  tokensMonthOwnKey: g.values.tokensMonthOwnKey,
                  wordsPlusTokens: g.values.wordsPlusTokens,
                  wordsPlusTokensOwnKey: g.values.wordsPlusTokensOwnKey,
                } as const
              )[v.kind].replace("{n}", n(v.amount));
  return { languages, products, volume };
}

/**
 * Our plans' second way to pay for the AI, as one line per table row: the
 * "+ AI" price under the price, its volume under ours, its provider under
 * the provider list. Empty for every plan without one (all competitors).
 */
export function includedAiTexts(plan: PricePlan, table: PriceTable, copy: CompareCopy, locale: MarketingLocale) {
  const ai = plan.includedAi;
  const t = copy.glance.includedAi;
  if (!ai) return { price: null, volume: null, engines: null };
  if (ai.kind === "taster") {
    return {
      price: null,
      volume: t.taster.replace("{n}", formatCompareNumber(ai.actions, locale)),
      engines: t.engines.replace("{list}", INCLUDED_AI_ENGINES.join(", ")),
    };
  }
  return {
    price: t.price.replace("{price}", formatComparePrice(ai.monthly, plan.currency ?? table.currency, locale)),
    volume: t.volume[ai.tier],
    engines: t.engines.replace("{list}", INCLUDED_AI_ENGINES.join(", ")),
  };
}
