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
 *    NEW 401 block is set (blocks that exist stay). A SECOND shop with a 401
 *    inside the window already holds an `admin_api_401` block back (two shops at
 *    once is not what merchants revoking the app looks like either); the loud
 *    line needs three. Only the `admin_api_401`
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
import { notifyOps } from "../services/ops-alert.server";
import {
  clearConnectionBlock,
  getConnectionBlock,
  markConnectionBlocked,
  type ConnectionBlock,
  type ConnectionBlockState,
  type MarkBlockedResult,
} from "./shop-connection-state.server";

type Env = Record<string, string | undefined>;

/**
 * SHOP_BLOCK_ON_ADMIN_401: may a double 401 set a block? Exactly "true" turns it
 * on, default OFF (like the token switches) -- the owner decides when. A 401 is
 * the weakest evidence; a wrong block of that kind is lifted by the first
 * successful call with the stored access (noteSuccessfulCall) and, since plan
 * step 12, by the connection sweep's probe every 6 hours
 * (shop-connection-sweep.service.ts), so turning it on is now safe. With it off
 * the double-401 sites keep their old behaviour (log, original error). The
 * terminal-evidence reasons (no_token, invalid_subject_token,
 * refresh_token_expired, migration_needs_reauth, and the final token_endpoint_404
 * / token_endpoint_403 kinds) are not affected.
 */
export function blockOnAdmin401Enabled(env: Env = process.env): boolean {
  return env.SHOP_BLOCK_ON_ADMIN_401?.trim() === "true";
}

export const MASS_401_WINDOW_MS = 10 * 60 * 1000;
export const MASS_401_SHOPS = 3;
export const MASS_401_SUPPRESS_MS = 60 * 60 * 1000;

/** shop -> when it last got a 401 (inside the window). */
const recentUnauthorized = new Map<string, number>();
let suppress401Until = 0;
const noRowLogged = new Set<string>();
const successChecked = new Map<string, number>();
/** noteSuccessfulCall looks at a shop at most this often. */
export const SUCCESS_CHECK_INTERVAL_MS = 30_000;

/** Test seam. */
export function __resetConnectionBlockForTests(): void {
  recentUnauthorized.clear();
  suppress401Until = 0;
  noRowLogged.clear();
  successChecked.clear();
}

/**
 * A 401 for `shop` was CONFIRMED: the retry with the very same token failed
 * too. A 401 the retry resolved (a rotated token) must not be reported here.
 * Call it before `blockShopConnection`, whether or not the 401 switch is on, so
 * the loud MASS_401 line works either way. Cheap, in memory, never throws.
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
    // Ops alert (at most once an hour per key): the one case besides the IP
    // allowlist the owner wants to hear about -- never one alert per block.
    notifyOps(
      "mass_401",
      `${recentUnauthorized.size} shops got a 401 within ${Math.round(MASS_401_WINDOW_MS / 60000)} min: this looks like our credentials or Shopify, not merchants. ` +
        "New 401 blocks are held back for an hour. Check SHOPIFY_API_SECRET and Shopify status.",
    );
  }
}

/** Did ANOTHER shop get a 401 inside the window? Then this shop's 401 is held back. */
function otherShopHad401(shop: string): boolean {
  const now = Date.now();
  for (const [s, at] of recentUnauthorized) {
    if (now - at > MASS_401_WINDOW_MS) recentUnauthorized.delete(s);
    else if (s !== shop) return true;
  }
  return false;
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
 * Returns the STORED block when the shop is blocked afterwards (newly, or it
 * already was), else null (fenced, held back, no row, error).
 */
export async function blockShopConnection(
  shop: string,
  reason: string,
  opts: { observedAt: Date; state?: ConnectionBlockState },
): Promise<ConnectionBlock | null> {
  try {
    const state: ConnectionBlockState = opts.state ?? "needs_reauth";
    // Already blocked: nothing to add, and a final kind such as access_denied
    // must not be turned back into needs_reauth. Answered from the 30 s cache,
    // so a loop of failing callers costs no query. Only a FINAL kind
    // (`opts.state`: shop_not_found / access_denied, terminal evidence from the
    // token migration) may replace the weaker needs_reauth it finds.
    const existing = await getConnectionBlock(shop);
    if (existing && !(state !== "needs_reauth" && existing.state === "needs_reauth")) return existing;
    if (reason === "admin_api_401" && !blockOnAdmin401Enabled()) return null;
    if (reason === "admin_api_401" && (isMass401Active() || otherShopHad401(shop))) {
      logger.debug(`[ConnectionState] 401 block for ${shop} held back (mass-401 guard)`);
      return null;
    }
    let result: MarkBlockedResult = await markConnectionBlocked(shop, state, reason, opts);
    if (!result.changed && result.why === "no_row") {
      if (!noRowLogged.has(shop)) {
        noRowLogged.add(shop);
        logger.warn(`[ConnectionState] no ShopInstallState row for ${shop}; creating one only if an offline session exists`);
      }
      if (await ensureInstallStateForSessionShop(shop)) {
        result = await markConnectionBlocked(shop, state, reason, opts);
      }
    }
    if (!(result.changed || result.why === "unchanged")) return null;
    return (
      (await getConnectionBlock(shop)) ?? {
        state,
        since: null,
        reason: reason.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64),
      }
    );
  } catch {
    return null;
  }
}

/**
 * A call made with the stored offline token SUCCEEDED. Lifts an `admin_api_401`
 * block (and only that kind: terminal evidence such as an empty token stays
 * until a real re-authentication) when the call started AFTER the block was
 * set -- a success that began before it proves nothing about the token the
 * block was set on. Without this a wrong 401 block on a shop whose token still
 * works could never be lifted: no token exchange means no afterAuth.
 * Looks at a shop at most every 30 s; never throws.
 */
export async function noteSuccessfulCall(shop: string, startedAt: Date): Promise<void> {
  try {
    const now = Date.now();
    const last = successChecked.get(shop);
    if (last !== undefined && now - last < SUCCESS_CHECK_INTERVAL_MS) return;
    successChecked.set(shop, now);
    const block = await getConnectionBlock(shop);
    if (!block || block.reason !== "admin_api_401" || !block.since) return;
    if (startedAt.getTime() <= block.since.getTime()) return;
    // Conditional in the database: a terminal block that appeared meanwhile stays.
    await clearConnectionBlock(shop, "probe_ok", { onlyIfReason: "admin_api_401" });
  } catch {
    /* never throws */
  }
}

/**
 * afterAuth: a new offline session was stored, so the shop is authenticated
 * again. Lifts any block with the cause the existing install marker tells
 * (`reinstall` if the shop was marked uninstalled, else `reauth`) and stamps the
 * fence, so a call that began before this instant cannot block it again. MUST be
 * called before the uninstall marker is cleared. Never throws.
 */
export async function liftConnectionBlockAfterAuth(shop: string): Promise<void> {
  try {
    let wasUninstalled = false;
    try {
      const db = await dbClient();
      const row = await db.shopInstallState.findUnique({ where: { shop }, select: { uninstalledAt: true } });
      wasUninstalled = !!row?.uninstalledAt;
      // The fence lives on the row: make sure there is one (a minimal row, the
      // same thing afterAuth creates a moment later) so the clear can stamp it.
      await db.shopInstallState.createMany({ data: [{ shop }], skipDuplicates: true });
    } catch {
      /* unknown: treated as a plain re-authentication */
    }
    await clearConnectionBlock(shop, wasUninstalled ? "reinstall" : "reauth");
  } catch {
    /* never throws */
  }
}
