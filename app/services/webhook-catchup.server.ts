/**
 * Catch-up of changes missed while a shop was blocked or uninstalled
 * (PLAN_ADMIN_SHOP_OVERVIEW 2.4).
 *
 * `ShopInstallState.resyncRequiredSince` says "webhooks of this shop were
 * accepted but not processed (connection block), or the app was uninstalled and
 * may be reinstalled". The scheduler calls `runWebhookCatchUp` once per cycle for
 * such a shop BEFORE its inactivity check, so even a short visit after the new
 * login repairs the drift (the periodic reconcile needs ~30 minutes of
 * uninterrupted activity and would never fire).
 *
 * Rules that are load-bearing:
 *  - Only for a shop whose initial sync is DONE (before that the initial sync
 *    fetches everything anyway) and that is not blocked (it would only fail).
 *  - The flag is cleared ONLY when every type reported `ok`, and by
 *    COMPARE-AND-DELETE on the flag value AND the dropped-webhook count read
 *    before the run. A webhook dropped meanwhile (the shop was blocked again)
 *    increments the count, so the clear matches no row and the flag stays.
 *  - At most one run per shop at a time (in-process; one instance, see
 *    RAILWAY-SETUP), and after an incomplete run a pause before the next
 *    attempt, so a persistently failing type does not repeat every cycle.
 *  - Never throws.
 */

import { logger } from "~/utils/logger.server";
import type { ShopifyGraphQLClient } from "./sync-types";

export const CATCHUP_RETRY_PAUSE_MS = 5 * 60 * 1000;
export const CATCHUP_RETRY_PAUSE_MAX_MS = 6 * 60 * 60 * 1000;
/** After this many consecutive runs incomplete only through single-item failures, the flag is given up on. */
export const CATCHUP_GIVE_UP_AFTER = 5;

/** 5 min, doubling per consecutive incomplete run, capped. */
export function catchUpPauseMs(failures: number): number {
  return Math.min(CATCHUP_RETRY_PAUSE_MS * 2 ** Math.max(0, failures - 1), CATCHUP_RETRY_PAUSE_MAX_MS);
}

export type CatchUpOutcome = "not_needed" | "blocked" | "busy" | "paused" | "done" | "incomplete" | "error";

const inFlight = new Set<string>();
const lastIncompleteAt = new Map<string, number>();
const incompleteCount = new Map<string, number>();
const itemOnlyCount = new Map<string, number>();

/** Test seam. */
export function __resetCatchUpForTests(): void {
  inFlight.clear();
  lastIncompleteAt.clear();
  incompleteCount.clear();
  itemOnlyCount.clear();
}

export interface ResyncOwed {
  since: Date;
  dropped: number;
}

async function dbClient() {
  const { db } = await import("../db.server");
  return db;
}

/** What a catch-up owes right now, or null (not owed, no row, or a failed read). */
export async function readResyncOwed(shop: string): Promise<ResyncOwed | null> {
  try {
    const db = await dbClient();
    const row = await db.shopInstallState.findUnique({
      where: { shop },
      select: { resyncRequiredSince: true, droppedWebhookCount: true },
    });
    if (!row?.resyncRequiredSince) return null;
    return { since: row.resyncRequiredSince, dropped: row.droppedWebhookCount ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Compare-and-delete: clear the flag (and reset the count) only if neither
 * changed since `owed` was read. Returns whether it was cleared.
 */
export async function clearResyncIfUnchanged(shop: string, owed: ResyncOwed): Promise<boolean> {
  try {
    const db = await dbClient();
    const res = await db.shopInstallState.updateMany({
      where: { shop, resyncRequiredSince: owed.since, droppedWebhookCount: owed.dropped },
      data: { resyncRequiredSince: null, droppedWebhookCount: 0 },
    });
    return res.count > 0;
  } catch {
    return false;
  }
}

export async function runWebhookCatchUp(shop: string, admin: ShopifyGraphQLClient): Promise<CatchUpOutcome> {
  if (inFlight.has(shop)) return "busy";
  inFlight.add(shop);
  try {
    const db = await dbClient();
    const st = await db.shopInstallState.findUnique({
      where: { shop },
      select: { initialSyncCompletedAt: true, resyncRequiredSince: true, droppedWebhookCount: true },
    });
    if (!st?.initialSyncCompletedAt || !st.resyncRequiredSince) return "not_needed";

    const { getConnectionBlock } = await import("../utils/shop-connection-state.server");
    if (await getConnectionBlock(shop)) return "blocked";

    const paused = lastIncompleteAt.get(shop);
    if (paused !== undefined && Date.now() - paused < catchUpPauseMs(incompleteCount.get(shop) ?? 1)) return "paused";

    const owed: ResyncOwed = { since: st.resyncRequiredSince, dropped: st.droppedWebhookCount ?? 0 };
    const { reconcileWebhookBackedTypes } = await import("./webhook-reconcile.service");
    const result = await reconcileWebhookBackedTypes(admin, shop);
    const allOk = !!result?.ok && result.ok.products && result.ok.collections;
    if (!allOk) {
      lastIncompleteAt.set(shop, Date.now());
      incompleteCount.set(shop, (incompleteCount.get(shop) ?? 0) + 1);
      const itemOnly = result?.itemFailuresOnly === true;
      const n = itemOnly ? (itemOnlyCount.get(shop) ?? 0) + 1 : 0;
      itemOnlyCount.set(shop, n);
      if (itemOnly && n >= CATCHUP_GIVE_UP_AFTER) {
        await clearResyncIfUnchanged(shop, owed);
        lastIncompleteAt.delete(shop);
        incompleteCount.delete(shop);
        itemOnlyCount.delete(shop);
        logger.warn(`[CatchUp] shop=${shop} gave up after ${n} runs incomplete only through single-item failures; flag cleared, the periodic reconcile keeps covering it`);
        return "incomplete";
      }
      logger.info(`[CatchUp] shop=${shop} incomplete, flag kept`);
      return "incomplete";
    }
    lastIncompleteAt.delete(shop);
    incompleteCount.delete(shop);
    itemOnlyCount.delete(shop);
    const cleared = await clearResyncIfUnchanged(shop, owed);
    logger.info(
      cleared
        ? `[CatchUp] shop=${shop} done, owed since ${owed.since.toISOString()}, droppedWebhooks=${owed.dropped}`
        : `[CatchUp] shop=${shop} done, but a webhook was dropped meanwhile; flag kept`,
    );
    return "done";
  } catch (error) {
    lastIncompleteAt.set(shop, Date.now());
    incompleteCount.set(shop, (incompleteCount.get(shop) ?? 0) + 1);
    itemOnlyCount.set(shop, 0);
    logger.warn(`[CatchUp] shop=${shop} failed: ${error instanceof Error ? error.name : "error"}`);
    return "error";
  } finally {
    inFlight.delete(shop);
  }
}
