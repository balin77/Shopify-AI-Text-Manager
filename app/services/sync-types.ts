/**
 * Shared types for sync services
 *
 * Extracted from product-sync, content-sync, background-sync, metaobject-sync,
 * and shopify-api-gateway services to eliminate duplication.
 */

/** Minimal response interface shared by Shopify admin.graphql and ShopifyApiGateway.graphql */
export interface GraphQLResponseLike {
  ok: boolean;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
}

/** Shopify Admin GraphQL client interface */
export interface ShopifyGraphQLClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<GraphQLResponseLike>;
}

/** Generic GraphQL function type (abstracts admin.graphql vs gateway.graphql) */
export type GraphQLFunction = (
  query: string,
  options?: { variables?: Record<string, unknown> }
) => Promise<GraphQLResponseLike>;

/** Locale info returned by shopLocales query */
export interface ShopLocale {
  locale: string;
  name?: string;
  primary: boolean;
  published: boolean;
}

/** GraphQL edge wrapper */
export interface GraphQLEdge<T> {
  node: T;
}

/** A single translation from Shopify */
export interface ShopifyTranslation {
  key: string;
  value: string;
  locale: string;
  outdated?: boolean;
}

/** Resolved translation with digest */
export interface ResolvedTranslation {
  key: string;
  value: string;
  locale: string;
  digest?: string | null;
  resourceType?: string;
}

/** Progress callback for sync operations */
export interface ProgressCallback {
  (current: number, total: number, message: string): void;
}
