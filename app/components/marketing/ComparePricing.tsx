import {
  COMPETITOR_NAMES,
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
        : plan.languages === "twoAutomatic"
          ? g.values.twoAutomatic
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
      : v.kind === "onRequest"
        ? g.values.onRequest
        : v.kind === "included"
          ? g.values.included
          : v.kind === "unlimitedWords"
            ? g.values.unlimitedWords
            : (
                {
                  words: g.values.words,
                  tokensMonth: g.values.tokensMonth,
                  tokensMonthOwnKey: g.values.tokensMonthOwnKey,
                  wordsPlusTokens: g.values.wordsPlusTokens,
                  wordsPlusTokensOwnKey: g.values.wordsPlusTokensOwnKey,
                } as const
              )[v.kind].replace("{n}", n(v.amount));
  return { languages, products, volume };
}
