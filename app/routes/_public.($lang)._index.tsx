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
import { MediaSlot } from "../components/marketing/MediaSlot";
import { ScrollStory } from "../components/marketing/ScrollStory";
import { InstallLink } from "../components/marketing/InstallLink";

/**
 * Query parameters that mean "Shopify is opening the app", not "a person is
 * visiting the website". Shopify loads the embedded app at the app URL itself,
 * which is this route — so the redirect app/routes/_index.tsx used to own has
 * to live here, or installing the app renders a marketing page inside the
 * admin iframe and the OAuth handshake never starts.
 */
const SHOPIFY_ENTRY_PARAMS = ["shop", "host", "embedded", "id_token", "session", "hmac"];

/** The three pillars, in order, and the image slot each one tells its story with. */
const PILLAR_SLOTS = ["pillar-writes", "pillar-translates", "pillar-found"] as const;

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
  const appStoreUrl = MARKETING_SITE.appStoreUrl;

  // `pillars.items` is typed as a 3-tuple (en.ts), so this zip cannot run
  // past the slots: a fourth pillar fails typecheck rather than silently
  // reusing the last image and producing two React keys of the same name.
  const steps = PILLAR_SLOTS.map((slot, index) => ({
    slot,
    title: t.pillars.items[index].title,
    body: t.pillars.items[index].body,
  }));

  return (
    <>
      <section className="mk-hero">
        <div className="mk-shell mk-hero__grid">
          <div className="mk-hero__copy">
            {/* The one proof this site has that no brochure does: the app IS
                in the store. A badge that links to the listing says it
                without a number that could be wrong. */}
            {appStoreUrl ? (
              <a className="mk-badge" href={appStoreUrl}>
                <span className="mk-badge__dot" aria-hidden="true" />
                {t.hero.storeBadge}
              </a>
            ) : (
              <span className="mk-badge">{t.hero.eyebrow}</span>
            )}
            <h1>{t.hero.title}</h1>
            <p className="mk-hero__sub">{t.hero.subtitle}</p>
            <div className="mk-hero__actions">
              <InstallLink locale={locale} className="mk-btn mk-btn--primary">
                {t.nav.install}
              </InstallLink>
              <Link className="mk-btn mk-btn--ghost" to={localizedPath(locale, "/features")}>
                {t.hero.ctaPrimary}
              </Link>
            </div>
            <p className="mk-hero__note">{t.hero.note}</p>
          </div>
          <div className="mk-hero__media">
            <MediaSlot slot="hero" t={t} aspect="4 / 3" />
          </div>
        </div>
      </section>

      <section className="mk-section" id="pillars">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h2>{t.pillars.title}</h2>
          </div>
          <ScrollStory steps={steps} t={t} />
          <p className="mk-section__more">
            <Link to={localizedPath(locale, "/features")} className="mk-arrow">
              {t.pillars.more}
            </Link>
          </p>
        </div>
      </section>

      <section className="mk-section" id="faq">
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
