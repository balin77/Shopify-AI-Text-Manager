/**
 * Layout of the PUBLIC website — everything a visitor sees without a Shopify
 * session. Pathless (`_public`), so its children keep the bare URLs `/`,
 * `/features`, `/videos` and their `/de` + `/es` prefixes.
 *
 * It deliberately loads NO Polaris and NO App Bridge: Polaris is admin chrome
 * (root.tsx no longer imports its stylesheet, app/routes/app.tsx does), and
 * App Bridge on a page that is not inside the Shopify admin iframe hijacks
 * navigation — the same reason `/admin` has always been excluded from it.
 */

import { Link, Outlet, useLocation } from "react-router";
import "../styles/marketing.css";
import { getMarketingTranslation } from "../i18n/marketing";
import { MARKETING_SITE } from "../config/marketing-site";
import {
  MARKETING_LOCALES,
  MARKETING_LOCALE_LABELS,
  localizedPath,
  stripMarketingLocalePrefix,
} from "../services/marketing-locale.shared";

export default function PublicLayout() {
  const location = useLocation();
  // Derived from the URL rather than from a loader: the layout is pathless, so
  // it never matches the `($lang)` segment itself, and the pathname is the one
  // thing server and client agree on before hydration.
  const { locale, rest } = stripMarketingLocalePrefix(location.pathname);
  const t = getMarketingTranslation(locale);

  const navItems = [
    { to: localizedPath(locale, "/features"), label: t.nav.features },
    { to: localizedPath(locale, "/videos"), label: t.nav.videos },
  ];

  return (
    <div className="mk">
      <header className="mk-header">
        <div className="mk-shell mk-header__inner">
          <Link to={localizedPath(locale, "/")} className="mk-brand">
            <img src="/app-icon.png" alt="" width={28} height={28} />
            <span>{t.site.name}</span>
          </Link>

          <nav className="mk-nav" aria-label={t.nav.menu}>
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                aria-current={location.pathname === item.to ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}

            <div className="mk-lang" role="group" aria-label={t.nav.language}>
              {MARKETING_LOCALES.map((alt) => (
                <Link
                  key={alt}
                  to={localizedPath(alt, rest)}
                  hrefLang={alt}
                  aria-current={alt === locale ? "true" : undefined}
                >
                  {alt.toUpperCase()}
                  <span className="mk-visually-hidden"> {MARKETING_LOCALE_LABELS[alt]}</span>
                </Link>
              ))}
            </div>

            <a className="mk-btn mk-btn--primary" href={MARKETING_SITE.appPath}>
              {t.nav.openApp}
            </a>
          </nav>
        </div>
      </header>

      <main className="mk-main">
        <Outlet />
      </main>

      <footer className="mk-footer">
        <div className="mk-shell">
          <div className="mk-footer__cols">
            <div className="mk-footer__col">
              <strong>{t.site.name}</strong>
              <p className="mk-note">{t.footer.tagline}</p>
            </div>

            <div className="mk-footer__col">
              <h3>{t.footer.product}</h3>
              <Link to={localizedPath(locale, "/features")}>{t.nav.features}</Link>
              <Link to={localizedPath(locale, "/videos")}>{t.nav.videos}</Link>
              <a href={MARKETING_SITE.appPath}>{t.nav.openApp}</a>
            </div>

            <div className="mk-footer__col">
              <h3>{t.footer.legal}</h3>
              {/* Not localized routes: /privacy and /terms are the URLs the
                  App Store listing points at and must not move. */}
              <a href="/privacy">{t.footer.privacy}</a>
              <a href="/terms">{t.footer.terms}</a>
            </div>

            <div className="mk-footer__col">
              <h3>{t.footer.support}</h3>
              <a href={`mailto:${MARKETING_SITE.supportEmail}`}>{t.footer.contact}</a>
            </div>
          </div>

          <div className="mk-footer__bottom">
            <span>
              &copy; {new Date().getUTCFullYear()} {MARKETING_SITE.companyName}. {t.footer.rights}
            </span>
            <span>{MARKETING_SITE.appName}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
