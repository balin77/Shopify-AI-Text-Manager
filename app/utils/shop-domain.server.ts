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
 * Two entry points on purpose:
 *   - `resolvePrimaryDomain` returns `null` when the lookup FAILED, so a caller
 *     that PERSISTS the result can tell "the shop really is on its myshopify
 *     domain" apart from "the Admin API hiccuped". Storing the fallback would
 *     overwrite a correct primary domain with the redirecting one on any
 *     transient error — the exact bug the primary-domain work fixes.
 *   - `fetchPrimaryDomain` applies the fallback for read-only callers (audits,
 *     crawls) that just need a host to talk to.
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

/** The primary domain, or `null` when it could not be determined. */
export async function resolvePrimaryDomain(admin: GraphqlCapableAdmin): Promise<string | null> {
  try {
    const res = await admin.graphql(SHOP_PRIMARY_DOMAIN_QUERY);
    const body = (await res.json()) as {
      data?: { shop?: { primaryDomain?: { host?: string } } };
      errors?: Array<{ message?: string }>;
    };
    // A throttled/partial response is HTTP 200 with an `errors` array — without
    // this check it would look like "no primary domain" and yield the fallback.
    if (body?.errors?.length) return null;
    return body?.data?.shop?.primaryDomain?.host || null;
  } catch {
    return null;
  }
}

export async function fetchPrimaryDomain(
  admin: GraphqlCapableAdmin,
  fallbackShop: string,
): Promise<string> {
  return (await resolvePrimaryDomain(admin)) ?? fallbackShop;
}
