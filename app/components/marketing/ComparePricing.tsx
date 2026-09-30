import {
  COMPARE_PRICES,
  COMPETITOR_NAMES,
  formatComparePrice,
  type PriceAppId,
} from "../../config/marketing-compare";
import { MARKETING_SITE } from "../../config/marketing-site";
import type { CompareCopy } from "../../i18n/marketing/compare";
import type { MarketingLocale } from "../../services/marketing-locale.shared";

/**
 * Every plan of the given apps, one card per app, ours first. Each app is
 * shown with ITS OWN plan ladder: a comparison that listed only which of our
 * features need which plan read as if the others included everything for
 * free, which none of them does.
 */
export function ComparePricing({
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
          const name = app === "contentpilot" ? MARKETING_SITE.appName : COMPETITOR_NAMES[app];
          return (
            <li
              key={app}
              className={`mk-compare-prices__card${app === "contentpilot" ? " mk-compare-prices__card--ours" : ""}`}
            >
              <h3>{name}</h3>
              <p className="mk-note">{copy.pricing.summaries[app]}</p>
              <dl>
                {table.plans.map((plan) => (
                  <div key={plan.id} className="mk-compare-prices__plan">
                    <dt>
                      <span>{plan.name}</span>
                      <span className="mk-compare-prices__price">
                        {plan.monthly === 0 ? (
                          copy.pricing.free
                        ) : (
                          <>
                            {formatComparePrice(plan.monthly, table.currency, locale)}{" "}
                            <span className="mk-compare-prices__unit">{copy.pricing.perMonth}</span>
                          </>
                        )}
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
      <p className="mk-note mk-compare-prices__note">{copy.pricing.note}</p>
    </section>
  );
}
