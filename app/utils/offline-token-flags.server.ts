/**
 * The two env switches behind Shopify's EXPIRING offline access tokens.
 *
 * Import-free on purpose: the scheduler, the detached task runners and the
 * boot log all ask these, and none of them may pull `shopify.server` into a
 * unit test just to read an env var.
 *
 * - `SHOPIFY_EXPIRING_OFFLINE_TOKENS=true` turns on
 *   `future.expiringOfflineAccessTokens` (token exchange then issues ~1h offline
 *   tokens plus a refresh token) AND routes every background caller through
 *   the refreshing client in offline-admin.server.ts. Default OFF: nothing
 *   changes for a deployment that has not set it.
 * - `SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS=true` additionally lets the app
 *   exchange a shop's existing NON-expiring offline token for an expiring one
 *   (lazily, per shop). It is honoured ONLY while the first switch is on: a
 *   migrated shop whose app then runs with the flag off would hold a token
 *   that expires with nothing left to refresh it.
 *
 * Exactly the string `true` (trimmed) counts — the same reading as
 * `MANAGED_AI_ENABLED`: "on unless explicitly false" would turn a token
 * migration on in every environment that merely has the variable defined.
 */

type Env = Record<string, string | undefined>;

export function expiringOfflineTokensEnabled(env: Env = process.env): boolean {
  return env.SHOPIFY_EXPIRING_OFFLINE_TOKENS?.trim() === "true";
}

export function migrateToExpiringTokensEnabled(env: Env = process.env): boolean {
  return expiringOfflineTokensEnabled(env) && env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS?.trim() === "true";
}
