/**
 * The pinned Shopify Admin API version, as a STRING.
 *
 * Why this is its own module and not just a read of `apiVersion` from
 * shopify.server: that module boots the whole embedded app (session storage,
 * Prisma, billing) as a side effect of being imported. Anything that only
 * needs to KNOW the version — a sync service stamping which API model a
 * cached value came from — must not drag that in.
 *
 * The supported strings and the default live here and nowhere else.
 * `shopify.server` maps this list onto the SDK's `ApiVersion` enum and calls
 * `resolveApiVersionString` for the env var, so the two can never disagree
 * about which version is actually in effect. A second hard-coded default, or a
 * second env-var read, is how a version pin silently drifts — and here the
 * consequence is worse than a stale constant: `Collection.sourcesJson` records
 * the version it read the rule model from, so a resolver that reports a version
 * the requests were never made against would name a model that was never spoken.
 *
 * PLAN_CONTENT_CREATION Phase −1 changes exactly one line here (plus the env
 * var, which is what actually decides at runtime — see the plan).
 */

/**
 * Versions this app can talk to. Kept in sync with the enum map in
 * shopify.server by construction: that map is typed over this union, so
 * removing a version here or adding one without a matching enum member is a
 * compile error, not a runtime surprise.
 *
 * @shopify/shopify-api v13 removed the 2022-10 … 2024-07 enum members, which is
 * why nothing older than 2024-10 appears.
 */
export const SUPPORTED_SHOPIFY_API_VERSIONS = [
  "2024-10",
  "2025-01",
  "2025-04",
  "2025-07",
  "2025-10",
  "2026-01",
  "2026-04",
  "2026-07",
  "2026-10",
  "unstable",
] as const;

export type ShopifyApiVersionString = (typeof SUPPORTED_SHOPIFY_API_VERSIONS)[number];

/** Pinned at 2025-10 for MEDIA_IMAGE translation support. */
export const DEFAULT_SHOPIFY_API_VERSION: ShopifyApiVersionString = "2025-10";

export function isSupportedApiVersion(value: string): value is ShopifyApiVersionString {
  return (SUPPORTED_SHOPIFY_API_VERSIONS as readonly string[]).includes(value);
}

/**
 * The version this process talks to. `SHOPIFY_API_VERSION` is SET in every
 * deployed environment, so it — not the default above — is normally the answer.
 *
 * An unsupported or typo'd value falls back to the default, which is exactly
 * what the SDK side does with it, so a caller that only wants to LABEL data
 * with the version gets the same answer the requests were actually made with.
 */
export function resolveApiVersionString(versionString?: string): ShopifyApiVersionString {
  const raw = (versionString ?? process.env.SHOPIFY_API_VERSION ?? "").trim().toLowerCase();
  return isSupportedApiVersion(raw) ? raw : DEFAULT_SHOPIFY_API_VERSION;
}
