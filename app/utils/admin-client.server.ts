/**
 * Admin Client Utility
 *
 * Creates Shopify Admin API clients from stored sessions.
 * Used for background processing (webhooks, scheduled tasks) where
 * we don't have access to an authenticated request context.
 */

import type { Session } from "@shopify/shopify-api";
import { apiVersion, sessionStorage } from "../shopify.server";
import { logger } from "./logger.server";
import { isValidShopDomain } from "./validation";
import { isEncrypted } from "./encryption.server";
import {
  getOfflineAdmin,
  invalidateOfflineAdmin,
  isNonExpiringTokenRejectedError,
  markSelfRefreshingAdminClient,
  reportNonExpiringTokenRejection,
  OfflineAdminUnavailableError,
} from "./offline-admin.server";
import { blockShopConnection, noteUnauthorized } from "./shop-connection-block.server";
import { getConnectionBlock, ShopConnectionBlockedError } from "./shop-connection-state.server";

export {
  getOfflineAdmin,
  getOfflineAccessToken,
  createRefreshingAdmin,
  backgroundAdmin,
} from "./offline-admin.server";

interface ShopifyGraphQLClient {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
}

/**
 * Creates an Admin API client from a database session
 *
 * This is useful for webhook handlers and background jobs where you have
 * the shop domain and need to make API calls without an active user request.
 *
 * @param shop - Shop domain (e.g., "my-shop.myshopify.com")
 * @returns Admin API client with graphql method
 */
export async function createAdminClientFromShop(
  shop: string
): Promise<ShopifyGraphQLClient> {
  if (!isValidShopDomain(shop)) {
    throw new Error(`Invalid shop domain: ${shop}`);
  }

  // A shop whose access is known to be dead gets NO Shopify call from
  // background code: the caller learns it at once and skips the shop quietly
  // (isShopConnectionBlockedError). In-app requests never come through here,
  // they authenticate through `authenticate.admin`, so a merchant who opens
  // the app always reaches the token exchange that lifts the block.
  const block = await getConnectionBlock(shop);
  if (block) throw new ShopConnectionBlockedError(shop, block);

  // The token is NOT read once and kept. With expiring offline tokens (~1h) a
  // client built from a token captured here dies mid-run for every long caller
  // (drift sweep, crawl sweep, webhook retry queue). So the client keeps the
  // SHOP and asks offline-admin.server.ts for the token on every call: cached
  // in-process while valid, refreshed through the library when it is about to
  // expire, single-flight per shop, and re-read once after a 401.
  //
  // Validated eagerly, so a shop with no usable session still throws HERE —
  // the callers' "no session" handling (skip the shop, stamp the backoff)
  // keeps working.
  try {
    await getOfflineAdmin(shop);
  } catch (error) {
    if (error instanceof OfflineAdminUnavailableError && error.reason === "no_session") {
      // Legacy fallback, unchanged from before: an install whose only session
      // is an online one (pre token-exchange). Never used once an offline
      // session exists; such a client keeps that token (residual — it expires
      // anyway after ~24h and the shop re-authenticates).
      const legacy = await legacyOnlineTokenClient(shop);
      if (legacy) return legacy;
      throw new Error(`No session found for shop: ${shop}`);
    }
    throw error;
  }

  return createRefreshingRawClient(shop);
}

async function legacyOnlineTokenClient(shop: string): Promise<ShopifyGraphQLClient | null> {
  // Through the app's sessionStorage (EncryptedPrismaSessionStorage), never
  // db.session: tokens are encrypted at rest and a raw read is ciphertext.
  const sessions = await sessionStorage.findSessionsByShop(shop);
  const now = Date.now();
  const session = sessions.find(
    (s) => s.isOnline && s.accessToken && (!s.expires || s.expires.getTime() > now),
  );
  if (!session?.accessToken) return null;
  if (isEncrypted(session.accessToken)) {
    throw new Error(
      `Access token for shop ${shop} could not be decrypted — check ENCRYPTION_KEY`
    );
  }
  logger.warn("[AdminClient] No offline session — falling back to an online session token", { shop });
  // Also handed back unchanged by `backgroundAdmin`: there is no offline
  // session for the refreshing client to load, so swapping it would only fail.
  return markSelfRefreshingAdminClient(createAdminClient(shop, session.accessToken));
}

/**
 * Raw-fetch client with the same response contract as before (the Response is
 * returned as-is on 2xx, GraphQL `errors` included; non-2xx throws), whose
 * token is re-acquired per call and which retries ONCE on a 401 after forcing
 * a reload of the stored session.
 */
/**
 * Same handling as createRefreshingAdmin for the 403 "non-expiring tokens are no
 * longer accepted": warn, start the migration (switches permitting), heal a shop
 * the migration cannot help; no retry with the same token — the caller gets the
 * ordinary error for the 403. Runs on the first response AND on the response of
 * the 401 retry. Reads (a clone of) the body of EVERY 403, also with the token
 * switches off — intended: it is how the deadline message is recognised, and
 * reporting only warns then.
 */
async function reportIfDeadlineRejection(shop: string, token: string, response: Response): Promise<void> {
  if (response.status === 403 && (await isNonExpiringTokenRejectedError(response))) {
    reportNonExpiringTokenRejection(shop, token);
  }
}

function createRefreshingRawClient(shop: string): ShopifyGraphQLClient {
  // Marked so `backgroundAdmin` hands it back unchanged rather than swapping
  // its raw contract for the library client's (see offline-admin.server.ts).
  return markSelfRefreshingAdminClient({
    graphql: async (query: string, options?: { variables?: any }) => {
      // When this call BEGAN: the fence for the block a second 401 may set.
      const startedAt = new Date();
      // A long-lived client (a sweep over hundreds of calls) stops at the first
      // call after the shop got blocked, not only at creation. Cached for 30 s.
      const block = await getConnectionBlock(shop);
      if (block) throw new ShopConnectionBlockedError(shop, block);
      const token = (await getOfflineAdmin(shop)).session.accessToken!;
      const first = await rawGraphql(shop, token, query, options);
      await reportIfDeadlineRejection(shop, token, first);
      if (first.status !== 401) return checkOk(first);
      noteUnauthorized(shop);
      logger.warn("[AdminClient] 401 from Shopify — reloading the offline session and retrying once", { shop });
      invalidateOfflineAdmin(shop);
      const fresh = (await getOfflineAdmin(shop, { forceReload: true, refusedToken: token })).session.accessToken!;
      const retried = await rawGraphql(shop, fresh, query, options);
      await reportIfDeadlineRejection(shop, fresh, retried);
      // A SECOND 401 with the very token the first one refused: the stored
      // access is dead. The BLOCKED line replaces checkOk's error log. (A 403 is
      // never evidence: it can be the IP allowlist. A different token that is
      // refused too may be a rotation race.)
      if (retried.status === 401 && fresh === token) {
        if (await blockShopConnection(shop, "admin_api_401", { observedAt: startedAt })) {
          throw new ShopConnectionBlockedError(shop, { state: "needs_reauth", since: null, reason: "admin_api_401" });
        }
      }
      return checkOk(retried);
    },
  });
}

/**
 * Creates an Admin API client from a session object
 *
 * @param session - Shopify session object
 * @returns Admin API client with graphql method
 */
export function createAdminClientFromSession(
  session: Session | { shop: string; accessToken: string }
): ShopifyGraphQLClient {
  if (!session.accessToken) {
    throw new Error(`Session has no access token`);
  }
  return createAdminClient(session.shop, session.accessToken);
}

/**
 * Creates an Admin API client with shop and access token
 *
 * @param shop - Shop domain
 * @param accessToken - Shopify access token
 * @returns Admin API client with graphql method
 */
function createAdminClient(
  shop: string,
  accessToken: string
): ShopifyGraphQLClient {
  return {
    graphql: async (query: string, options?: { variables?: any }) =>
      checkOk(await rawGraphql(shop, accessToken, query, options)),
  };
}

async function rawGraphql(
  shop: string,
  accessToken: string,
  query: string,
  options?: { variables?: any },
): Promise<Response> {
  // Use the API version from config, with fallback
  const version = apiVersion || "2025-10";
  const graphqlEndpoint = `https://${shop}/admin/api/${version}/graphql.json`;
  logger.debug('[AdminClient] Making GraphQL request to ' + shop);
  return fetch(graphqlEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query,
      variables: options?.variables,
    }),
  });
}

async function checkOk(response: Response): Promise<Response> {
  if (!response.ok) {
    const errorText = await response.text();
    logger.error('[AdminClient] GraphQL request failed', {
      status: response.status,
      statusText: response.statusText,
      body: errorText,
    });
    throw new Error(
      `GraphQL request failed: ${response.status} ${response.statusText}`
    );
  }
  return response;
}
