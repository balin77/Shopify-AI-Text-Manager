/**
 * How many products use each of these metaobject entries as an option value.
 *
 * Its own route because the metaobjects page needs the answer for the entries
 * of the CURRENT page only, and only while the merchant is looking at them --
 * folding it into the entry loader would run the scan on every page view of
 * every type, including the ones nobody is about to delete from.
 *
 * It gates itself: directly GET-reachable, same class as the entry loader.
 *
 * The answer is three-valued (`known: false` with a reason). A caller that
 * flattens it to a number is the bug this route's shape exists to prevent --
 * see `metaobject-usage.server.ts`.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { canAccessContentType } from "~/utils/planUtils";
import type { Plan } from "~/config/plans";
import { countLinkedOptionUsage, liveProductCountForUsage } from "~/services/metaobject-usage.server";
import { isValidShopifyGID } from "~/utils/validation";

/** Matches the entry loader's page size — one page of cards, one request. */
const MAX_IDS = 250;


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  if (!canAccessContentType((settings?.subscriptionPlan || "free") as Plan, "metaobjects")) {
    return json({ success: false, error: "Your plan does not include metaobjects." }, { status: 403 });
  }

  const url = new URL(request.url);
  const ids = (url.searchParams.get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("gid://shopify/Metaobject/") && isValidShopifyGID(s));

  if (ids.length === 0) {
    return json({ success: true, usage: {} }, { headers: { "Cache-Control": "no-store" } });
  }
  if (ids.length > MAX_IDS) {
    return json({ success: false, error: `At most ${MAX_IDS} ids per request.` }, { status: 400 });
  }

  const usage = await countLinkedOptionUsage(db, session.shop, ids, () => liveProductCountForUsage(admin));
  return json({ success: true, usage }, { headers: { "Cache-Control": "no-store" } });
};
