import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { MARKETING_SITE } from "../config/marketing-site";
import { buildMarketingMeta } from "../utils/marketing-meta";
import { resolveMarketingLocale } from "../services/marketing-locale.shared";
import { MarketingCta } from "../components/marketing/MarketingCta";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const locale = resolveMarketingLocale(params.lang);
  if (!locale) throw new Response("Not Found", { status: 404 });
  return { locale, origin: new URL(request.url).origin };
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
      <section className="mk-section">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h1>{t.features.title}</h1>
            <p className="mk-lead">{t.features.intro}</p>
          </div>

          {t.features.groups.map((group) => (
            <section className="mk-feature" key={group.id} id={group.id}>
              <div className="mk-feature__intro">
                <h3>{group.title}</h3>
                <p>{group.body}</p>
              </div>
              <ul className="mk-points">
                {group.points.map((point) => (
                  <li key={point}>
                    <span />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </section>

      <MarketingCta t={t} />
    </>
  );
}
