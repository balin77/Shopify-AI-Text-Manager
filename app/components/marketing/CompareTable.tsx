import { useEffect, useRef, useState } from "react";
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
import { PlanPrice, appName, includedAiTexts, planLimitTexts } from "./ComparePricing";

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
 * The comparison, plan level by plan level: level buttons and app toggles,
 * and one table in which every column is one app's plan AT that level — its
 * price, its limits, every feature row answered for that plan, and last the
 * app's strengths as text.
 *
 * It is one table on purpose. Prices on top and features below in a second
 * table asked the visitor to match "Level 2" up by hand; here a button click
 * answers "what do I get for roughly this money, from each of them".
 *
 * The controls and the column headers stay in view while the table scrolls,
 * and only until the table ends (their sticky range is the table's wrapper).
 * Where the table fits the page they stick to the page, below the site
 * header. Where it does not (five apps on a phone), the table scrolls in its
 * own box both ways, the headers stick to that box, and the box is at most
 * one screen tall — a page-relative sticky header cannot live inside a
 * horizontal scroll container. Which case applies is MEASURED after mount;
 * the server renders the scrolling box, which is right on every screen.
 *
 * Level and toggles live in component state with the same start values on
 * the server and in the browser, so the first render hydrates cleanly. A real
 * `<table>` with row and column headers, so a screen reader reads each cell
 * with its feature and its app, and every answer is a word next to its symbol.
 */
export function CompareMatrix({
  copy,
  locale,
  apps,
  initialApps,
}: {
  copy: CompareCopy;
  locale: MarketingLocale;
  /** Every app the visitor can switch on. ContentPilot is always shown. */
  apps: readonly PriceAppId[];
  /** Apps shown before any toggle is touched; default: all of `apps`. */
  initialApps?: readonly PriceAppId[];
}) {
  const g = copy.glance;
  // The level count comes from every SELECTABLE app, so switching an app off
  // never takes a level button away from under the visitor.
  const levelCount = priceLevelCount(apps);
  const [level, setLevel] = useState(Math.min(DEFAULT_LEVEL, levelCount - 1));
  const [shown, setShown] = useState<readonly PriceAppId[]>(initialApps ?? apps);
  const visible = apps.filter((app) => app === "contentpilot" || shown.includes(app));
  const hidden = apps.filter((app) => app !== "contentpilot" && !shown.includes(app));
  const shownCompetitors = visible.filter((app) => app !== "contentpilot");
  // The last competitor cannot be hidden: a table of ContentPilot alone
  // compares nothing.
  const canHide = shownCompetitors.length > 1;
  const hide = (app: PriceAppId) => setShown((current) => current.filter((a) => a !== app));
  const show = (app: PriceAppId) => {
    setShown((current) => [...current, app]);
    setAddOpen(false);
  };
  // The `+` column exists only while there is something to add back.
  const addColumn = hidden.length > 0;
  const columns = 1 + visible.length + (addColumn ? 1 : 0);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!addRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);
  useEffect(() => {
    if (!addColumn) setAddOpen(false);
  }, [addColumn]);
  /** Filler cell of the `+` column in every body row. */
  const addFiller = addColumn ? <td className="mk-compare-matrix__add-cell" aria-hidden="true" /> : null;
  const levelLabel = (i: number) => (i === 0 ? g.freeLevel : g.level.replace("{n}", String(i)));

  const bodyRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [fits, setFits] = useState(false);
  useEffect(() => {
    const body = bodyRef.current;
    const controls = controlsRef.current;
    const box = scrollRef.current;
    const table = tableRef.current;
    if (!body || !controls || !box || !table || typeof ResizeObserver === "undefined") return;
    const header = document.querySelector<HTMLElement>(".mk-header");
    // Inside the scroll box the headers stick to the BOX, and the box itself
    // scrolls with the page — so once the page carries its top under the
    // sticky controls, the headers would go with it. They are pushed down by
    // exactly that overlap, never past the box's bottom.
    let frame = 0;
    const follow = () => {
      frame = 0;
      const stuckAt = (header?.offsetHeight ?? 0) + controls.offsetHeight;
      const head = table.tHead?.offsetHeight ?? 0;
      const overlap = stuckAt - box.getBoundingClientRect().top;
      const shift = Math.max(0, Math.min(overlap, box.clientHeight - head));
      body.style.setProperty("--mk-compare-shift", `${shift}px`);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(follow);
    };
    const measure = () => {
      // The site header is sticky too and wraps to two rows on a phone, so
      // its real height is read rather than the desktop token.
      const headerHeight = header?.offsetHeight ?? 0;
      body.style.setProperty("--mk-compare-header", `${headerHeight}px`);
      body.style.setProperty("--mk-compare-controls", `${controls.offsetHeight}px`);
      // Our column sticks right after the feature column, whose width the
      // browser decides, so its offset is read rather than restated.
      const firstColumn = table.tHead?.rows[0]?.cells[0];
      if (firstColumn) body.style.setProperty("--mk-compare-first-col", `${firstColumn.offsetWidth}px`);
      setFits(table.offsetWidth <= box.clientWidth + 1);
      follow();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(table);
    observer.observe(controls);
    if (header) observer.observe(header);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const planAt = (app: PriceAppId, at: number) => {
    const plans = COMPARE_PRICES[app].plans;
    const index = Math.min(at, plans.length - 1);
    return { plan: plans[index], isTop: at > index };
  };
  const stack = (render: (at: number) => React.ReactNode) => (
    <LevelStack level={level} count={levelCount} render={render} />
  );
  const oursClass = (app: PriceAppId) => (app === "contentpilot" ? "mk-compare-table__ours" : undefined);
  const single = visible.length <= 2;

  return (
    <section className="mk-compare-matrix" aria-labelledby="compare-matrix-heading">
      <h2 id="compare-matrix-heading" className="mk-compare__heading">
        {g.heading}
      </h2>
      <p className="mk-compare-prices__intro">{g.intro}</p>

      <div ref={bodyRef} className="mk-compare-matrix__body" data-fits={fits ? "true" : undefined}>
        <div ref={controlsRef} className="mk-compare-controls">
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
        </div>

      <div
        ref={scrollRef}
        className="mk-compare-table__scroll"
        tabIndex={0}
        role="region"
        aria-labelledby="compare-matrix-heading"
      >
        <table
          ref={tableRef}
          className={`mk-compare-table mk-compare-matrix__table${single ? " mk-compare-table--single" : ""}`}
        >
          <thead>
            <tr>
              <th scope="col">{copy.featureColumn}</th>
              {visible.map((app) => {
                const name = app === "contentpilot" ? MARKETING_SITE.appName : appName(app);
                const content = (
                  <>
                    <span className="mk-compare-matrix__app">{name}</span>
                    <span className="mk-compare-matrix__plan">
                      {stack((at) => {
                        const { plan, isTop } = planAt(app, at);
                        return `${plan.name}${isTop ? ` · ${g.topPlan}` : ""}`;
                      })}
                    </span>
                  </>
                );
                const removable = app !== "contentpilot" && canHide;
                return (
                  <th scope="col" key={app} className={oursClass(app)}>
                    {removable ? (
                      <button
                        type="button"
                        className="mk-compare-matrix__remove"
                        title={g.removeApp.replace("{name}", name)}
                        aria-label={g.removeApp.replace("{name}", name)}
                        onClick={() => hide(app)}
                      >
                        <span className="mk-compare-matrix__remove-body">{content}</span>
                        <span className="mk-compare-matrix__remove-icon" aria-hidden="true">
                          ×
                        </span>
                      </button>
                    ) : (
                      content
                    )}
                  </th>
                );
              })}
              {addColumn ? (
                <th scope="col" className="mk-compare-matrix__add-cell">
                  <div className="mk-compare-matrix__add" ref={addRef}>
                    <button
                      type="button"
                      className="mk-compare-matrix__add-button"
                      title={g.addApp}
                      aria-label={g.addApp}
                      aria-expanded={addOpen}
                      aria-haspopup="menu"
                      onClick={() => setAddOpen((open) => !open)}
                    >
                      +
                    </button>
                    {addOpen ? (
                      <ul className="mk-compare-matrix__add-menu" role="menu" aria-label={g.addApp}>
                        {hidden.map((app) => (
                          <li key={app} role="none">
                            <button type="button" role="menuitem" onClick={() => show(app)}>
                              {appName(app)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </th>
              ) : null}
            </tr>
          </thead>

          <tbody>
            <tr className="mk-compare-table__group">
              <th scope="rowgroup" colSpan={columns}>
                <span className="mk-compare-table__group-label">{g.planGroup}</span>
              </th>
            </tr>
            <tr className="mk-compare-matrix__price-row">
              <th scope="row">
                <span className="mk-compare-table__label">{g.priceLabel}</span>
              </th>
              {visible.map((app) => (
                <td key={app} className={oursClass(app)}>
                  {stack((at) => {
                    const { plan } = planAt(app, at);
                    const alt = includedAiTexts(plan, COMPARE_PRICES[app], copy, locale).price;
                    return (
                      <>
                        <span className="mk-compare-glance__price">
                          <PlanPrice plan={plan} table={COMPARE_PRICES[app]} copy={copy} locale={locale} />
                        </span>
                        {alt ? <span className="mk-compare-matrix__alt">{alt}</span> : null}
                      </>
                    );
                  })}
                </td>
              ))}
              {addFiller}
            </tr>
            {(["languages", "products", "volume"] as const).map((key) => (
              <tr key={key}>
                <th scope="row">
                  <span className="mk-compare-table__label">
                    {key === "languages" ? g.languagesLabel : key === "products" ? g.productsLabel : g.aiLabel}
                  </span>
                </th>
                {visible.map((app) => (
                  <td key={app} className={oursClass(app)}>
                    {stack((at) => {
                      const { plan } = planAt(app, at);
                      const alt = key === "volume" ? includedAiTexts(plan, COMPARE_PRICES[app], copy, locale).volume : null;
                      return (
                        <>
                          {planLimitTexts(plan, copy, locale)[key]}
                          {alt ? <span className="mk-compare-matrix__alt">{alt}</span> : null}
                        </>
                      );
                    })}
                  </td>
                ))}
                {addFiller}
              </tr>
            ))}
            <tr>
              <th scope="row">
                <span className="mk-compare-table__label">{g.enginesLabel}</span>
              </th>
              {visible.map((app) => (
                <td key={app} className={oursClass(app)}>
                  {stack((at) => {
                    const engines = COMPARE_ENGINES[app];
                    const alt = includedAiTexts(planAt(app, at).plan, COMPARE_PRICES[app], copy, locale).engines;
                    return (
                      <>
                        {enginesText(engines[Math.min(at, engines.length - 1)], copy)}
                        {alt ? <span className="mk-compare-matrix__alt">{alt}</span> : null}
                      </>
                    );
                  })}
                </td>
              ))}
              {addFiller}
            </tr>
            <tr>
              <th scope="row">
                <span className="mk-compare-table__label">{g.trialRow}</span>
              </th>
              {visible.map((app) => {
                const days = COMPARE_PRICES[app].trialDays;
                return (
                  <td key={app} className={oursClass(app)}>
                    {days === null
                      ? g.values.noTrial
                      : days === "unstated"
                        ? g.values.unstated
                        : g.values.trialDays.replace("{n}", String(days))}
                  </td>
                );
              })}
              {addFiller}
            </tr>
          </tbody>

          {COMPARE_GROUPS.map((group) => (
            <tbody key={group}>
              <tr className="mk-compare-table__group">
                <th scope="rowgroup" colSpan={columns}>
                  <span className="mk-compare-table__group-label">{copy.groups[group]}</span>
                </th>
              </tr>
              {COMPARE_ROWS.filter((row) => row.group === group).map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <span className="mk-compare-table__label">{copy.rows[row.id].label}</span>
                    <span className="mk-compare-table__help">{copy.rows[row.id].help}</span>
                  </th>
                  {visible.map((app) => (
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
                  {addFiller}
                </tr>
              ))}
            </tbody>
          ))}

          <tbody>
            <tr className="mk-compare-table__group">
              <th scope="rowgroup" colSpan={columns}>
                <span className="mk-compare-table__group-label">{g.strengthsGroup}</span>
              </th>
            </tr>
            <tr>
              <th scope="row">
                <span className="mk-compare-table__label">{g.strengthsRow}</span>
                <span className="mk-compare-table__help">{g.strengthsHelp}</span>
              </th>
              {visible.map((app) => (
                <td key={app} className={oursClass(app)}>
                  <ul className="mk-compare-strengths">
                    {(app === "contentpilot" ? copy.ourStrengths : copy.competitors[app].strengths).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </td>
              ))}
              {addFiller}
            </tr>
          </tbody>
        </table>
      </div>
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
    case "manual":
      return e.manual;
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
