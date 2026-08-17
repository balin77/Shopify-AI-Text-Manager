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

  // Go through the app's sessionStorage (EncryptedPrismaSessionStorage), NOT
  // db.session directly: access tokens are AES-256-GCM encrypted at rest, so a
  // raw Prisma read hands back ciphertext. Sending that as X-Shopify-Access-Token
  // makes every background call fail with 401 "Invalid API key or access token"
  // — silently breaking product/collection webhooks, the webhook retry queue and
  // the llms.txt auto-refresh, while the embedded UI kept working (it goes
  // through authenticate.admin, which decrypts).
  const sessions = await sessionStorage.findSessionsByShop(shop);

  if (sessions.length === 0) {
    throw new Error(`No session found for shop: ${shop}`);
  }

  // Prefer the offline session: it is the only one meant for background work.
  // Online sessions belong to one logged-in user and expire after ~24h, and the
  // previous `orderBy: { id: "desc" }` picked between them by string sort — so
  // whether background jobs got a usable token was down to id ordering.
  const now = Date.now();
  const session =
    sessions.find((s) => !s.isOnline && s.accessToken) ??
    sessions.find((s) => s.accessToken && (!s.expires || s.expires.getTime() > now));

  if (!session?.accessToken) {
    throw new Error(`Session for shop ${shop} has no usable access token`);
  }

  // Belt and braces: never spend a Shopify call on a token we know is ciphertext.
  // findSessionsByShop logs decryption failures but keeps the raw value, so a
  // wrong/rotated ENCRYPTION_KEY would otherwise surface as an opaque 401.
  if (isEncrypted(session.accessToken)) {
    throw new Error(
      `Access token for shop ${shop} could not be decrypted — check ENCRYPTION_KEY`
    );
  }

  return createAdminClient(shop, session.accessToken);
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
  // Use the API version from config, with fallback
  const version = apiVersion || "2025-10";
  const graphqlEndpoint = `https://${shop}/admin/api/${version}/graphql.json`;

  return {
    graphql: async (query: string, options?: { variables?: any }) => {
      logger.debug('[AdminClient] Making GraphQL request to ' + shop);

      const response = await fetch(graphqlEndpoint, {
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
    },
  };
}
