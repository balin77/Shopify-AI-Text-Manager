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
 * The two windows below can cut off, and a market that fell off the end is
 * indistinguishable from one the product is genuinely missing from. So the
 * response carries `truncated`, and the client says NOTHING when it is set. A
 * missed warning, never a wrong one — the same direction the redirect-chain
 * and crawl rules take.
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
    const response = await admin.graphql(
      `#graphql
        query productMarketPublications($id: ID!) {
          product(id: $id) {
            resourcePublicationsV2(first: ${PUBLICATION_PAGE_SIZE}, onlyPublished: false) {
              pageInfo { hasNextPage }
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
      { variables: { id: productId } },
    );

    const body = (await response.json()) as {
      data?: { product?: { resourcePublicationsV2?: ShopifyMarketPublications | null } | null };
      errors?: Array<{ message?: string }>;
    };

    // A schema-level error arrives as a top-level `errors` array with
    // `data: null`. Read as "no data" it would report every market as
    // unscoped and silently drop the warning this route exists to give.
    if (body.errors?.length) {
      logger.warn("[MarketPublications] Schema-level error", {
        context: "MarketPublications",
        shop: session.shop,
        error: body.errors[0]?.message,
      });
      return json({ success: false, error: "The market publication state could not be read." }, { status: 502 });
    }

    const view = marketPublicationView(body.data?.product?.resourcePublicationsV2);
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
