/**
 * The EVIDENCE side of the connection block (PLAN_ADMIN_SHOP_OVERVIEW 2.2).
 * shop-connection-state.server.ts is the door to the stored state; this module
 * is what the code that OBSERVES a dead access calls, and it adds the three
 * rules the door deliberately does not know:
 *
 *  - The mass-401 guard. A 401 is weak evidence on its own: if several shops
 *    get one at the same time, the cause is more likely ours or Shopify's
 *    (a rotated secret, an outage) than a dozen merchants revoking the app at
 *    once. At least MASS_401_SHOPS distinct shops with a 401 inside
 *    MASS_401_WINDOW_MS trip the guard: ONE loud line, and for the next hour no
 *    NEW 401 block is set (blocks that exist stay). Only the `admin_api_401`
 *    reason is held back -- terminal evidence (an empty token, a refresh token
 *    that has expired) says something about that one shop whatever the others do.
 *  - `no_row`. markConnectionBlocked never creates a ShopInstallState row (a
 *    fresh row reads like a new install and could resurrect a redacted shop).
 *    The caller owns that case: it logs once per shop and creates a MINIMAL row
 *    -- the shop key and nothing else, i.e. exactly what a missing row already
 *    means to every reader (initialSyncCompletedAt null, uninstalledAt null) --
 *    ONLY when an offline Session exists for the shop. Redaction deletes the
 *    sessions, so a session is the proof that the shop is not redacted.
 *  - `observedAt` is required here as well: the START of the failing call.
 *
 * Never throws. Resolves to whether the shop is now blocked (by this call or
 * already), so a caller can replace its own error log with the BLOCKED line.
 */

import { logger } from "./logger.server";
import { getConnectionBlock, markConnectionBlocked, type MarkBlockedResult } from "./shop-connection-state.server";

export const MASS_401_WINDOW_MS = 10 * 60 * 1000;
export const MASS_401_SHOPS = 3;
export const MASS_401_SUPPRESS_MS = 60 * 60 * 1000;

/** shop -> when it last got a 401 (inside the window). */
const recentUnauthorized = new Map<string, number>();
let suppress401Until = 0;
const noRowLogged = new Set<string>();

/** Test seam. */
export function __resetConnectionBlockForTests(): void {
  recentUnauthorized.clear();
  suppress401Until = 0;
  noRowLogged.clear();
}

/**
 * A request for `shop` was answered with a 401. Call it for the FIRST 401 of a
 * call, before anything is decided, so the guard sees the burst early. Cheap,
 * in memory, never throws.
 */
export function noteUnauthorized(shop: string): void {
  const now = Date.now();
  recentUnauthorized.set(shop, now);
  for (const [s, at] of recentUnauthorized) {
    if (now - at > MASS_401_WINDOW_MS) recentUnauthorized.delete(s);
  }
  if (recentUnauthorized.size >= MASS_401_SHOPS && now >= suppress401Until) {
    suppress401Until = now + MASS_401_SUPPRESS_MS;
    logger.error(
      `[ConnectionState] MASS_401 -- ${recentUnauthorized.size} shops got a 401 within ${Math.round(MASS_401_WINDOW_MS / 60000)} min; ` +
        `this looks like our credentials or Shopify, not merchants. No NEW 401 blocks for ${Math.round(MASS_401_SUPPRESS_MS / 60000)} min ` +
        `(existing blocks stay). Check SHOPIFY_API_SECRET / client credentials and Shopify status first.`,
    );
  }
}

/** Is a new 401 block held back right now? */
export function isMass401Active(): boolean {
  return Date.now() < suppress401Until;
}

async function dbClient() {
  const { db } = await import("../db.server");
  return db;
}

/** A minimal row, only for a shop that provably has an offline session. Never throws. */
async function ensureInstallStateForSessionShop(shop: string): Promise<boolean> {
  try {
    const db = await dbClient();
    const session = await db.session.findFirst({ where: { shop, isOnline: false }, select: { id: true } });
    if (!session) return false;
    await db.shopInstallState.createMany({ data: [{ shop }], skipDuplicates: true });
    return true;
  } catch (error) {
    logger.debug(`[ConnectionState] could not create the install-state row for ${shop}: ${error instanceof Error ? error.name : "error"}`);
    return false;
  }
}

/**
 * Block `shop` as `needs_reauth`. `observedAt` is when the failing call BEGAN.
 * Returns true when the shop is blocked afterwards (newly, or it already was).
 */
export async function blockShopConnection(
  shop: string,
  reason: string,
  opts: { observedAt: Date },
): Promise<boolean> {
  try {
    // Already blocked (any kind): nothing to add, and a final kind such as
    // access_denied must not be turned back into needs_reauth. Answered from
    // the 30 s cache, so a loop of failing callers costs no query.
    if (await getConnectionBlock(shop)) return true;
    if (reason === "admin_api_401" && isMass401Active()) {
      logger.debug(`[ConnectionState] 401 block for ${shop} held back (mass-401 guard)`);
      return false;
    }
    let result: MarkBlockedResult = await markConnectionBlocked(shop, "needs_reauth", reason, opts);
    if (!result.changed && result.why === "no_row") {
      if (!noRowLogged.has(shop)) {
        noRowLogged.add(shop);
        logger.warn(`[ConnectionState] no ShopInstallState row for ${shop}; creating one only if an offline session exists`);
      }
      if (await ensureInstallStateForSessionShop(shop)) {
        result = await markConnectionBlocked(shop, "needs_reauth", reason, opts);
      }
    }
    return result.changed || result.why === "unchanged";
  } catch {
    return false;
  }
}
