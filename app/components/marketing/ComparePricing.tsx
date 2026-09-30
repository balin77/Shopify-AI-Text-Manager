import {
  COMPARE_PRICES,
  COMPETITOR_NAMES,
  formatCompareNumber,
  formatComparePrice,
  priceLevelCount,
  type PriceAppId,
  type PricePlan,
  type PriceTable,
} from "../../config/marketing-compare";
import { MARKETING_SITE } from "../../config/marketing-site";
import type { CompareCopy } from "../../i18n/marketing/compare";
import type { MarketingLocale } from "../../services/marketing-locale.shared";

function appName(app: PriceAppId): string {
  return app === "contentpilot" ? MARKETING_SITE.appName : COMPETITOR_NAMES[app];
}

/** "Free", "€9.90 / month" or "$1,200 / year" — the unit the provider itself uses. */
function PlanPrice({
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

/**
 * The price table at the TOP of both pages: one column per app, one row per
 * plan level (free first), and each cell names the plan, its price, and the
 * three limits a merchant actually compares — languages, products, and how
 * much translating is included. The free trial is its own row. Every app is
 * measured on the same rows, ours included: our limit is products, and it is
 * shown as plainly as the others' word and language limits.
 */
export function ComparePriceTable({
  copy,
  locale,
  apps,
}: {
  copy: CompareCopy;
  locale: MarketingLocale;
  apps: readonly PriceAppId[];
}) {
  const g = copy.glance;
  const n = (value: number) => formatCompareNumber(value, locale);
  const levels = Array.from({ length: priceLevelCount(apps) }, (_, i) =>
    i === 0 ? g.freeLevel : g.level.replace("{n}", String(i)),
  );

  const languages = (plan: PricePlan) =>
    plan.languages === "onRequest"
      ? g.values.onRequest
      : plan.languages === "unlimited"
      ? g.values.unlimited
      : plan.languages === "twoAutomatic"
        ? g.values.twoAutomatic
        : n(plan.languages);

  const volume = (plan: PricePlan) => {
    const v = plan.volume;
    switch (v.kind) {
      case "ownKey":
        return g.values.ownKey;
      case "onRequest":
        return g.values.onRequest;
      case "included":
        return g.values.included;
      case "unlimitedWords":
        return g.values.unlimitedWords;
      case "words":
        return g.values.words.replace("{n}", n(v.amount));
      case "tokensMonth":
        return g.values.tokensMonth.replace("{n}", n(v.amount));
      case "tokensMonthOwnKey":
        return g.values.tokensMonthOwnKey.replace("{n}", n(v.amount));
      case "wordsPlusTokens":
        return g.values.wordsPlusTokens.replace("{n}", n(v.amount));
      case "wordsPlusTokensOwnKey":
        return g.values.wordsPlusTokensOwnKey.replace("{n}", n(v.amount));
    }
  };

  return (
    <section className="mk-compare-glance" aria-labelledby="compare-glance-heading">
      <h2 id="compare-glance-heading" className="mk-compare__heading">
        {g.heading}
      </h2>
      <p className="mk-compare-prices__intro">{g.intro}</p>
      <div className="mk-compare-table__scroll" tabIndex={0} role="region" aria-labelledby="compare-glance-heading">
        <table
          className={`mk-compare-table mk-compare-glance__table${apps.length <= 2 ? " mk-compare-table--single" : ""}`}
        >
          <thead>
            <tr>
              <th scope="col">{g.planColumn}</th>
              {apps.map((app) => (
                <th scope="col" key={app} className={app === "contentpilot" ? "mk-compare-table__ours" : undefined}>
                  {appName(app)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {levels.map((label, level) => (
              <tr key={label}>
                <th scope="row">
                  <span className="mk-compare-table__label">{label}</span>
                </th>
                {apps.map((app) => {
                  const table = COMPARE_PRICES[app];
                  const plan = table.plans[level];
                  const ours = app === "contentpilot" ? " mk-compare-table__ours" : "";
                  if (!plan) {
                    return (
                      <td key={app} className={`mk-compare-glance__empty${ours}`}>
                        {g.values.notOffered}
                      </td>
                    );
                  }
                  return (
                    <td key={app} className={`mk-compare-glance__cell${ours}`}>
                      <span className="mk-compare-glance__plan">{plan.name}</span>
                      <span className="mk-compare-glance__price">
                        <PlanPrice plan={plan} table={table} copy={copy} locale={locale} />
                      </span>
                      <dl>
                        <dt>{g.languagesLabel}</dt>
                        <dd>{languages(plan)}</dd>
                        <dt>{g.productsLabel}</dt>
                        <dd>
                          {plan.onRequest
                            ? g.values.onRequest
                            : plan.products === null
                              ? g.values.noProductLimit
                              : plan.products === "unstated"
                                ? g.values.unstated
                                : n(plan.products)}
                        </dd>
                        <dt>{g.aiLabel}</dt>
                        <dd>{volume(plan)}</dd>
                      </dl>
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="mk-compare-glance__trial">
              <th scope="row">
                <span className="mk-compare-table__label">{g.trialRow}</span>
              </th>
              {apps.map((app) => {
                const days = COMPARE_PRICES[app].trialDays;
                return (
                  <td key={app} className={app === "contentpilot" ? "mk-compare-table__ours" : undefined}>
                    {days === null ? g.values.noTrial : g.values.trialDays.replace("{n}", String(days))}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mk-note mk-compare-prices__note">{copy.pricing.note}</p>
    </section>
  );
}

/**
 * What each plan INCLUDES, one card per app, ours first — the detail behind
 * the table above. Each app is shown with its own plan ladder: listing only
 * which of OUR features need which plan read as if the others included
 * everything for free, which none of them does.
 */
export function ComparePlanDetails({
  copy,
  locale,
  apps,
}: {
  copy: CompareCopy;
  locale: MarketingLocale;
  apps: readonly PriceAppId[];
}) {
  return (
    <section className="mk-compare-prices" aria-labelledby="compare-prices-heading">
      <h2 id="compare-prices-heading" className="mk-compare__heading">
        {copy.pricing.heading}
      </h2>
      <p className="mk-compare-prices__intro">{copy.pricing.intro}</p>
      <ul className="mk-compare-prices__grid">
        {apps.map((app) => {
          const table = COMPARE_PRICES[app];
          return (
            <li
              key={app}
              className={`mk-compare-prices__card${app === "contentpilot" ? " mk-compare-prices__card--ours" : ""}`}
            >
              <h3>{appName(app)}</h3>
              <p className="mk-note">{copy.pricing.summaries[app]}</p>
              <dl>
                {table.plans.map((plan) => (
                  <div key={plan.id} className="mk-compare-prices__plan">
                    <dt>
                      <span>{plan.name}</span>
                      <span className="mk-compare-prices__price">
                        <PlanPrice plan={plan} table={table} copy={copy} locale={locale} />
                      </span>
                    </dt>
                    <dd>{copy.pricing.plans[app][plan.id]}</dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
