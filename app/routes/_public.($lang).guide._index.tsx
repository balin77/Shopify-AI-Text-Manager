import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { getGuideCopy } from "../i18n/marketing/guide";
import { MARKETING_SITE } from "../config/marketing-site";
import { GUIDE_CATEGORIES, GUIDE_VIDEOS, guideTopicPath } from "../config/marketing-guide";
import { breadcrumbLd } from "../utils/marketing-jsonld";
import { buildMarketingMeta } from "../utils/marketing-meta";
import {
  marketingOrigin,
  redirectTrailingSlash,
  requireMarketingLocale,
} from "../utils/marketing-route.server";
import { localizedPath } from "../services/marketing-locale.shared";
import { MarketingCta } from "../components/marketing/MarketingCta";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  redirectTrailingSlash(url);
  const locale = requireMarketingLocale(params.lang, "/guide", url.search);
  return { locale, origin: marketingOrigin(url) };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: "/guide",
    title: `${t.guide.title} — ${t.site.name}`,
    description: t.guide.intro,
    siteName: t.site.name,
    jsonLd: [
      breadcrumbLd([
        { name: t.site.name, url: `${data.origin}${localizedPath(data.locale, "/")}` },
        { name: t.guide.title, url: `${data.origin}${localizedPath(data.locale, "/guide")}` },
      ]),
    ],
  });
};

/**
 * `/guide` — every topic of the guide, grouped by category.
 *
 * The page is an index and nothing more: each card links to its topic page,
 * where the text and the video live. A card says whether its video is out yet,
 * so a visitor who came for a walkthrough knows before clicking.
 */
export default function MarketingGuide() {
  const { locale } = useLoaderData<typeof loader>();
  const t = getMarketingTranslation(locale);
  const guide = getGuideCopy(locale);

  return (
    <>
      <section className="mk-section mk-section--first">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h1>{t.guide.title}</h1>
            <p className="mk-lead">{t.guide.intro}</p>
          </div>

          <nav className="mk-chips" aria-label={t.guide.title}>
            {GUIDE_CATEGORIES.map((category) => (
              <a key={category.id} href={`#${category.id}`}>
                {guide.categories[category.id].title}
              </a>
            ))}
          </nav>
        </div>
      </section>

      <div className="mk-shell mk-guide-index">
        {GUIDE_CATEGORIES.map((category) => {
          const copy = guide.categories[category.id];
          return (
            <section className="mk-guide-category" key={category.id} id={category.id}>
              <div className="mk-guide-category__head">
                <h2>{copy.title}</h2>
                <p>{copy.intro}</p>
                <span className="mk-note">
                  {t.guide.topicCount.replace("{count}", String(category.topics.length))}
                </span>
              </div>

              <ul className="mk-guide-topics">
                {category.topics.map((topic) => {
                  const topicCopy = guide.topics[topic];
                  const hasVideo = GUIDE_VIDEOS[topic] !== null;
                  return (
                    <li key={topic}>
                      <Link className="mk-guide-topic" to={localizedPath(locale, guideTopicPath(topic))}>
                        <span className="mk-guide-topic__title">{topicCopy.title}</span>
                        <span className="mk-guide-topic__summary">{topicCopy.summary}</span>
                        <span className={`mk-guide-badge${hasVideo ? " mk-guide-badge--ready" : ""}`}>
                          <span aria-hidden="true">&#9654;</span>
                          {hasVideo ? t.guide.videoBadge : t.guide.videoPendingBadge}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <MarketingCta t={t} locale={locale} />
    </>
  );
}
