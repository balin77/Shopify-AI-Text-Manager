import { redirect } from "react-router";
import {
  classifyMarketingLocaleParam,
  localizedPath,
  MARKETING_DEFAULT_LOCALE,
  type MarketingLocale,
} from "../services/marketing-locale.shared";

/**
 * The `($lang)` gate every public route loader runs first.
 *
 * It either hands back the locale, or throws — a 301 to the unprefixed URL for
 * the default locale spelled out, and a 404 for a segment that is not a locale
 * at all. Both throws matter and one place owns them, because getting either
 * wrong is silent: a served `/en/features` is a duplicate of `/features` that
 * also renders App Bridge on a public page, and a served `/foobar` is the
 * landing page at an unbounded set of URLs.
 *
 * `path` is the route's own path WITHOUT a locale prefix (`/`, `/features`).
 */
export function requireMarketingLocale(
  param: string | undefined,
  path: string,
  search = "",
): MarketingLocale {
  const verdict = classifyMarketingLocaleParam(param);

  if (verdict.kind === "default") {
    throw redirect(`${localizedPath(MARKETING_DEFAULT_LOCALE, path)}${search}`, 301);
  }

  if (verdict.kind === "unknown") {
    throw new Response("Not Found", { status: 404 });
  }

  return verdict.locale;
}

/**
 * The origin every canonical, hreflang, sitemap and structured-data URL of the
 * public site is built from.
 *
 * `PUBLIC_SITE_URL` (e.g. `https://contentpilot.ai`) wins when it is set: the
 * same pages are reachable on the Railway host AND on any custom domain, and a
 * canonical that follows whichever host the crawler happened to use tells a
 * search engine the site exists twice. Without the variable the request's own
 * origin is used — which is what the site did before this existed. A value that
 * does not parse as an http(s) URL is ignored rather than published.
 */
export function marketingOrigin(url: URL): string {
  const configured = process.env.PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.origin;
    } catch {
      // fall through to the request's origin
    }
  }
  return url.origin;
}

/**
 * `/features/` and `/features` are the same page under two URLs. One 301 to
 * the bare form keeps a crawler from indexing both; the query string travels
 * along (a campaign link must keep its parameters).
 */
export function redirectTrailingSlash(url: URL): void {
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    throw redirect(`${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`, 301);
  }
}
