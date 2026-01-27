/**
 * Admin Client Utility
 *
 * Creates Shopify Admin API clients from stored sessions.
 * Used for background processing (webhooks, scheduled tasks) where
 * we don't have access to an authenticated request context.
 */

import type { Session } from "@shopify/shopify-api";
import { apiVersion } from "../shopify.server";
import { logger } from "./logger.server";

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
  const { db } = await import("../db.server");

  // Fetch the most recent session for this shop
  const session = await db.session.findFirst({
    where: { shop },
    orderBy: { id: "desc" },
  });

  if (!session) {
    throw new Error(`No session found for shop: ${shop}`);
  }

  if (!session.accessToken) {
    throw new Error(`Session for shop ${shop} has no access token`);
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
  const version = apiVersion || "2024-10";
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
