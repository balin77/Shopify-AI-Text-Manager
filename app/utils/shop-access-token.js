/**
 * The offline Admin API token for the ROOT background workers
 * (webp-processor.service.js, stale-image-cleanup.service.js).
 *
 * Those workers are plain JS outside the React Router bundle and cannot import
 * `app/utils/offline-admin.server.ts`. The bundle registers
 * `globalThis.__getShopAccessToken` at boot (shopify.server.ts →
 * `registerShopAccessTokenHook`), the same process-wide hand-over server.js uses
 * for `globalThis.__aiQueue`. Through it a worker gets the token the app would
 * use: the OFFLINE session, refreshed when it is an expiring token close to its
 * end. Reading `db.session` directly hands back whatever is stored — with
 * expiring offline tokens that can be a token that died an hour ago.
 *
 * When the hook is missing (the bundle has not loaded yet, or failed to) the
 * old direct read is the fallback, so the workers keep working exactly as
 * before for non-expiring tokens.
 *
 * Returns `{ token }` or `{ token: null, reason }` and never throws.
 */

/**
 * @param {string} shop
 * @param {{ db: any, decryptToken: (v: string) => string | null, logPrefix?: string }} deps
 * @returns {Promise<{ token: string, source: "app" | "db" } | { token: null, reason: string }>}
 */
export async function resolveShopAccessToken(shop, { db, decryptToken, logPrefix = "[ShopAccessToken]" }) {
  const hook = globalThis.__getShopAccessToken;
  if (typeof hook === "function") {
    try {
      const token = await hook(shop);
      if (token) return { token, source: "app" };
      return { token: null, reason: "No valid session found for shop" };
    } catch (err) {
      // No DB fallback here: the app's path already read the same session, and
      // what storage holds is exactly the token it could not use or refresh.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`${logPrefix} Offline token for ${shop} unavailable: ${message}`);
      return { token: null, reason: `No valid session found for shop (${message})` };
    }
  }

  const session = await db.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { lastActivityAt: "desc" },
  });
  if (!session?.accessToken) return { token: null, reason: "No valid session found for shop" };
  if (session.expires && new Date(session.expires).getTime() < Date.now()) {
    // An expiring token past its end cannot be refreshed from here; sending it
    // only produces a 401 that reads like a revoked install.
    console.warn(`${logPrefix} Stored offline token for ${shop} has expired and the app hook is not registered`);
    return { token: null, reason: "Offline access token expired" };
  }
  let token;
  try {
    token = decryptToken(session.accessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${logPrefix} Token decrypt failed for ${shop}: ${message}`);
    return { token: null, reason: "Failed to decrypt session access token" };
  }
  if (!token) return { token: null, reason: "Failed to decrypt session access token" };
  return { token, source: "db" };
}
