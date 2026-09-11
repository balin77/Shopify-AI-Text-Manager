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
