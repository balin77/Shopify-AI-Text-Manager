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
  /** Market GID for a market-specific translation; "" (default) = global layer. */
  marketId?: string;
  /**
   * Shopify's own staleness verdict: true once the SOURCE text changed after
   * this translation was registered — i.e. someone edited the primary value
   * (in the Shopify admin, another app, an import). `undefined` means the
   * query did not ask for it, which is NOT the same as "not outdated" — see
   * services/translations/stale-translations.shared.ts.
   */
  outdated?: boolean;
}

/**
 * One `translatableContent` entry of a resource: the CURRENT primary value and
 * its digest. Shopify only lists keys that HAVE a primary value, so an absent
 * key means the merchant cleared that field.
 */
export interface PrimaryContentMap {
  [key: string]: { value: string; digest?: string | null };
}

/** Progress callback for sync operations */
export interface ProgressCallback {
  (current: number, total: number, message: string): void;
}
