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

import { Link, Outlet, isRouteErrorResponse, useLocation, useRouteError } from "react-router";
import "../styles/marketing.css";
import { getMarketingTranslation } from "../i18n/marketing";
import { MARKETING_SITE } from "../config/marketing-site";
import {
  MARKETING_LOCALES,
  MARKETING_LOCALE_LABELS,
  localizedPath,
  stripMarketingLocalePrefix,
  type MarketingLocale,
} from "../services/marketing-locale.shared";

/**
 * Where "install" goes, in one place.
 *
 * The App Store listing once it exists, and the app's own install form until
 * then — every caller asks this rather than carrying its own `?? fallback`,
 * because a button that silently points at a listing which is not published
 * yet is a dead end the merchant reports as a broken site.
 */
function InstallLink({
  locale,
  className,
  children,
}: {
  locale: MarketingLocale;
  className?: string;
  children: React.ReactNode;
}) {
  if (MARKETING_SITE.appStoreUrl) {
    return (
      <a className={className} href={MARKETING_SITE.appStoreUrl}>
        {children}
      </a>
    );
  }
  return (
    <Link className={className} to={localizedPath(locale, "/install")}>
      {children}
    </Link>
  );
}

/**
 * Header, footer and the marketing theme around whatever the route renders.
 *
 * Shared with the ErrorBoundary below, and that sharing is the point: a route
 * boundary REPLACES the element of the route it is declared on, so a boundary
 * that rendered only a message would drop the header and the footer and hand
 * a lost visitor a page with no way back.
 */
function PublicChrome({ children }: { children: React.ReactNode }) {
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

            {/* The site's ONE call to action. `/app` is deliberately not
                offered: it only works from inside the Shopify admin, so a
                visitor who could use it is already there, and everyone else
                gets a blank App Bridge bounce page. */}
            <InstallLink locale={locale} className="mk-btn mk-btn--primary">
              {t.nav.install}
            </InstallLink>
          </nav>
        </div>
      </header>

      <main className="mk-main">{children}</main>

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
              <InstallLink locale={locale}>{t.nav.install}</InstallLink>
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

export default function PublicLayout() {
  return (
    <PublicChrome>
      <Outlet />
    </PublicChrome>
  );
}

/**
 * Every public error lands here: the 404 the `($lang)` gate throws for an
 * unknown segment, and anything a child loader fails on. Without it they
 * rendered root.tsx's admin-styled error page — a Polaris-green "App
 * Unavailable" screen with no way back to the website.
 */
export function ErrorBoundary() {
  // Unconditional, and NOT inside a try/catch — see the note on root.tsx's
  // boundary: React re-invokes component functions to build a stack, and a
  // hook caught there is reported as an app failure that never happened.
  const error = useRouteError();
  const location = useLocation();
  const { locale } = stripMarketingLocalePrefix(location.pathname);
  const t = getMarketingTranslation(locale);

  const isNotFound = isRouteErrorResponse(error) && error.status === 404;
  const copy = isNotFound ? t.notFound : t.error;

  return (
    <PublicChrome>
      <section className="mk-shell mk-empty">
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        <Link className="mk-btn mk-btn--primary" to={localizedPath(locale, "/")}>
          {t.notFound.action}
        </Link>
      </section>
    </PublicChrome>
  );
}
