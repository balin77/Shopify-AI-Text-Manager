import { Link } from "react-router";
import { MARKETING_SITE } from "../../config/marketing-site";
import type { MarketingTranslation } from "../../i18n/marketing";
import { localizedPath, type MarketingLocale } from "../../services/marketing-locale.shared";

/** The closing "see it on your own shop" block, shared by all four pages. */
export function MarketingCta({
  t,
  locale,
}: {
  t: MarketingTranslation;
  locale: MarketingLocale;
}) {
  const label = t.cta.button;

  return (
    <section className="mk-section">
      <div className="mk-shell">
        <div className="mk-cta">
          <h2>{t.cta.title}</h2>
          <p>{t.cta.body}</p>
          {MARKETING_SITE.appStoreUrl ? (
            <a className="mk-btn mk-btn--primary" href={MARKETING_SITE.appStoreUrl}>
              {label}
            </a>
          ) : (
            <Link className="mk-btn mk-btn--primary" to={localizedPath(locale, "/install")}>
              {label}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
