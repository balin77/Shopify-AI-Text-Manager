/**
 * Which MARKETS a product is published in — read live, for the translation
 * editor's market selector.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * A market catalog decides who may SEE a product. Translate a product for
 * market "Schweiz" while the product is not in that market's catalog and the
 * work is invisible by construction: nobody in that market can reach the page
 * the translation is on. The editor has no way to know that today, so a
 * merchant can spend an afternoon translating into a market that cannot show
 * it. This route is the answer to "is this product even in that market".
 *
 * ── Why NOT the commerce route ──────────────────────────────────────────────
 * `/api/product-commerce` already reads publications, but it is unusable here
 * for two independent reasons: it refuses to load outside the PRIMARY locale
 * (stock and channels exist once per product, so there was no reason to fetch
 * it while translating), and it is Pro-gated. Market translations are on every
 * plan, and the question is only ever asked in a FOREIGN locale. So this is a
 * separate, much smaller read.
 *
 * ── Why no plan gate ────────────────────────────────────────────────────────
 * Directly GET-reachable, and the app's rule is that such routes gate
 * themselves — but the thing being gated has to be worth gating. This returns
 * the merchant's own publication state for their own product, through their
 * own session, and every plan of this app can translate per market. Gating it
 * would take the warning away from exactly the merchants most likely to hit
 * the trap.
 *
 * ── Absence is never evidence ───────────────────────────────────────────────
 * The windows below can cut off, and a market that fell off the end is
 * indistinguishable from one the product is genuinely missing from. So the
 * response carries `truncated`, and the client says NOTHING when it is set. A
 * missed warning, never a wrong one — the same direction the redirect-chain
 * and crawl rules take.
 *
 * ── `catalogType: MARKET` is the whole query ────────────────────────────────
 * `resourcePublicationsV2` DEFAULTS to `catalogType: APP`, silently. Without
 * this argument the answer holds sales channels and nothing else, every market
 * reads as unscoped, and this banner can never fire — which is exactly what it
 * did when it first shipped. The argument also keeps the window honest: asking
 * for markets ONLY means the 50 per page are markets, instead of markets
 * competing with every channel and B2B catalog for the same slots.
 *
 * It is still PAGED, because a shop may run more region catalogs than fit on
 * one page, and truncation here means the banner says nothing at all.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import {
  PUBLICATION_PAGE_SIZE,
  marketPublicationView,
  type MarketPublicationView,
  type ShopifyMarketPublications,
} from "~/services/commerce-sync.shared";

/**
 * Markets per market catalog — small on purpose, because this one nests.
 *
 * Shopify prices a query from the `first:` arguments BEFORE running it, and a
 * nested connection multiplies by its parent's size. `commerce-sync.shared.ts`
 * documents `PUBLICATION_PAGE_SIZE` as safe precisely because nothing hangs
 * under it; here something does, so the arithmetic is
 * `50 × (node + publication + catalog + markets)`:
 *
 *   markets(first: 10) → 50 × 13 = 650   most of a standard plan's 1000-point
 *                                        bucket, refilling at 50/s — enough to
 *                                        throttle the editor's OTHER admin
 *                                        calls while a merchant clicks through
 *                                        products with a market selected
 *   markets(first: 3)  → 50 ×  6 = 300   comfortable, and three is past every
 *                                        catalog shape seen in practice (a
 *                                        market catalog usually covers ONE)
 *
 * A catalog covering more than three markets is not answered short: it sets
 * `truncated`, and the client then says nothing at all.
 */
const MARKETS_PER_CATALOG = 3;

/**
 * How many pages of publications to walk. 3 × 50 = 150 publications is past
 * every real shop; each page is its own query at ~300 points, so the pages
 * cost the bucket sequentially rather than all at once.
 */
const MAX_PUBLICATION_PAGES = 3;

/** The response body's data half — see `MarketPublicationView` for the rules. */
export type ProductMarketPublicationsView = MarketPublicationView;

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId") || "";

  if (!productId.startsWith("gid://shopify/Product/")) {
    return json({ success: false, error: "A product id is required." }, { status: 400 });
  }

  try {
    // `publishDate` is not decoration: a SCHEDULED market launch reports
    // `isPublished: false`, and without the date the banner would tell a
    // merchant to add a market they already added. (No comments inside the
    // document itself — see tests/unit/graphql-document-hygiene.test.ts.)
    const nodes: NonNullable<ShopifyMarketPublications["nodes"]> = [];
    let cursor: string | null = null;
    let truncated = false;

    for (let page = 0; page < MAX_PUBLICATION_PAGES; page++) {
      const response = await admin.graphql(
        `#graphql
          query productMarketPublications($id: ID!, $after: String) {
            product(id: $id) {
              resourcePublicationsV2(first: ${PUBLICATION_PAGE_SIZE}, onlyPublished: false, catalogType: MARKET, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  isPublished
                  publishDate
                  publication {
                    id
                    catalog {
                      __typename
                      ... on MarketCatalog {
                        markets(first: ${MARKETS_PER_CATALOG}) {
                          pageInfo { hasNextPage }
                          nodes { id }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
        { variables: { id: productId, after: cursor } },
      );

      const body = (await response.json()) as {
        data?: {
          product?: {
            resourcePublicationsV2?:
              | (ShopifyMarketPublications & { pageInfo?: { endCursor?: string | null } | null })
              | null;
          } | null;
        };
        errors?: Array<{ message?: string }>;
      };

      // A schema-level error arrives as a top-level `errors` array with
      // `data: null`. Read as "no data" it would report every market as
      // unscoped and silently drop the warning this route exists to give.
      // A LATER page failing is different: what was read is still true, and
      // the rest is reported as truncation rather than thrown away.
      if (body.errors?.length) {
        logger.warn("[MarketPublications] Schema-level error", {
          context: "MarketPublications",
          shop: session.shop,
          page,
          error: body.errors[0]?.message,
        });
        if (page > 0) { truncated = true; break; }
        return json({ success: false, error: "The market publication state could not be read." }, { status: 502 });
      }

      const connection = body.data?.product?.resourcePublicationsV2;
      if (!connection) {
        if (page > 0) { truncated = true; break; }
        return json({ success: false, error: "The market publication state could not be read." }, { status: 502 });
      }

      nodes.push(...(connection.nodes ?? []));
      if (connection.pageInfo?.hasNextPage !== true) break;
      // More pages exist. Without a cursor we cannot reach them — that is
      // truncation, not the end of the list, and dropping the flag here would
      // let the banner make a claim over a partial answer.
      if (!connection.pageInfo.endCursor) { truncated = true; break; }
      cursor = connection.pageInfo.endCursor;
      // Ran out of pages before Shopify ran out of publications.
      if (page === MAX_PUBLICATION_PAGES - 1) truncated = true;
    }

    const view = marketPublicationView({ pageInfo: { hasNextPage: truncated }, nodes });
    if (!view) {
      return json({ success: false, error: "The market publication state could not be read." }, { status: 502 });
    }

    return json({ success: true, ...view } satisfies { success: true } & ProductMarketPublicationsView);
  } catch (error) {
    logger.error("[MarketPublications] Load failed", {
      context: "MarketPublications",
      shop: session.shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ success: false, error: "The market publication state could not be read." }, { status: 500 });
  }
}
