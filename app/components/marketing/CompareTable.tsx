import { useState } from "react";
import {
  COMPARE_GROUPS,
  COMPARE_PRICES,
  COMPARE_ROWS,
  priceLevelCount,
  supportAtLevel,
  type PriceAppId,
  type Support,
} from "../../config/marketing-compare";
import { MARKETING_SITE } from "../../config/marketing-site";
import type { CompareCopy } from "../../i18n/marketing/compare";
import type { MarketingLocale } from "../../services/marketing-locale.shared";
import { PlanPrice, appName, planLimitTexts } from "./ComparePricing";

const SYMBOL: Record<Support, string> = {
  yes: "✓",
  partial: "~",
  no: "✕",
  unstated: "?",
  higherPlan: "↑",
};

/** Level shown first: the first PAID level, which is what most visitors compare. */
const DEFAULT_LEVEL = 1;

/**
 * The comparison, plan level by plan level: a row of level buttons, and one
 * table in which every column is one app's plan AT that level — its price,
 * its limits, and then every feature row answered for that plan.
 *
 * It is one table on purpose. Prices on top and features below in a second
 * table asked the visitor to match "Level 2" up by hand; here a button click
 * answers "what do I get for roughly this money, from each of them".
 *
 * The level lives in component state and starts at the same value on the
 * server and in the browser, so the first render hydrates cleanly. A real
 * `<table>` with row and column headers, so a screen reader reads each cell
 * with its feature and its app, and every answer is a word next to its symbol.
 */
export function CompareMatrix({
  copy,
  locale,
  apps,
}: {
  copy: CompareCopy;
  locale: MarketingLocale;
  apps: readonly PriceAppId[];
}) {
  const g = copy.glance;
  const levelCount = priceLevelCount(apps);
  const [level, setLevel] = useState(Math.min(DEFAULT_LEVEL, levelCount - 1));
  const levelLabel = (i: number) => (i === 0 ? g.freeLevel : g.level.replace("{n}", String(i)));

  const planOf = (app: PriceAppId) => {
    const plans = COMPARE_PRICES[app].plans;
    const index = Math.min(level, plans.length - 1);
    return { plan: plans[index], isTop: level > index };
  };
  const oursClass = (app: PriceAppId) => (app === "contentpilot" ? "mk-compare-table__ours" : undefined);
  const single = apps.length <= 2;

  return (
    <section className="mk-compare-matrix" aria-labelledby="compare-matrix-heading">
      <h2 id="compare-matrix-heading" className="mk-compare__heading">
        {g.heading}
      </h2>
      <p className="mk-compare-prices__intro">{g.intro}</p>

      <div className="mk-compare-levels" role="group" aria-label={g.levelPicker}>
        {Array.from({ length: levelCount }, (_, i) => (
          <button
            key={i}
            type="button"
            className="mk-compare-levels__button"
            aria-pressed={i === level}
            onClick={() => setLevel(i)}
          >
            {levelLabel(i)}
          </button>
        ))}
      </div>

      <div className="mk-compare-table__scroll" tabIndex={0} role="region" aria-labelledby="compare-matrix-heading">
        <table className={`mk-compare-table mk-compare-matrix__table${single ? " mk-compare-table--single" : ""}`}>
          <thead>
            <tr>
              <th scope="col">{copy.featureColumn}</th>
              {apps.map((app) => {
                const { plan, isTop } = planOf(app);
                return (
                  <th scope="col" key={app} className={oursClass(app)}>
                    <span className="mk-compare-matrix__app">
                      {app === "contentpilot" ? MARKETING_SITE.appName : appName(app)}
                    </span>
                    <span className="mk-compare-matrix__plan">
                      {plan.name}
                      {isTop ? ` · ${g.topPlan}` : ""}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            <tr className="mk-compare-table__group">
              <th scope="rowgroup" colSpan={1 + apps.length}>
                {g.planGroup}
              </th>
            </tr>
            <tr className="mk-compare-matrix__price-row">
              <th scope="row">
                <span className="mk-compare-table__label">{g.priceLabel}</span>
              </th>
              {apps.map((app) => (
                <td key={app} className={oursClass(app)}>
                  <span className="mk-compare-glance__price">
                    <PlanPrice plan={planOf(app).plan} table={COMPARE_PRICES[app]} copy={copy} locale={locale} />
                  </span>
                </td>
              ))}
            </tr>
            {(["languages", "products", "volume"] as const).map((key) => (
              <tr key={key}>
                <th scope="row">
                  <span className="mk-compare-table__label">
                    {key === "languages" ? g.languagesLabel : key === "products" ? g.productsLabel : g.aiLabel}
                  </span>
                </th>
                {apps.map((app) => (
                  <td key={app} className={oursClass(app)}>
                    {planLimitTexts(planOf(app).plan, copy, locale)[key]}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">
                <span className="mk-compare-table__label">{g.trialRow}</span>
              </th>
              {apps.map((app) => {
                const days = COMPARE_PRICES[app].trialDays;
                return (
                  <td key={app} className={oursClass(app)}>
                    {days === null ? g.values.noTrial : g.values.trialDays.replace("{n}", String(days))}
                  </td>
                );
              })}
            </tr>
          </tbody>

          {COMPARE_GROUPS.map((group) => (
            <tbody key={group}>
              <tr className="mk-compare-table__group">
                <th scope="rowgroup" colSpan={1 + apps.length}>
                  {copy.groups[group]}
                </th>
              </tr>
              {COMPARE_ROWS.filter((row) => row.group === group).map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <span className="mk-compare-table__label">{copy.rows[row.id].label}</span>
                    <span className="mk-compare-table__help">{copy.rows[row.id].help}</span>
                  </th>
                  {apps.map((app) => {
                    const support = supportAtLevel(row, app, level);
                    // A cell's note explains the feature, not the plan: it is
                    // dropped where the answer is "on a higher plan".
                    const note =
                      support === "higherPlan"
                        ? undefined
                        : app === "contentpilot"
                          ? copy.ourNotes[row.id]
                          : copy.competitors[app].notes?.[row.id];
                    return (
                      <CompareCell
                        key={app}
                        support={support}
                        label={copy.support[support]}
                        note={note}
                        ours={app === "contentpilot"}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <p className="mk-note mk-compare__table-note">{copy.tableNote}</p>
      <p className="mk-note mk-compare-prices__note">{copy.pricing.note}</p>
    </section>
  );
}

function CompareCell({
  support,
  label,
  note,
  ours = false,
}: {
  support: Support;
  label: string;
  note?: string;
  ours?: boolean;
}) {
  return (
    <td className={`mk-compare-cell mk-compare-cell--${support}${ours ? " mk-compare-table__ours" : ""}`}>
      <span className="mk-compare-cell__answer">
        <span className="mk-compare-cell__symbol" aria-hidden="true">
          {SYMBOL[support]}
        </span>
        {label}
      </span>
      {note ? <span className="mk-compare-cell__note">{note}</span> : null}
    </td>
  );
}

/** Where the facts come from, how old they are, and where to report a wrong one. */
export function CompareDisclaimer({ copy }: { copy: CompareCopy }) {
  return (
    <p className="mk-note mk-compare__disclaimer">
      {copy.disclaimer.replace("{date}", copy.checkedAt)}{" "}
      <a href={`mailto:${MARKETING_SITE.supportEmail}`}>{copy.correction}</a>
    </p>
  );
}
