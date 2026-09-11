import { MARKETING_SITE } from "../../config/marketing-site";
import type { MarketingTranslation } from "../../i18n/marketing";

/** The closing "see it on your own shop" block, shared by all three pages. */
export function MarketingCta({ t }: { t: MarketingTranslation }) {
  return (
    <section className="mk-section">
      <div className="mk-shell">
        <div className="mk-cta">
          <h2>{t.cta.title}</h2>
          <p>{t.cta.body}</p>
          <a
            className="mk-btn mk-btn--primary"
            href={MARKETING_SITE.appStoreUrl ?? MARKETING_SITE.appPath}
          >
            {t.cta.button}
          </a>
        </div>
      </div>
    </section>
  );
}
