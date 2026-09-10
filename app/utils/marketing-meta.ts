import type { MetaDescriptor } from "react-router";
import {
  MARKETING_DEFAULT_LOCALE,
  MARKETING_LOCALES,
  localizedPath,
  type MarketingLocale,
} from "../services/marketing-locale.shared";

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

  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: canonical },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: siteName },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: canonical },
    { property: "og:locale", content: locale },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    ...alternates,
  ];
}
