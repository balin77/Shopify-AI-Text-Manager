/**
 * robots.txt for the APP's own domain — not the merchant's storefront (that
 * one is a theme file and lives in app/services/seo/, managed per shop).
 *
 * The public website is the only part of this host worth crawling. Everything
 * else is either behind a Shopify session (/app), behind a password (/admin),
 * or a machine endpoint (/api, /webhooks, /proxy, /auth) — a crawler that
 * follows them gets a redirect or a 401 and spends the shop's crawl budget on
 * nothing.
 */

import type { LoaderFunctionArgs } from "react-router";

const DISALLOWED = ["/app", "/admin", "/api", "/auth", "/webhooks", "/proxy"];

/**
 * `Disallow` is a PREFIX match, so `/app` also covers `/app-icon.png` — the
 * logo in the site header and the favicon. An `Allow` line wins over a
 * `Disallow` by longest match, which is what puts the one public file back.
 */
const ALLOWED = ["/app-icon.png"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { origin } = new URL(request.url);

  const body = [
    "User-agent: *",
    ...ALLOWED.map((path) => `Allow: ${path}`),
    ...DISALLOWED.map((path) => `Disallow: ${path}`),
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
