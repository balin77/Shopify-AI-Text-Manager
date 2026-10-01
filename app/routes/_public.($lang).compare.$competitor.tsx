import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { getCompareCopy } from "../i18n/marketing/compare";
import { MARKETING_SITE } from "../config/marketing-site";
import {
  COMPARE_TOPICS,
  COMPETITOR_NAMES,
  comparePath,
  isCompetitorId,
  topicBySlug,
  topicOfCompetitor,
  topicPath,
} from "../config/marketing-compare";
import { breadcrumbLd } from "../utils/marketing-jsonld";
import { buildMarketingMeta } from "../utils/marketing-meta";
import {
  marketingOrigin,
  redirectTrailingSlash,
  requireMarketingLocale,
} from "../utils/marketing-route.server";
import { localizedPath } from "../services/marketing-locale.shared";
import { CompareDisclaimer, CompareMatrix } from "../components/marketing/CompareTable";
import { CompareTopicPage, topicHeading } from "../components/marketing/CompareTopicPage";
import { MarketingCta } from "../components/marketing/MarketingCta";
import { comparePreviewAllowed } from "../utils/marketing-compare-preview.server";

/**
 * `/compare/<segment>` is two kinds of page: a comparison TOPIC (`seo`,
 * `ai-content`, `variant-images`) or ONE competitor. The slugs cannot collide
 * — a test pins that no competitor id is a topic slug.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  redirectTrailingSlash(url);
  // Locale gate first, with the real path, like the guide's topic route.
  const locale = requireMarketingLocale(params.lang, `/compare/${params.competitor ?? ""}`, url.search);
  const preview = comparePreviewAllowed(url);
  const notFound = () => new Response("Not Found", { status: 404 });

  const topic = topicBySlug(params.competitor);
  if (topic) {
    if (!COMPARE_TOPICS[topic].published && !preview) throw notFound();
    return { kind: "topic" as const, locale, origin: marketingOrigin(url), topic, preview };
  }

  const competitor = params.competitor;
  if (!isCompetitorId(competitor)) throw notFound();
  // A competitor gets a page once its topic is published and its copy is
  // written — both happen after its facts are researched.
  const competitorTopic = topicOfCompetitor(competitor);
  if (!COMPARE_TOPICS[competitorTopic].published && !preview) throw notFound();
  if (!getCompareCopy(locale).competitors[competitor]) throw notFound();
  return { kind: "competitor" as const, locale, origin: marketingOrigin(url), competitor, topic: competitorTopic, preview };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  const copy = getCompareCopy(data.locale);
  const noindex = COMPARE_TOPICS[data.topic].published ? [] : [{ name: "robots", content: "noindex" }];
  const home = { name: t.site.name, url: `${data.origin}${localizedPath(data.locale, "/")}` };
  const compareCrumb = { name: t.nav.compare, url: `${data.origin}${localizedPath(data.locale, "/compare")}` };

  if (data.kind === "topic") {
    const { title, intro } = topicHeading(copy, data.topic);
    const path = topicPath(data.topic);
    return [
      ...buildMarketingMeta({
        origin: data.origin,
        locale: data.locale,
        path,
        title: `${title} — ${t.site.name}`,
        description: intro,
        siteName: t.site.name,
        jsonLd: [
          breadcrumbLd([
            home,
            compareCrumb,
            { name: copy.topics.items[data.topic].tab, url: `${data.origin}${localizedPath(data.locale, path)}` },
          ]),
        ],
      }),
      ...noindex,
    ];
  }

  const name = COMPETITOR_NAMES[data.competitor];
  const pageUrl = `${data.origin}${localizedPath(data.locale, comparePath(data.competitor))}`;
  return [
    ...buildMarketingMeta({
      origin: data.origin,
      locale: data.locale,
      path: comparePath(data.competitor),
      title: copy.vsMetaTitle.replace("{name}", name),
      description: copy.competitors[data.competitor]?.summary ?? "",
      siteName: t.site.name,
      jsonLd: [breadcrumbLd([home, compareCrumb, { name: copy.vsTitle.replace("{name}", name), url: pageUrl }])],
    }),
    ...noindex,
  ];
};

export default function MarketingCompareSegment() {
  const data = useLoaderData<typeof loader>();
  if (data.kind === "topic") {
    const t = getMarketingTranslation(data.locale);
    return (
      <>
        <CompareTopicPage copy={getCompareCopy(data.locale)} locale={data.locale} topic={data.topic} preview={data.preview} />
        <MarketingCta t={t} locale={data.locale} />
      </>
    );
  }
  return <MarketingCompareOne />;
}

/**
 * `/compare/<app>` — ContentPilot against ONE app: the table narrowed to two
 * columns, then what the other app does well, what we add, the pricing models
 * side by side and a plain verdict. The page is written to be fair — the
 * "where it is strong" list comes before ours on purpose.
 */
function MarketingCompareOne() {
  const data = useLoaderData<typeof loader>();
  if (data.kind !== "competitor") return null;
  const { locale, competitor, topic } = data;
  const t = getMarketingTranslation(locale);
  const copy = getCompareCopy(locale);
  // The loader refuses a competitor without copy, so this is always set.
  const them = copy.competitors[competitor]!;
  const name = COMPETITOR_NAMES[competitor];
  const fill = (text: string) => text.replace("{name}", name);
  // Other comparisons of the SAME topic: a Weglot page links translation apps.
  const others = COMPARE_TOPICS[topic].competitors.filter((id) => id !== competitor && copy.competitors[id]);

  return (
    <>
      <section className="mk-section mk-section--first">
        <div className="mk-shell">
          <nav className="mk-guide__crumbs" aria-label={t.nav.compare}>
            <Link to={localizedPath(locale, topicPath(topic))}>{copy.allComparisons}</Link>
          </nav>
          <div className="mk-section__head">
            <h1>{fill(copy.vsTitle)}</h1>
            <p className="mk-lead">{them.summary}</p>
          </div>

          <CompareMatrix copy={copy} locale={locale} topic={topic} apps={["contentpilot", competitor]} />

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
