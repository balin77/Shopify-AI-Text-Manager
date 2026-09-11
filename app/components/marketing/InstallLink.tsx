import { Link } from "react-router";
import { MARKETING_SITE } from "../../config/marketing-site";
import { localizedPath, type MarketingLocale } from "../../services/marketing-locale.shared";

/**
 * Where "install" goes — in ONE place.
 *
 * The App Store listing once it exists, and the app's own `/install` form
 * until then. Every caller asks this rather than carrying its own
 * `appStoreUrl ?? "/install"` branch: a second copy is how half the buttons
 * end up still pointing at a listing that was never published, which a
 * merchant reports as a broken site.
 */
export function InstallLink({
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
