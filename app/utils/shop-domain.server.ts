/**
 * The shop's PRIMARY storefront domain.
 *
 * Shopify serves the online store on `*.myshopify.com` too, but as soon as a
 * custom primary domain exists every storefront URL on the myshopify host is
 * 301-redirected to it. Anything that hands a storefront URL to an external
 * system (sitemap audit, crawler, IndexNow) must therefore use the primary
 * domain, or it publishes non-canonical redirect URLs — and, for
 * host-verified protocols like IndexNow, fails the ownership check outright
 * because the verification fetch ends up on a different host than the one
 * declared.
 *
 * Degrades to the `*.myshopify.com` fallback on any error: that host always
 * resolves, so a failed lookup keeps the caller working instead of throwing.
 */

const SHOP_PRIMARY_DOMAIN_QUERY = `#graphql
  query shopPrimaryDomain {
    shop { primaryDomain { host } }
  }
`;

/**
 * Structurally typed so both the real `AdminApiContext` and a test double fit.
 * The options bag is `any` on purpose: the Shopify client types it with its own
 * generic `GraphQLQueryOptions`, which no narrower signature is assignable to.
 */
interface GraphqlCapableAdmin {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphql: (query: string, options?: any) => Promise<{ json: () => Promise<any> }>;
}

export async function fetchPrimaryDomain(
  admin: GraphqlCapableAdmin,
  fallbackShop: string,
): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_PRIMARY_DOMAIN_QUERY);
    const body = (await res.json()) as { data?: { shop?: { primaryDomain?: { host?: string } } } };
    return body?.data?.shop?.primaryDomain?.host || fallbackShop;
  } catch {
    return fallbackShop;
  }
}
