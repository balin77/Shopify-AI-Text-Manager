import { MARKETING_SITE } from "../config/marketing-site";
import type { MarketingTranslation } from "../i18n/marketing";
import { localizedPath, type MarketingLocale } from "../services/marketing-locale.shared";

/**
 * schema.org structured data for the PUBLIC website, one builder per node.
 *
 * Every node is built from facts this site already states in its copy or in
 * marketing-site.ts — nothing is invented for the markup. That is why the
 * software node carries no `offers` and no `aggregateRating`: the prices live
 * in the App Store listing and would drift here, and a rating nobody measured
 * is exactly the fabricated markup Google penalises.
 *
 * The nodes reference each other by `@id` (`<origin>/#organization`), so a
 * crawler merges them into one graph instead of reading three unrelated
 * organisations off three pages.
 */

type Node = Record<string, unknown>;

const orgId = (origin: string) => `${origin}/#organization`;
const siteId = (origin: string) => `${origin}/#website`;

export function organizationLd(origin: string): Node {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": orgId(origin),
    name: MARKETING_SITE.companyName,
    url: `${origin}/`,
    logo: `${origin}/app-icon.png`,
    email: MARKETING_SITE.supportEmail,
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: MARKETING_SITE.supportEmail,
      availableLanguage: ["en", "de", "es"],
    },
  };
}

export function websiteLd(origin: string, locale: MarketingLocale, t: MarketingTranslation): Node {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": siteId(origin),
    name: t.site.name,
    url: `${origin}${localizedPath(locale, "/")}`,
    description: t.site.description,
    inLanguage: locale,
    publisher: { "@id": orgId(origin) },
  };
}

export function softwareApplicationLd(
  origin: string,
  locale: MarketingLocale,
  t: MarketingTranslation,
): Node {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: MARKETING_SITE.appName,
    description: t.site.description,
    url: `${origin}${localizedPath(locale, "/")}`,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web (Shopify admin)",
    inLanguage: locale,
    image: `${origin}/app-icon.png`,
    publisher: { "@id": orgId(origin) },
    ...(MARKETING_SITE.appStoreUrl ? { installUrl: MARKETING_SITE.appStoreUrl } : {}),
  };
}

/** The FAQ exactly as the landing page renders it — questions and answers verbatim. */
export function faqLd(t: MarketingTranslation): Node {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: t.faq.items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

export function breadcrumbLd(items: Array<{ name: string; url: string }>): Node {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * One guide topic. `TechArticle` is the schema.org type for how-to
 * documentation of a product; `about` names the app so the article is tied to
 * the software node rather than floating on its own.
 */
export function guideArticleLd(input: {
  origin: string;
  locale: MarketingLocale;
  url: string;
  headline: string;
  description: string;
  section: string;
}): Node {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: input.headline,
    description: input.description,
    url: input.url,
    mainEntityOfPage: input.url,
    inLanguage: input.locale,
    articleSection: input.section,
    isPartOf: { "@id": siteId(input.origin) },
    publisher: { "@id": orgId(input.origin) },
    about: { "@type": "SoftwareApplication", name: MARKETING_SITE.appName },
  };
}
