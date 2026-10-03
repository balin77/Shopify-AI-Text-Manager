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
