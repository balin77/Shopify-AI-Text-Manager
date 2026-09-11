import type { MarketingTranslation } from "../../i18n/marketing";
import type { MarketingLocale } from "../../services/marketing-locale.shared";
import { InstallLink } from "./InstallLink";

/** The closing "see it on your own shop" block, shared by the three content pages. */
export function MarketingCta({
  t,
  locale,
}: {
  t: MarketingTranslation;
  locale: MarketingLocale;
}) {
  return (
    <section className="mk-section">
      <div className="mk-shell">
        <div className="mk-cta">
          <h2>{t.cta.title}</h2>
          <p>{t.cta.body}</p>
          <InstallLink locale={locale} className="mk-btn mk-btn--primary">
            {t.cta.button}
          </InstallLink>
        </div>
      </div>
    </section>
  );
}
