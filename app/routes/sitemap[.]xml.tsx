/**
 * Sitemap of the public website.
 *
 * Every page is listed once per locale, and each entry carries the full
 * `xhtml:link` alternate set — the same three URLs plus `x-default` that the
 * pages themselves declare. A sitemap whose alternates disagree with the pages'
 * hreflang tags is worse than no sitemap: search engines treat the mismatch as
 * a reason to trust neither.
 */

import type { LoaderFunctionArgs } from "react-router";
import { MARKETING_SITE } from "../config/marketing-site";
import {
  MARKETING_DEFAULT_LOCALE,
  MARKETING_LOCALES,
  localizedPath,
} from "../services/marketing-locale.shared";

/**
 * Localized pages, in the order they should be discovered.
 *
 * `/install` is in the list only while there is no App Store listing. With one
 * it redirects there, and a sitemap that lists a redirect reports a soft error
 * for every locale it names.
 */
const LOCALIZED_PATHS = MARKETING_SITE.appStoreUrl
  ? ["/", "/features", "/videos"]
  : ["/", "/features", "/videos", "/install"];

/** Public but not localized — the URLs the App Store listing points at. */
const PLAIN_PATHS = ["/privacy", "/terms"];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { origin } = new URL(request.url);

  const entries: string[] = [];

  for (const path of LOCALIZED_PATHS) {
    const alternates = [
      ...MARKETING_LOCALES.map((locale) => ({
        hreflang: locale,
        href: `${origin}${localizedPath(locale, path)}`,
      })),
      {
        hreflang: "x-default",
        href: `${origin}${localizedPath(MARKETING_DEFAULT_LOCALE, path)}`,
      },
    ];

    for (const locale of MARKETING_LOCALES) {
      const links = alternates
        .map(
          (alt) =>
            `    <xhtml:link rel="alternate" hreflang="${alt.hreflang}" href="${escapeXml(alt.href)}"/>`,
        )
        .join("\n");

      entries.push(
        [
          "  <url>",
          `    <loc>${escapeXml(`${origin}${localizedPath(locale, path)}`)}</loc>`,
          links,
          `    <priority>${path === "/" ? "1.0" : "0.8"}</priority>`,
          "  </url>",
        ].join("\n"),
      );
    }
  }

  for (const path of PLAIN_PATHS) {
    entries.push(
      ["  <url>", `    <loc>${escapeXml(`${origin}${path}`)}</loc>`, "    <priority>0.3</priority>", "  </url>"].join(
        "\n",
      ),
    );
  }

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
