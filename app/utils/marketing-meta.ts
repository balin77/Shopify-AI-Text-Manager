import type { MetaDescriptor } from "react-router";
import {
  MARKETING_DEFAULT_LOCALE,
  MARKETING_LOCALES,
  localizedPath,
  type MarketingLocale,
} from "../services/marketing-locale.shared";

/**
 * Open Graph wants `language_TERRITORY`, not a bare language code: a bare
 * `de` is not a value the spec defines, and consumers fall back to `en_US` —
 * so the German page's share preview announced itself as English.
 */
const OG_LOCALES: Record<MarketingLocale, string> = {
  en: "en_US",
  de: "de_DE",
  es: "es_ES",
};

/**
 * The share image.
 *
 * The app icon is a 512x512 square, which is what `summary` is FOR.
 * `summary_large_image` was declared here first and there is no 1200x630
 * artwork to back it — a large card with no image renders as an empty box, so
 * the card type follows the asset rather than the other way round. Replace
 * both when a real OG image exists.
 */
const SHARE_IMAGE_PATH = "/app-icon.png";
const SHARE_IMAGE_SIZE = "512";

interface MarketingMetaInput {
  /** Absolute origin of the request, e.g. `https://app.example.com`. */
  origin: string;
  locale: MarketingLocale;
  /** Path WITHOUT the locale prefix, e.g. `/features`. */
  path: string;
  title: string;
  description: string;
  siteName: string;
}

/**
 * Title, description, Open Graph, canonical and hreflang for one public page.
 *
 * The hreflang set names every locale AND `x-default`, and every URL is
 * absolute: a relative `alternate` is ignored by search engines, and a set
 * that omits `x-default` leaves them guessing which spelling to show a visitor
 * whose language is none of the three.
 */
export function buildMarketingMeta({
  origin,
  locale,
  path,
  title,
  description,
  siteName,
}: MarketingMetaInput): MetaDescriptor[] {
  const canonical = `${origin}${localizedPath(locale, path)}`;

  const alternates: MetaDescriptor[] = MARKETING_LOCALES.map((alt) => ({
    tagName: "link",
    rel: "alternate",
    hrefLang: alt,
    href: `${origin}${localizedPath(alt, path)}`,
  }));

  alternates.push({
    tagName: "link",
    rel: "alternate",
    hrefLang: "x-default",
    href: `${origin}${localizedPath(MARKETING_DEFAULT_LOCALE, path)}`,
  });

  const shareImage = `${origin}${SHARE_IMAGE_PATH}`;

  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: canonical },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: siteName },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: canonical },
    { property: "og:locale", content: OG_LOCALES[locale] },
    ...MARKETING_LOCALES.filter((alt) => alt !== locale).map((alt) => ({
      property: "og:locale:alternate",
      content: OG_LOCALES[alt],
    })),
    { property: "og:image", content: shareImage },
    { property: "og:image:width", content: SHARE_IMAGE_SIZE },
    { property: "og:image:height", content: SHARE_IMAGE_SIZE },
    { property: "og:image:alt", content: siteName },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: shareImage },
    ...alternates,
  ];
}
