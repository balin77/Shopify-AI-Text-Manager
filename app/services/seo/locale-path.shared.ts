/**
 * The ONE rule for "a storefront path may carry a locale prefix".
 *
 * Shopify serves every storefront path under each published locale
 * (`/it/cart`, `/es/policies/refund-policy`, `/en-us/collections/all`), so any
 * rule that matches on a path — the crawl denylist, the expected-`noindex`
 * patterns, the "no editable metadata" list — has to strip that segment first
 * or it silently applies to the primary locale only. That is exactly how
 * `/it/cart` ended up crawled and reported on a multilingual shop while
 * `/cart` was correctly skipped.
 *
 * Client-safe (`.shared`) on purpose: `crawl.service.ts` is server-only, but
 * `onpage.service.ts` and the report components need the same rule, and a
 * hand-copied regex in a second file is how the robots-token bug shipped twice.
 */

/** Matches a leading locale segment: `/de/…`, `/en-us/…`, `/pt-BR/…`. */
const LEADING_LOCALE_RE = /^\/[a-z]{2}(-[a-z]{2,4})?(?=\/)/;

/** `"/it/cart"` → `"/cart"`. Unprefixed paths come back unchanged. */
export function stripLocalePrefix(lowerPath: string): string {
  return lowerPath.replace(LEADING_LOCALE_RE, "");
}

/**
 * Lowercased `path + query` of a URL (or of a bare path), plus the same string
 * with any leading locale segment removed. Callers test their patterns against
 * BOTH: a pattern anchored at `/policies` must match `/es/policies/...`, and a
 * pattern that deliberately names a locale-looking first segment still works.
 */
export function localeVariants(url: string): { lower: string; withoutLocale: string } {
  let pathAndQuery: string;
  try {
    const u = new URL(url);
    pathAndQuery = `${u.pathname}${u.search}`;
  } catch {
    pathAndQuery = url;
  }
  const lower = pathAndQuery.toLowerCase();
  return { lower, withoutLocale: stripLocalePrefix(lower) };
}
