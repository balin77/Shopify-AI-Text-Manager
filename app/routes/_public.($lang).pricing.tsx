import { useState } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { getMarketingTranslation, type MarketingTranslation } from "../i18n/marketing";
import { MARKETING_SITE } from "../config/marketing-site";
import { PLAN_CONFIG, PLAN_DISPLAY_NAMES, type Plan } from "../config/plans";
import {
  PRICING_GROUPS,
  PRICING_HIGHLIGHT,
  PRICING_PLANS,
  PRICING_TASTER_ACTIONS,
  PRICING_TRIAL_DAYS,
  planCardRows,
  planPrice,
  pricingCell,
  previousPlan,
  type PricingCell,
  type PricingRow,
} from "../config/marketing-pricing";
import { formatCompareNumber, formatComparePrice } from "../config/marketing-compare";
import { breadcrumbLd } from "../utils/marketing-jsonld";
import { buildMarketingMeta } from "../utils/marketing-meta";
import {
  marketingOrigin,
  redirectTrailingSlash,
  requireMarketingLocale,
} from "../utils/marketing-route.server";
import { localizedPath, type MarketingLocale } from "../services/marketing-locale.shared";
import { InstallLink } from "../components/marketing/InstallLink";
import { MarketingCta } from "../components/marketing/MarketingCta";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  redirectTrailingSlash(url);
  const locale = requireMarketingLocale(params.lang, "/pricing", url.search);
  return { locale, origin: marketingOrigin(url) };
};

/** `{days}` in the billing copy, filled from the billing config. */
function withDays(text: string): string {
  return text.replace("{days}", String(PRICING_TRIAL_DAYS));
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  const p = t.pricing;
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: "/pricing",
    title: `${p.title} — ${t.site.name}`,
    description: `${p.intro} ${withDays(p.trial)}`,
    siteName: t.site.name,
    jsonLd: [
      breadcrumbLd([
        { name: t.site.name, url: `${data.origin}${localizedPath(data.locale, "/")}` },
        { name: t.nav.pricing, url: `${data.origin}${localizedPath(data.locale, "/pricing")}` },
      ]),
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: p.faq.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: withDays(item.a) },
        })),
      },
    ],
  });
};

function PriceTag({ plan, withAi, t, locale }: { plan: Plan; withAi: boolean; t: MarketingTranslation; locale: MarketingLocale }) {
  const amount = planPrice(plan, withAi);
  if (amount === 0) return <>{t.pricing.free}</>;
  return (
    <>
      {formatComparePrice(amount, "EUR", locale)}{" "}
      <span className="mk-pricing__unit">{t.pricing.perMonth}</span>
    </>
  );
}

/** How many unlocked rows a card names before pointing at the table. */
const CARD_ROWS = 5;

function fill(text: string, plan: Plan, locale: MarketingLocale): string {
  const limits = PLAN_CONFIG[plan];
  const n = (value: number) => formatCompareNumber(value, locale);
  return text
    .replace("{products}", n(limits.maxProducts))
    .replace("{collections}", n(limits.maxCollections))
    .replace("{taster}", n(PRICING_TASTER_ACTIONS));
}

/** One answer in the matrix: always a symbol AND a word, never colour alone. */
function Cell({ row, cell, t, locale }: { row: PricingRow; cell: PricingCell; t: MarketingTranslation; locale: MarketingLocale }) {
  const v = t.pricing.values;
  if (cell === false || cell === 0) {
    return (
      <span className="mk-compare-cell--no">
        <span className="mk-compare-cell__symbol" aria-hidden="true">✕</span>
        <span className="mk-visually-hidden">{v.no}</span>
      </span>
    );
  }
  if (cell === true) {
    return (
      <span className="mk-compare-cell--yes">
        <span className="mk-compare-cell__symbol" aria-hidden="true">✓</span>
        <span className="mk-visually-hidden">{v.yes}</span>
      </span>
    );
  }
  if (typeof cell === "number") {
    if (cell === Infinity) return <>{v.unlimited}</>;
    const formats = t.pricing.formats as Partial<Record<string, string>>;
    const template = formats[row.id] ?? "{n}";
    return <>{template.replace("{n}", formatCompareNumber(cell, locale))}</>;
  }
  return <>{v[cell.text]}</>;
}

/**
 * `/pricing` — the four plans side by side. Every number on the page is read
 * from the configs the app enforces (config/marketing-pricing.ts); the copy
 * only names them.
 *
 * The own-key / AI-included switch is component state with the same start
 * value on the server and in the browser, so the first render hydrates
 * cleanly. It changes only which price is shown — both variants carry the
 * same features, exactly like the plan tab inside the app.
 */
export default function MarketingPricing() {
  const { locale } = useLoaderData<typeof loader>();
  const t = getMarketingTranslation(locale);
  const p = t.pricing;
  const [withAi, setWithAi] = useState(false);

  return (
    <>
      <section className="mk-section mk-section--first">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h1>{p.title}</h1>
            <p className="mk-lead">{p.intro}</p>
            <p className="mk-note">{withDays(p.trial)}</p>
          </div>

          <div className="mk-pricing__mode">
            <div className="mk-compare-levels" role="group" aria-label={p.modeLabel}>
              <button
                type="button"
                className="mk-compare-levels__button"
                aria-pressed={!withAi}
                onClick={() => setWithAi(false)}
              >
                {p.modeOwnKey}
              </button>
              <button
                type="button"
                className="mk-compare-levels__button"
                aria-pressed={withAi}
                onClick={() => setWithAi(true)}
              >
                {p.modeIncluded}
              </button>
            </div>
            <p className="mk-note" aria-live="polite">
              {withAi ? p.modeIncludedHint : p.modeOwnKeyHint}
            </p>
          </div>

          <ul className="mk-pricing__cards">
            {PRICING_PLANS.map((plan) => {
              const highlighted = plan === PRICING_HIGHLIGHT;
              const copy = p.plans[plan];
              return (
                <li
                  key={plan}
                  className={`mk-pricing__card${highlighted ? " mk-pricing__card--highlight" : ""}`}
                >
                  {highlighted ? <span className="mk-pricing__badge">{p.recommended}</span> : null}
                  <h2 className="mk-pricing__name">{PLAN_DISPLAY_NAMES[plan]}</h2>
                  <p className="mk-pricing__tagline">{copy.tagline}</p>
                  <p className="mk-pricing__price">
                    <PriceTag plan={plan} withAi={withAi} t={t} locale={locale} />
                  </p>
                  {/* Free has no AI variant; its one-time taster is a highlight
                      line instead, so the card does not change with the switch. */}
                  {withAi && plan !== "free" ? (
                    <p className="mk-pricing__volume">{p.includedVolume[plan]}</p>
                  ) : null}
                  <p className="mk-pricing__limits">{fill(p.limitsLine, plan, locale)}</p>
                  <PlanCardPoints plan={plan} t={t} locale={locale} />
                  <InstallLink
                    locale={locale}
                    className={`mk-btn ${highlighted ? "mk-btn--primary" : "mk-btn--ghost"} mk-pricing__cta`}
                  >
                    {plan === "free" ? p.chooseFree : p.choose}
                  </InstallLink>
                </li>
              );
            })}
          </ul>

          <Link className="mk-arrow mk-pricing__compare" to={localizedPath(locale, "/compare")}>
            {p.compareLink}
          </Link>
        </div>
      </section>

      <section className="mk-section" aria-labelledby="pricing-table-heading">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h2 id="pricing-table-heading">{p.tableTitle}</h2>
            <p className="mk-lead">{p.tableIntro}</p>
          </div>

          <div className="mk-compare-table__scroll" tabIndex={0} role="region" aria-labelledby="pricing-table-heading">
            <table className="mk-compare-table mk-pricing-table">
              <thead>
                <tr>
                  <th scope="col">{p.planColumn}</th>
                  {PRICING_PLANS.map((plan) => (
                    <th
                      key={plan}
                      scope="col"
                      className={plan === PRICING_HIGHLIGHT ? "mk-compare-table__ours" : undefined}
                    >
                      {PLAN_DISPLAY_NAMES[plan]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">
                    <span className="mk-compare-table__label">{p.priceRow}</span>
                    <span className="mk-compare-table__help">{withAi ? p.modeIncluded : p.modeOwnKey}</span>
                  </th>
                  {PRICING_PLANS.map((plan) => (
                    <td key={plan} className={plan === PRICING_HIGHLIGHT ? "mk-compare-table__ours" : undefined}>
                      <strong>
                        <PriceTag plan={plan} withAi={withAi} t={t} locale={locale} />
                      </strong>
                    </td>
                  ))}
                </tr>
                {PRICING_GROUPS.map((group) => (
                  <PricingGroupRows key={group.id} group={group} t={t} locale={locale} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mk-note mk-compare__disclaimer">{p.tableNote}</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h2>{p.faqTitle}</h2>
          </div>
          <div className="mk-faq">
            {p.faq.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p>{withDays(item.a)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <MarketingCta t={t} locale={locale} />
    </>
  );
}

/**
 * The card's list, derived from the matrix (planCardRows): what Free
 * includes, or what a paid plan adds over the one below it. Nothing on it is
 * written by hand, so a feature moved between tiers in the app's config moves
 * here as well.
 */
function PlanCardPoints({ plan, t, locale }: { plan: Plan; t: MarketingTranslation; locale: MarketingLocale }) {
  const p = t.pricing;
  const rows = planCardRows(plan);
  const shown = rows.slice(0, CARD_ROWS);
  const rest = rows.length - shown.length;
  const before = previousPlan(plan);
  return (
    <div className="mk-pricing__points">
      <p className="mk-pricing__points-head">
        {before ? p.everythingIn.replace("{plan}", PLAN_DISPLAY_NAMES[before]) : p.included}
      </p>
      <ul className="mk-points">
        {shown.map((row) => {
          const cell = pricingCell(row, plan);
          const label = (p.rows[row.id] as { label: string }).label;
          // A number is part of the point ("PageSpeed checks: 5 / day");
          // a tick is not — the label alone says it is included.
          return (
            <li key={row.id}>
              {cell === true ? (
                label
              ) : (
                <>
                  {label}: <Cell row={row} cell={cell} t={t} locale={locale} />
                </>
              )}
            </li>
          );
        })}
        {plan === "free" ? <li>{fill(p.tasterLine, plan, locale)}</li> : null}
      </ul>
      {rest > 0 ? <p className="mk-pricing__more">{p.moreInTable.replace("{n}", String(rest))}</p> : null}
    </div>
  );
}

function PricingGroupRows({
  group,
  t,
  locale,
}: {
  group: (typeof PRICING_GROUPS)[number];
  t: MarketingTranslation;
  locale: MarketingLocale;
}) {
  const p = t.pricing;
  return (
    <>
      <tr className="mk-compare-table__group">
        <th scope="colgroup" colSpan={1 + PRICING_PLANS.length}>
          {p.groups[group.id]}
        </th>
      </tr>
      {group.rows.map((row) => {
        const copy = p.rows[row.id] as { label: string; help?: string };
        return (
          <tr key={row.id}>
            <th scope="row">
              <span className="mk-compare-table__label">{copy.label}</span>
              {copy.help ? <span className="mk-compare-table__help">{copy.help}</span> : null}
            </th>
            {PRICING_PLANS.map((plan) => (
              <td key={plan} className={plan === PRICING_HIGHLIGHT ? "mk-compare-table__ours" : undefined}>
                <Cell row={row} cell={pricingCell(row, plan)} t={t} locale={locale} />
              </td>
            ))}
          </tr>
        );
      })}
    </>
  );
}
