import { useState } from "react";
import {
  COMPARE_ENGINES,
  COMPARE_GROUPS,
  COMPARE_PRICES,
  COMPARE_ROWS,
  priceLevelCount,
  supportAtLevel,
  type PlanEngines,
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

/**
 * Every level's content of one cell, stacked in the same grid area with only
 * the active one visible. The cell is therefore always as wide and as tall as
 * its LONGEST level, so switching levels moves nothing — the table used to
 * re-flow its column widths and row heights on every click. Hidden layers are
 * `visibility: hidden`, which also takes them out of the accessibility tree.
 */
function LevelStack({
  level,
  count,
  render,
}: {
  level: number;
  count: number;
  render: (level: number) => React.ReactNode;
}) {
  return (
    <span className="mk-level-stack">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="mk-level-stack__item" data-active={i === level ? "true" : undefined}>
          {render(i)}
        </span>
      ))}
    </span>
  );
}

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

  const planAt = (app: PriceAppId, at: number) => {
    const plans = COMPARE_PRICES[app].plans;
    const index = Math.min(at, plans.length - 1);
    return { plan: plans[index], isTop: at > index };
  };
  const stack = (render: (at: number) => React.ReactNode) => (
    <LevelStack level={level} count={levelCount} render={render} />
  );
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
              {apps.map((app) => (
                <th scope="col" key={app} className={oursClass(app)}>
                  <span className="mk-compare-matrix__app">
                    {app === "contentpilot" ? MARKETING_SITE.appName : appName(app)}
                  </span>
                  <span className="mk-compare-matrix__plan">
                    {stack((at) => {
                      const { plan, isTop } = planAt(app, at);
                      return `${plan.name}${isTop ? ` · ${g.topPlan}` : ""}`;
                    })}
                  </span>
                </th>
              ))}
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
                    {stack((at) => (
                      <PlanPrice plan={planAt(app, at).plan} table={COMPARE_PRICES[app]} copy={copy} locale={locale} />
                    ))}
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
                    {stack((at) => planLimitTexts(planAt(app, at).plan, copy, locale)[key])}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">
                <span className="mk-compare-table__label">{g.enginesLabel}</span>
              </th>
              {apps.map((app) => (
                <td key={app} className={oursClass(app)}>
                  {stack((at) => {
                    const engines = COMPARE_ENGINES[app];
                    return enginesText(engines[Math.min(at, engines.length - 1)], copy);
                  })}
                </td>
              ))}
            </tr>
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
                  {apps.map((app) => (
                    <td key={app} className={`mk-compare-cell${app === "contentpilot" ? " mk-compare-table__ours" : ""}`}>
                      {stack((at) => {
                        const support = supportAtLevel(row, app, at);
                        // A cell's note explains the feature, not the plan: it
                        // is dropped where the answer is "on a higher plan".
                        const note =
                          support === "higherPlan"
                            ? undefined
                            : app === "contentpilot"
                              ? copy.ourNotes[row.id]
                              : copy.competitors[app].notes?.[row.id];
                        return <CellAnswer support={support} label={copy.support[support]} note={note} />;
                      })}
                    </td>
                  ))}
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

function enginesText(engines: PlanEngines, copy: CompareCopy): string {
  const e = copy.glance.engines;
  switch (engines.kind) {
    case "ownKey":
      return e.ownKey.replace("{list}", engines.names.join(", "));
    case "list": {
      const base = engines.names.join(", ");
      return engines.ownKey ? `${base}. ${e.plusOwnKey.replace("{list}", engines.ownKey.join(", "))}` : base;
    }
    case "shopify":
      return e.shopify;
    case "vendor":
      return e.vendor;
    case "unstated":
      return e.unstated;
  }
}

function CellAnswer({ support, label, note }: { support: Support; label: string; note?: string }) {
  return (
    <span className={`mk-compare-cell--${support}`}>
      <span className="mk-compare-cell__answer">
        <span className="mk-compare-cell__symbol" aria-hidden="true">
          {SYMBOL[support]}
        </span>
        {label}
      </span>
      {note ? <span className="mk-compare-cell__note">{note}</span> : null}
    </span>
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
