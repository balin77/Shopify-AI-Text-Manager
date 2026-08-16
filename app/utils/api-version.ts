/**
 * The pinned Shopify Admin API version, as a STRING.
 *
 * Why this is its own module and not just a read of `apiVersion` from
 * shopify.server: that module boots the whole embedded app (session storage,
 * Prisma, billing) as a side effect of being imported. Anything that only
 * needs to KNOW the version — a sync service stamping which API model a
 * cached value came from — must not drag that in.
 *
 * The default lives here and nowhere else. `shopify.server` maps this string
 * onto the SDK's `ApiVersion` enum; a second hard-coded default in either
 * place is how a version pin silently drifts.
 *
 * PLAN_CONTENT_CREATION Phase −1 changes exactly one line here (plus the env
 * var, which is what actually decides at runtime — see the plan).
 */
export const DEFAULT_SHOPIFY_API_VERSION = "2025-10";

/**
 * The version this process talks to. `SHOPIFY_API_VERSION` is SET in every
 * deployed environment, so it — not the default above — is normally the answer.
 */
export function resolveApiVersionString(versionString?: string): string {
  const raw = (versionString ?? process.env.SHOPIFY_API_VERSION ?? "").trim().toLowerCase();
  return raw.length > 0 ? raw : DEFAULT_SHOPIFY_API_VERSION;
}
