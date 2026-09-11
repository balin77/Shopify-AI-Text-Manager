/**
 * The public landing page, at `/` and `/de` + `/es`.
 *
 * It replaces the old app/routes/_index.tsx, whose only job was to redirect to
 * `/app` — and it KEEPS that redirect for a Shopify request. See the loader.
 */

import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, redirect, useLoaderData } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { MARKETING_SITE } from "../config/marketing-site";
import { buildMarketingMeta } from "../utils/marketing-meta";
import { localizedPath } from "../services/marketing-locale.shared";
import { requireMarketingLocale } from "../utils/marketing-route.server";
import { MarketingCta } from "../components/marketing/MarketingCta";

/**
 * Query parameters that mean "Shopify is opening the app", not "a person is
 * visiting the website". Shopify loads the embedded app at the app URL itself,
 * which is this route — so the redirect app/routes/_index.tsx used to own has
 * to live here, or installing the app renders a marketing page inside the
 * admin iframe and the OAuth handshake never starts.
 */
const SHOPIFY_ENTRY_PARAMS = ["shop", "host", "embedded", "id_token", "session", "hmac"];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (SHOPIFY_ENTRY_PARAMS.some((param) => url.searchParams.has(param))) {
    throw redirect(`${MARKETING_SITE.appPath}${url.search}`);
  }

  const locale = requireMarketingLocale(params.lang, "/", url.search);

  return { locale, origin: url.origin };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: "/",
    title: `${t.site.name} — ${t.site.tagline}`,
    description: t.site.description,
    siteName: t.site.name,
  });
};

export default function MarketingIndex() {
  const { locale } = useLoaderData<typeof loader>();
  const t = getMarketingTranslation(locale);

  return (
    <>
      <section className="mk-hero">
        <div className="mk-shell mk-hero__inner">
          <span className="mk-eyebrow">{t.hero.eyebrow}</span>
          <h1>{t.hero.title}</h1>
          <p className="mk-hero__sub">{t.hero.subtitle}</p>
          <div className="mk-hero__actions">
            <Link className="mk-btn mk-btn--primary" to={localizedPath(locale, "/features")}>
              {t.hero.ctaPrimary}
            </Link>
            <Link className="mk-btn mk-btn--ghost" to={localizedPath(locale, "/videos")}>
              {t.hero.ctaSecondary}
            </Link>
          </div>
          <p className="mk-hero__note">{t.hero.note}</p>
        </div>
      </section>

      <section className="mk-section mk-section--soft">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h2>{t.pillars.title}</h2>
          </div>
          <div className="mk-grid">
            {t.pillars.items.map((item) => (
              <article className="mk-card" key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h2>{t.features.title}</h2>
            <p className="mk-lead">{t.features.intro}</p>
          </div>
          <div className="mk-grid">
            {t.features.groups.map((group) => (
              <article className="mk-card" key={group.id}>
                <h3>{group.title}</h3>
                <p>{group.body}</p>
              </article>
            ))}
          </div>
          <p style={{ marginTop: 28 }}>
            <Link className="mk-btn mk-btn--ghost" to={localizedPath(locale, "/features")}>
              {t.hero.ctaPrimary}
            </Link>
          </p>
        </div>
      </section>

      <section className="mk-section mk-section--soft">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h2>{t.faq.title}</h2>
          </div>
          <div className="mk-faq">
            {t.faq.items.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <MarketingCta t={t} locale={locale} />
    </>
  );
}
