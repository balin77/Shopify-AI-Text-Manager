/**
 * How many variants hang off each option value.
 *
 * The one number a merchant needs before deleting a value, because deleting it
 * deletes those variants with their stock, prices, SKUs and image assignments.
 * Read live rather than from the cache: `ProductVariant` stores a display title
 * ("Red / S") and nothing about which VALUE produced which segment, so
 * splitting it would be a guess — and a guess is not what an irreversible
 * decision should rest on.
 *
 * Its own route because it is only worth fetching when the merchant actually
 * opens an option card. Folding it into the product loader would put a
 * 250-variant query on every product open, for a number almost nobody looks at.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { countVariantsPerValue } from "~/services/product-options.server";

export const loader = async (args: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);

  const url = new URL(args.request.url);
  const productId = url.searchParams.get("productId") ?? "";
  if (!productId.startsWith("gid://shopify/Product/")) {
    return json({ success: false, counts: {} }, { status: 400 });
  }

  // No plan gate: this reads nothing a merchant cannot see on the product page
  // itself, and gating it would leave the delete confirmation unable to name
  // the consequence — which is the opposite of what a gate should achieve.
  const counts = await countVariantsPerValue(admin, session.shop, productId);
  return json({ success: true, counts });
};
