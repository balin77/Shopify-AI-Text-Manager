import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { MARKETING_SITE } from "../config/marketing-site";
import { MARKETING_VIDEOS } from "../config/marketing-videos";
import { buildMarketingMeta } from "../utils/marketing-meta";
import { requireMarketingLocale } from "../utils/marketing-route.server";
import { MarketingCta } from "../components/marketing/MarketingCta";
import { VideoCard } from "../components/marketing/VideoCard";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const locale = requireMarketingLocale(params.lang, "/videos", url.search);
  return { locale, origin: url.origin };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: "/videos",
    title: `${t.videos.title} — ${t.site.name}`,
    description: t.videos.intro,
    siteName: t.site.name,
  });
};

export default function MarketingVideos() {
  const { locale } = useLoaderData<typeof loader>();
  const t = getMarketingTranslation(locale);

  return (
    <>
      <section className="mk-section">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h1>{t.videos.title}</h1>
            <p className="mk-lead">{t.videos.intro}</p>
          </div>

          <div className="mk-grid">
            {MARKETING_VIDEOS.map((video) => (
              <VideoCard key={video.id} video={video} t={t} />
            ))}
          </div>
        </div>
      </section>

      <MarketingCta t={t} />
    </>
  );
}
