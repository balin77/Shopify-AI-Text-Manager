import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { getCompareCopy } from "../i18n/marketing/compare";
import { MARKETING_SITE } from "../config/marketing-site";
import { COMPETITORS, COMPETITOR_NAMES, PRICE_APPS, comparePath } from "../config/marketing-compare";
import { breadcrumbLd } from "../utils/marketing-jsonld";
import { buildMarketingMeta } from "../utils/marketing-meta";
import {
  marketingOrigin,
  redirectTrailingSlash,
  requireMarketingLocale,
} from "../utils/marketing-route.server";
import { localizedPath } from "../services/marketing-locale.shared";
import { CompareDisclaimer, CompareTable } from "../components/marketing/CompareTable";
import { ComparePlanDetails, ComparePriceTable } from "../components/marketing/ComparePricing";
import { MarketingCta } from "../components/marketing/MarketingCta";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  redirectTrailingSlash(url);
  const locale = requireMarketingLocale(params.lang, "/compare", url.search);
  return { locale, origin: marketingOrigin(url) };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  const copy = getCompareCopy(data.locale);
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: "/compare",
    title: `${copy.title} — ${t.site.name}`,
    description: copy.intro,
    siteName: t.site.name,
    jsonLd: [
      breadcrumbLd([
        { name: t.site.name, url: `${data.origin}${localizedPath(data.locale, "/")}` },
        { name: t.nav.compare, url: `${data.origin}${localizedPath(data.locale, "/compare")}` },
      ]),
    ],
  });
};

/**
 * `/compare` — ContentPilot against the four translation apps merchants weigh
 * it against, in one table, with a card per app leading to its own page.
 * The facts live in config/marketing-compare.ts; read the rules there before
 * changing an answer.
 */
export default function MarketingCompare() {
  const { locale } = useLoaderData<typeof loader>();
  const t = getMarketingTranslation(locale);
  const copy = getCompareCopy(locale);

  return (
    <>
      <section className="mk-section mk-section--first">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h1>{copy.title}</h1>
            <p className="mk-lead">{copy.intro}</p>
          </div>

          <ComparePriceTable copy={copy} locale={locale} apps={PRICE_APPS} />

          <ul className="mk-compare-cards">
            {COMPETITORS.map((id) => {
              const competitor = copy.competitors[id];
              return (
                <li key={id}>
                  <Link className="mk-compare-card" to={localizedPath(locale, comparePath(id))}>
                    <span className="mk-compare-card__title">
                      {copy.vsTitle.replace("{name}", COMPETITOR_NAMES[id])}
                    </span>
                    <span className="mk-note">{competitor.kind}</span>
                    <span className="mk-compare-card__summary">{competitor.summary}</span>
                    <span className="mk-arrow">{copy.detailLink}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-shell">
          <h2 className="mk-compare__heading">{copy.tableHeading}</h2>
          <CompareTable copy={copy} competitors={COMPETITORS} />
          <p className="mk-note mk-compare__table-note">{copy.tableNote}</p>

          <ComparePlanDetails copy={copy} locale={locale} apps={PRICE_APPS} />
          <CompareDisclaimer copy={copy} />
        </div>
      </section>

      <MarketingCta t={t} locale={locale} />
    </>
  );
}
