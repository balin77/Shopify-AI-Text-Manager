/**
 * What the variants card needs live from Shopify, in one request.
 *
 * Two things, and neither can come from the cache:
 *
 *   counts    (only with `?include=counts`) How many variants hang off each
 *             option value -- the one number a
 *             merchant needs before deleting a value, because deleting it
 *             deletes those variants with their stock, prices, SKUs and image
 *             assignments. `ProductVariant` stores a display title ("Red / S")
 *             and nothing about which VALUE produced which segment, so
 *             splitting it would be a guess, and a guess is not what an
 *             irreversible decision should rest on.
 *   swatches  The colour Shopify holds per value. Not cached at all: it is a
 *             decoration, and paying for it in the product sync's option
 *             selection would put a newer field on the critical path of every
 *             sync (see `fetchOptionSwatches`).
 *
 * Its own route because it is only worth fetching when the merchant actually
 * opens the card. Folding it into the product loader would put a 250-variant
 * query on every product open, for numbers almost nobody looks at.
 *
 * The two halves fail independently: a swatch query Shopify rejects costs the
 * swatches, never the counts.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { countVariantsPerValue, fetchOptionSwatches } from "~/services/product-options.server";

export const loader = async (args: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);

  const url = new URL(args.request.url);
  const productId = url.searchParams.get("productId") ?? "";
  if (!productId.startsWith("gid://shopify/Product/")) {
    return json({ success: false, counts: {}, swatches: {} }, { status: 400 });
  }

  // The counts are opt-in. Swatches are wanted the moment a product opens (a
  // collapsed card is where the merchant reads the values), while the counts
  // are up to ten pages of variants and are only wanted once a card is opened
  // and a delete becomes possible. One route, two costs, asked for separately.
  const wantsCounts = (url.searchParams.get("include") ?? "").split(",").includes("counts");

  // No plan gate: this reads nothing a merchant cannot see on the product page
  // itself, and gating it would leave the delete confirmation unable to name
  // the consequence — which is the opposite of what a gate should achieve.
  const [counts, swatches] = await Promise.all([
    wantsCounts ? countVariantsPerValue(admin, session.shop, productId) : Promise.resolve({}),
    fetchOptionSwatches(admin, session.shop, productId),
  ]);
  return json({ success: true, counts, swatches });
};
