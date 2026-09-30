import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { getCompareCopy } from "../i18n/marketing/compare";
import { MARKETING_SITE } from "../config/marketing-site";
import {
  COMPETITORS,
  COMPETITOR_NAMES,
  comparePath,
  isCompetitorId,
} from "../config/marketing-compare";
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
  // Locale gate first, with the real path, like the guide's topic route.
  const locale = requireMarketingLocale(params.lang, `/compare/${params.competitor ?? ""}`, url.search);
  const competitor = params.competitor;
  if (!isCompetitorId(competitor)) {
    throw new Response("Not Found", { status: 404 });
  }
  return { locale, origin: marketingOrigin(url), competitor };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  const copy = getCompareCopy(data.locale);
  const name = COMPETITOR_NAMES[data.competitor];
  const pageUrl = `${data.origin}${localizedPath(data.locale, comparePath(data.competitor))}`;
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: comparePath(data.competitor),
    title: copy.vsMetaTitle.replace("{name}", name),
    description: copy.competitors[data.competitor].summary,
    siteName: t.site.name,
    jsonLd: [
      breadcrumbLd([
        { name: t.site.name, url: `${data.origin}${localizedPath(data.locale, "/")}` },
        { name: t.nav.compare, url: `${data.origin}${localizedPath(data.locale, "/compare")}` },
        { name: copy.vsTitle.replace("{name}", name), url: pageUrl },
      ]),
    ],
  });
};

/**
 * `/compare/<app>` — ContentPilot against ONE app: the table narrowed to two
 * columns, then what the other app does well, what we add, the pricing models
 * side by side and a plain verdict. The page is written to be fair — the
 * "where it is strong" list comes before ours on purpose.
 */
export default function MarketingCompareOne() {
  const { locale, competitor } = useLoaderData<typeof loader>();
  const t = getMarketingTranslation(locale);
  const copy = getCompareCopy(locale);
  const them = copy.competitors[competitor];
  const name = COMPETITOR_NAMES[competitor];
  const fill = (text: string) => text.replace("{name}", name);
  const others = COMPETITORS.filter((id) => id !== competitor);

  return (
    <>
      <section className="mk-section mk-section--first">
        <div className="mk-shell">
          <nav className="mk-guide__crumbs" aria-label={t.nav.compare}>
            <Link to={localizedPath(locale, "/compare")}>{copy.allComparisons}</Link>
          </nav>
          <div className="mk-section__head">
            <h1>{fill(copy.vsTitle)}</h1>
            <p className="mk-lead">{them.summary}</p>
          </div>

          <ComparePriceTable copy={copy} locale={locale} apps={["contentpilot", competitor]} />

          <div className="mk-compare-detail">
            <section>
              <h2>{fill(copy.aboutHeading)}</h2>
              <p>{them.about}</p>
            </section>

            <div className="mk-compare-detail__pair">
              <section className="mk-compare-detail__box">
                <h2>{fill(copy.strengthsHeading)}</h2>
                <ul className="mk-points">
                  {them.strengths.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
              <section className="mk-compare-detail__box mk-compare-detail__box--ours">
                <h2>{copy.ourEdgeHeading}</h2>
                <ul className="mk-points">
                  {them.ourEdge.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            </div>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-shell">
          <h2 className="mk-compare__heading">{copy.tableHeading}</h2>
          <CompareTable copy={copy} competitors={[competitor]} />
          <p className="mk-note mk-compare__table-note">{copy.tableNote}</p>

          <ComparePlanDetails copy={copy} locale={locale} apps={["contentpilot", competitor]} />

          <div className="mk-compare-detail">
            <section className="mk-compare-detail__verdict">
              <h2>{copy.verdictHeading}</h2>
              <p>{them.verdict}</p>
            </section>
          </div>

          <CompareDisclaimer copy={copy} />

          <nav className="mk-compare-others" aria-label={copy.otherComparisons}>
            <h2>{copy.otherComparisons}</h2>
            <ul>
              {others.map((id) => (
                <li key={id}>
                  <Link className="mk-arrow" to={localizedPath(locale, comparePath(id))}>
                    {copy.vsTitle.replace("{name}", COMPETITOR_NAMES[id])}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>

      <MarketingCta t={t} locale={locale} />
    </>
  );
}
