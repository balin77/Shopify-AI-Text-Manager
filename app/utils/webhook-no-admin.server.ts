/**
 * Placeholder Admin client for webhook paths that are database-only (a
 * products/collections DELETE). Any Shopify call through it is a bug; it throws
 * a plain Error (not a connection-block error) so a future misuse goes through
 * the normal error / retry path instead of being swallowed as a blocked shop.
 */
export function noShopifyAdmin() {
  return {
    graphql: async (): Promise<never> => {
      throw new Error("webhook delete path must not call Shopify");
    },
  };
}
