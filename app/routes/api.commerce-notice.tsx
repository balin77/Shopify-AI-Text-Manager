/**
 * PLAN_CONTENT_CREATION Phase 4, step 6 — dismissing the scope notice.
 *
 * Its own route rather than a case bolted onto an unrelated settings endpoint:
 * one shop-scoped column, one verb, and nothing else should have to know it
 * exists. A failed dismissal costs the merchant one more dismissal, so it never
 * reports an error — but it does not pretend to have written either.
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { logger } from "~/utils/logger.server";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  try {
    // `upsert`, not `update`: a shop that has never opened Settings has no
    // AISettings row yet, and an update would throw on the first dismissal.
    await db.aISettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, commerceNoticeDismissedAt: new Date() },
      update: { commerceNoticeDismissedAt: new Date() },
    });
    return json({ success: true });
  } catch (error) {
    logger.warn("[Commerce] Could not store the notice dismissal", {
      context: "Commerce",
      shop: session.shop,
      error: error instanceof Error ? error.message : String(error),
    });
    // Reported, not swallowed — the client hides the banner optimistically
    // either way, and next time it will simply come back.
    return json({ success: false }, { status: 500 });
  }
}
