/**
 * The Admin API version for the ROOT background services that build their own
 * `https://<shop>/admin/api/<version>/graphql.json` URL (the WebP worker, the
 * stale-image cleanup) instead of going through the app's `admin.graphql`.
 *
 * Those services are plain JS outside the React Router bundle and cannot import
 * `app/utils/api-version.ts`, so this mirrors its `resolveApiVersionString`:
 * `SHOPIFY_API_VERSION` when it names a supported version, the same default
 * otherwise. They used to hardcode `2025-04`, i.e. talk to a different (and
 * end-of-life) version than every other request of the same process.
 * `tests/unit/admin-api-version-parity.test.ts` keeps the list and the default
 * in step with the TS module.
 */

export const SUPPORTED_ADMIN_API_VERSIONS = Object.freeze([
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
]);

export const DEFAULT_ADMIN_API_VERSION = "2025-10";

/**
 * @param {string | undefined} [versionString]
 * @returns {string}
 */
export function resolveAdminApiVersion(versionString) {
  const raw = String(versionString ?? process.env.SHOPIFY_API_VERSION ?? "").trim().toLowerCase();
  return SUPPORTED_ADMIN_API_VERSIONS.includes(raw) ? raw : DEFAULT_ADMIN_API_VERSION;
}

/**
 * @param {string} shop  the `*.myshopify.com` domain
 * @returns {string}
 */
export function adminGraphqlUrl(shop) {
  return `https://${shop}/admin/api/${resolveAdminApiVersion()}/graphql.json`;
}
