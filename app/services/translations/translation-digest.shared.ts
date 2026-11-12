/**
 * Import-free, client-safe constants of the digest lookup that every
 * translation write needs (`translationsRegister` requires a digest).
 *
 * Lives beside the verified write helpers rather than in the bulk editor:
 * the server-side digest prefetch (verified-translations.server.ts), the
 * SEO bulk fix's digest batches and the bulk editor's client-side call
 * estimate (`estimateCalls`) must agree on ONE number.
 */

/** Alias-batch size for the digest query: one HTTP request covers up to this
 *  many resources (Shopify has no `translatableResourcesByIds`). */
export const DIGEST_BATCH_CHUNK = 50;

/**
 * Resources per aliased query when the query ALSO reads the live translations
 * of N locales (one `translations(locale:)` alias per locale per resource).
 * Every alias adds query cost, so the page is DIVIDED by the locale count -- a
 * fixed page blows Shopify's single-query cost ceiling on a multilingual shop
 * (MAX_COST_EXCEEDED arrives as a top-level `errors` entry, i.e. a throw that
 * takes the whole chunk with it). Never below one resource.
 */
export function liveReadChunkSize(localeCount: number): number {
  return Math.max(1, Math.floor(DIGEST_BATCH_CHUNK / Math.max(1, localeCount)));
}
