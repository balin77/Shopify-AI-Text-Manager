import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { MARKETING_SITE } from "../config/marketing-site";
import { buildMarketingMeta } from "../utils/marketing-meta";
import {
  marketingOrigin,
  redirectTrailingSlash,
  requireMarketingLocale,
} from "../utils/marketing-route.server";
import { MarketingCta } from "../components/marketing/MarketingCta";
import { VideoSlot } from "../components/marketing/VideoSlot";
import type { GuideCategoryId } from "../config/marketing-guide";
import { localizedPath } from "../services/marketing-locale.shared";

/**
 * Where each feature block is explained step by step. A feature page that
 * links into the guide passes its visitors (and a crawler) straight to the
 * how-to, instead of leaving the guide reachable from the nav alone.
 */
const GUIDE_CATEGORY_FOR_FEATURE: Record<string, GuideCategoryId> = {
  ai: "ai-content",
  translations: "translations",
  bulk: "bulk",
  seo: "seo",
  aeo: "ai-visibility",
  media: "media",
  structure: "translations",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  redirectTrailingSlash(url);
  const locale = requireMarketingLocale(params.lang, "/features", url.search);
  return { locale, origin: marketingOrigin(url) };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: "/features",
    title: `${t.features.title} — ${t.site.name}`,
    description: t.features.intro,
    siteName: t.site.name,
  });
};

export default function MarketingFeatures() {
  const { locale } = useLoaderData<typeof loader>();
  const t = getMarketingTranslation(locale);

  return (
    <>
      <section className="mk-section mk-section--first">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h1>{t.features.title}</h1>
            <p className="mk-lead">{t.features.intro}</p>
            <Link className="mk-arrow" to={localizedPath(locale, "/compare")}>
              {t.features.compareLink}
            </Link>
          </div>

          {/* Anchor row: seven blocks are a lot to scroll blind through. */}
          <nav className="mk-chips" aria-label={t.features.title}>
            {t.features.groups.map((group) => (
              <a key={group.id} href={`#${group.id}`}>
                {group.title}
              </a>
            ))}
          </nav>
        </div>
      </section>

      <div className="mk-shell">
        {t.features.groups.map((group) => (
          <section className="mk-feature" key={group.id} id={group.id}>
            <div className="mk-feature__copy">
              <h2>{group.title}</h2>
              <p className="mk-feature__lead">{group.body}</p>
              <ul className="mk-points">
                {group.points.map((point) => (
                  // ONE child only. The dot is `::before`, which IS a grid
                  // item — an extra empty <span> made three items in a
                  // two-column grid, so the text wrapped into row 2 column 1
                  // and rendered one word per line on a phone.
                  <li key={point}>{point}</li>
                ))}
              </ul>
              {GUIDE_CATEGORY_FOR_FEATURE[group.id] ? (
                <Link
                  className="mk-arrow mk-feature__guide"
                  to={`${localizedPath(locale, "/guide")}#${GUIDE_CATEGORY_FOR_FEATURE[group.id]}`}
                >
                  {t.features.guideLink}
                </Link>
              ) : null}
            </div>
            <div className="mk-feature__media">
              {/* No cast: the group ids are literal in en.ts, so a feature
                  without a video slot fails typecheck. */}
              <VideoSlot slot={`feature-${group.id}`} title={group.title} t={t} />
            </div>
          </section>
        ))}
      </div>

      <MarketingCta t={t} locale={locale} />
    </>
  );
}
