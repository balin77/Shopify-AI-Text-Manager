/**
 * Which language the public website is being read in.
 *
 * Client-safe and import-free on purpose: the route modules, the layout and
 * the language switcher all need it, and the switcher renders in component
 * scope (see the `activationGate` rule in CLAUDE.md — one server import there
 * pulls a server module into the client bundle and `npm run build` refuses it).
 *
 * The default locale is served WITHOUT a prefix (`/features`), every other one
 * under its own (`/de/features`). That asymmetry is deliberate: the App Store
 * listing links the bare URLs, and a redirect from `/` to `/en/` would make
 * every one of those links a hop.
 */

export const MARKETING_LOCALES = ["en", "de", "es"] as const;

export type MarketingLocale = (typeof MARKETING_LOCALES)[number];

/**
 * The locale served at the bare path. Changing this ONE constant moves the
 * whole site: `/features` becomes German and English moves to `/en/features`.
 */
export const MARKETING_DEFAULT_LOCALE: MarketingLocale = "en";

/** Locale name in its own language — a switcher that says "German" to a German is useless. */
export const MARKETING_LOCALE_LABELS: Record<MarketingLocale, string> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
};

export function isMarketingLocale(value: string | undefined): value is MarketingLocale {
  return typeof value === "string" && (MARKETING_LOCALES as readonly string[]).includes(value);
}

/**
 * Resolve the `($lang)` route param.
 *
 * Returns `null` for a segment that is not a locale, and the caller MUST turn
 * that into a 404. The optional segment matches ANY single path segment, so
 * `/foobar` reaches the index route with `lang: "foobar"` — without the refusal
 * every typo on the domain would render the landing page under its own URL and
 * hand search engines an unbounded set of duplicates.
 */
export function resolveMarketingLocale(param: string | undefined): MarketingLocale | null {
  if (param === undefined) return MARKETING_DEFAULT_LOCALE;
  return isMarketingLocale(param) ? param : null;
}

/** `/features` in the default locale, `/de/features` in every other. */
export function localizedPath(locale: MarketingLocale, path: string): string {
  const clean = path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;
  if (locale === MARKETING_DEFAULT_LOCALE) return clean || "/";
  return `/${locale}${clean}`;
}

/**
 * Best guess from the browser's `Accept-Language`, used ONLY to offer a hint —
 * never to redirect. An automatic redirect off `/` would bounce every App
 * Store visitor whose browser is set to something else than the listing they
 * clicked, and it makes the canonical URL depend on who is asking.
 */
export function preferredLocaleFromHeader(header: string | null): MarketingLocale | null {
  if (!header) return null;
  const tags = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      const quality = q ? Number.parseFloat(q.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of tags) {
    const base = tag.split("-")[0];
    if (isMarketingLocale(base)) return base;
  }
  return null;
}

/**
 * The public website's own paths, WITHOUT a locale prefix.
 *
 * `/privacy` and `/terms` are in the list although they are not part of the
 * localized route tree: what this answers is "is this page served to the
 * public", and the two callers of it — the `<html lang>` and the App Bridge
 * gate in root.tsx — need the same answer for all five.
 */
const MARKETING_PATHS = new Set(["/", "/features", "/videos", "/privacy", "/terms"]);

/** Strip a leading `/de` or `/es`; the default locale carries no prefix. */
export function stripMarketingLocalePrefix(pathname: string): {
  locale: MarketingLocale;
  rest: string;
} {
  const match = /^\/([a-z]{2})(?=\/|$)/i.exec(pathname);
  const candidate = match?.[1]?.toLowerCase();
  if (candidate && isMarketingLocale(candidate) && candidate !== MARKETING_DEFAULT_LOCALE) {
    const rest = pathname.slice(match![0].length) || "/";
    return { locale: candidate, rest };
  }
  return { locale: MARKETING_DEFAULT_LOCALE, rest: pathname };
}

/**
 * Is this URL a page of the public website?
 *
 * Used by root.tsx to decide the document language and to keep App Bridge OFF
 * — a public page is not embedded in the Shopify admin, and App Bridge there
 * hijacks navigation (the same reason `/admin` has been excluded since it was
 * built).
 */
export function isMarketingPath(pathname: string): boolean {
  const withoutTrailingSlash =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const { rest } = stripMarketingLocalePrefix(withoutTrailingSlash);
  return MARKETING_PATHS.has(rest);
}

/** The document language for a URL, for `<html lang>`. */
export function documentLanguageForPath(pathname: string): MarketingLocale {
  return stripMarketingLocalePrefix(pathname).locale;
}
