/**
 * The ONE door to a shop's connection state (PLAN_ADMIN_SHOP_OVERVIEW 2.1):
 * "may background code still talk to Shopify for this shop, and if not, why".
 * The columns live on ShopInstallState; the verdict shown to the owner is
 * derived by app/services/shop-connection-status.shared.ts.
 *
 * Blocks are SET at the evidence points of plan step 7 (through
 * shop-connection-block.server.ts: the second 401 with the same token in both
 * admin clients -- ONLY with SHOP_BLOCK_ON_ADMIN_401=true, default off; the
 * step-12 probe exists now and the owner decides --, an empty token, a terminal refresh failure, the
 * migration's needs_reauth, a 404 / shop-specific 403 of the token endpoint over
 * 24 h) and READ by createAdminClientFromShop. They are LIFTED by afterAuth, the
 * uninstall webhook, a finished token migration and the connection sweep's probe.
 *
 * Rules that are load-bearing:
 *  - `markConnectionBlocked` / `clearConnectionBlock` act ONLY on a state change
 *    and log exactly one line for it. The guarantee is a conditional
 *    `updateMany` in the database, so it holds across restarts and instances,
 *    not a flag in memory.
 *  - The FENCE: `connectionClearedAt` is stamped on every clear. A failure
 *    observed by a call that BEGAN before that instant (`observedAt`) cannot
 *    block the shop again -- a request that was already in flight when the
 *    merchant re-authorised would otherwise undo the re-authorisation.
 *  - No function here creates a ShopInstallState row. A missing row means the
 *    shop is unknown (or was redacted); inventing one would read as a fresh
 *    install (initialSyncCompletedAt = null) and could resurrect a redacted
 *    shop. A write for a shop without a row is a no-op that says so.
 *  - Reading fails OPEN (an unreadable state is "not blocked"): blocking is an
 *    optimisation that protects the logs, and a database blip must not silence
 *    a healthy shop. Writers never throw.
 *  - No token or secret is ever read, stored or logged; reasons are codes.
 *
 * `db` is imported lazily (like offline-token-migration-store.server.ts) so the
 * module stays importable in a unit test without a database.
 */

import { logger } from "./logger.server";
import {
  deriveConnectionStatus,
  type ConnectionBlockState,
  type ConnectionInstallFacts,
  type ConnectionMigrationFacts,
  type ConnectionSessionFacts,
  type ConnectionStatusResult,
} from "../services/shop-connection-status.shared";

export type { ConnectionBlockState } from "../services/shop-connection-status.shared";

export type ConnectionClearCause = "reauth" | "reinstall" | "probe_ok" | "uninstalled";

export interface ConnectionBlock {
  state: ConnectionBlockState;
  since: Date | null;
  reason: string | null;
}

/** getConnectionBlock answers from memory for this long (one instance, see RAILWAY-SETUP). */
export const CONNECTION_CACHE_TTL_MS = 30_000;
/** recordWebhookSeen writes at most this often per shop. */
export const WEBHOOK_SEEN_WRITE_INTERVAL_MS = 10 * 60 * 1000;

const MAX_REASON_LENGTH = 64;

export class ShopConnectionBlockedError extends Error {
  readonly code = "SHOP_CONNECTION_BLOCKED" as const;
  readonly shop: string;
  readonly state: ConnectionBlockState;
  readonly reason: string | null;
  readonly since: Date | null;
  constructor(shop: string, block: ConnectionBlock) {
    // "401" is in the text so the existing 401 recognisers (webhook retry,
    // cleanup of auth failures) keep treating this like the failure it replaces.
    super(`Shopify 401: connection for ${shop} is blocked (${block.state}${block.reason ? `: ${block.reason}` : ""})`);
    this.name = "ShopConnectionBlockedError";
    this.shop = shop;
    this.state = block.state;
    this.reason = block.reason;
    this.since = block.since;
  }
}

/** Recognise the error by shape: it crosses dynamic-import boundaries, `instanceof` may not hold. */
export function isShopConnectionBlockedError(err: unknown): err is ShopConnectionBlockedError {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "SHOP_CONNECTION_BLOCKED";
}

// ── cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  block: ConnectionBlock | null;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
// Bumped on EVERY write (and invalidation) of a shop. A read or a write takes
// the value from BEFORE its database call and caches its answer only if it is
// unchanged afterwards, so a slower call that overlapped another write cannot
// cache the state from before it. `epoch` is the same guard for the
// shop-less invalidation: it must also stop a call in flight for a shop that
// has no generation entry yet.
const generation = new Map<string, number>();
const generationOf = (shop: string): number => generation.get(shop) ?? 0;
let epoch = 0;
const bump = (shop: string): void => {
  generation.set(shop, generationOf(shop) + 1);
};
const webhookSeenWrittenAt = new Map<string, number>();

interface Mark {
  gen: number;
  epoch: number;
}
const markBefore = (shop: string): Mark => ({ gen: generationOf(shop), epoch });
const markMoved = (shop: string, m: Mark): boolean => generationOf(shop) !== m.gen || epoch !== m.epoch;

function cacheSet(shop: string, block: ConnectionBlock | null): void {
  cache.set(shop, { block, expiresAt: Date.now() + CONNECTION_CACHE_TTL_MS });
}

/**
 * A write finished: cache its result only if nothing else touched the shop (or
 * invalidated everything) since the write BEGAN. A write whose database call
 * committed before another write's but replied after it would otherwise cache
 * the older state on top of the newer one; if anything moved, the cache is
 * dropped and the next read decides.
 */
function settleWrite(shop: string, before: Mark, block: ConnectionBlock | null): void {
  const moved = markMoved(shop, before);
  bump(shop);
  if (moved) cache.delete(shop);
  else cacheSet(shop, block);
}

/** Drop the cached answer of one shop, or of all (tests, redact). */
export function invalidateConnectionCache(shop?: string): void {
  if (shop === undefined) {
    epoch++;
    for (const key of new Set([...cache.keys(), ...generation.keys()])) bump(key);
    cache.clear();
    webhookSeenWrittenAt.clear();
  } else {
    bump(shop);
    cache.delete(shop);
    webhookSeenWrittenAt.delete(shop);
  }
}

async function dbClient() {
  const { db } = await import("../db.server");
  return db;
}

function sanitizeReason(reason: string): string {
  // A code, not a message: lowercase word characters only, so a stray token or
  // sentence passed by mistake cannot be stored or logged verbatim.
  const cleaned = reason.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, MAX_REASON_LENGTH);
  return cleaned || "unknown";
}

// ── reading ──────────────────────────────────────────────────────────────────

/** The shop's current block, or `null` when none is known (also when the read fails). */
export async function getConnectionBlock(shop: string): Promise<ConnectionBlock | null> {
  const hit = cache.get(shop);
  if (hit && hit.expiresAt > Date.now()) return hit.block;
  const before = markBefore(shop);
  try {
    const db = await dbClient();
    const row = await db.shopInstallState.findUnique({
      where: { shop },
      select: { connectionState: true, connectionStateSince: true, connectionStateReason: true },
    });
    const s = row?.connectionState;
    const block: ConnectionBlock | null =
      s === "needs_reauth" || s === "access_denied" || s === "shop_not_found"
        ? { state: s, since: row?.connectionStateSince ?? null, reason: row?.connectionStateReason ?? null }
        : null;
    if (!markMoved(shop, before)) cacheSet(shop, block);
    return block;
  } catch (error) {
    // Fail open and do not cache the failure.
    logger.debug(`[ConnectionState] read failed for ${shop}: ${error instanceof Error ? error.name : "error"}`);
    return null;
  }
}

// ── writing ──────────────────────────────────────────────────────────────────

export type MarkBlockedResult =
  | { changed: true }
  | { changed: false; why: "unchanged" | "fenced" | "no_row" | "error" };

/**
 * Block the shop, or change the kind of an existing block. `observedAt` is
 * REQUIRED, deliberately without a default: it is when the failing call BEGAN
 * (capture it before sending the request), and a failure that started before
 * the last clear is ignored (the fence). Defaulting it to "now" would stamp the
 * moment the failure was noticed and defeat the fence for every call that was
 * already in flight when the merchant re-authorised.
 *
 * A no-op for a shop already in the same state.
 *
 * `{ changed: false, why: "no_row" }` MUST be handled by the step-7 caller: this
 * module never creates a ShopInstallState row (a fresh row reads as a new
 * install and could resurrect a redacted shop), so for a shop without one the
 * block silently does not exist. The caller logs that ONCE and creates a minimal
 * row only when an offline Session exists for the shop (see PLAN_ADMIN_SHOP_OVERVIEW 2.2).
 *
 * The block KIND changing (e.g. needs_reauth -> shop_not_found) restarts
 * `connectionStateSince` ON PURPOSE: the 404 window of "presumed uninstalled"
 * (7 days) and the 24 h "give up" rules are measured from when THAT kind began.
 */
export async function markConnectionBlocked(
  shop: string,
  state: ConnectionBlockState,
  reason: string,
  opts: { observedAt: Date },
): Promise<MarkBlockedResult> {
  try {
    const before = markBefore(shop);
    const db = await dbClient();
    const now = new Date();
    const { observedAt } = opts;
    const code = sanitizeReason(reason);
    const res = await db.shopInstallState.updateMany({
      where: {
        shop,
        OR: [{ connectionState: null }, { connectionState: { not: state } }],
        AND: [{ OR: [{ connectionClearedAt: null }, { connectionClearedAt: { lte: observedAt } }] }],
      },
      data: { connectionState: state, connectionStateSince: now, connectionStateReason: code },
    });
    if (res.count > 0) {
      settleWrite(shop, before, { state, since: now, reason: code });
      logger.warn(`[ConnectionState] BLOCKED shop=${shop} state=${state} reason=${code}`);
      return { changed: true };
    }
    // Zero rows: say WHY (one cheap read), so callers and tests can tell the cases apart.
    const row = await db.shopInstallState.findUnique({
      where: { shop },
      select: { connectionState: true, connectionClearedAt: true },
    });
    if (!row) return { changed: false, why: "no_row" };
    if (row.connectionState === state) return { changed: false, why: "unchanged" };
    return { changed: false, why: "fenced" };
  } catch (error) {
    logger.debug(`[ConnectionState] mark failed for ${shop}: ${error instanceof Error ? error.name : "error"}`);
    return { changed: false, why: "error" };
  }
}

export interface ClearBlockResult {
  /** A block existed and was lifted (the only case that logs). */
  cleared: boolean;
  droppedWebhookCount: number;
  resyncRequiredSince: Date | null;
}

/**
 * Lift the block (if any) and stamp the fence. `resyncRequiredSince` and the
 * dropped count are KEPT: they say what the catch-up still owes. Safe to call
 * for a shop that is not blocked (it only moves the fence).
 */
export async function clearConnectionBlock(
  shop: string,
  cause: ConnectionClearCause,
  opts: { onlyIfReason?: string } = {},
): Promise<ClearBlockResult> {
  const none: ClearBlockResult = { cleared: false, droppedWebhookCount: 0, resyncRequiredSince: null };
  try {
    const mark = markBefore(shop);
    const db = await dbClient();
    const now = new Date();
    const before = await db.shopInstallState.findUnique({
      where: { shop },
      select: { droppedWebhookCount: true, resyncRequiredSince: true },
    });
    const lifted = await db.shopInstallState.updateMany({
      where: opts.onlyIfReason
        ? { shop, connectionState: "needs_reauth", connectionStateReason: opts.onlyIfReason }
        : { shop, connectionState: { not: null } },
      data: {
        connectionState: null,
        connectionStateSince: null,
        connectionStateReason: null,
        connectionClearedAt: now,
        connectionClearedCause: cause,
      },
    });
    if (lifted.count === 0 && opts.onlyIfReason) {
      // A conditional clear that found another block (or none): leave the row
      // and the fence alone, and let the next read decide.
      bump(shop);
      cache.delete(shop);
      return none;
    }
    if (lifted.count === 0) {
      // Not blocked: still move the fence, so a call that began before this
      // instant cannot block the shop when it fails late.
      await db.shopInstallState.updateMany({
        where: { shop, connectionState: null },
        data: { connectionClearedAt: now, connectionClearedCause: cause },
      });
    }
    settleWrite(shop, mark, null);
    const dropped = before?.droppedWebhookCount ?? 0;
    const resync = before?.resyncRequiredSince ?? null;
    if (lifted.count > 0) {
      logger.info(`[ConnectionState] UNBLOCKED shop=${shop} cause=${cause} droppedWebhooks=${dropped}`);
      return { cleared: true, droppedWebhookCount: dropped, resyncRequiredSince: resync };
    }
    return { ...none, droppedWebhookCount: dropped, resyncRequiredSince: resync };
  } catch (error) {
    logger.debug(`[ConnectionState] clear failed for ${shop}: ${error instanceof Error ? error.name : "error"}`);
    // The cached answer may now be wrong either way; let the next read decide.
    invalidateConnectionCache(shop);
    return none;
  }
}

/**
 * A webhook of a blocked shop was accepted but not processed: count it and owe a
 * catch-up. Never creates a row, never throws, logs at debug only.
 */
export async function noteDroppedWebhook(shop: string): Promise<void> {
  try {
    const db = await dbClient();
    const res = await db.shopInstallState.updateMany({
      where: { shop },
      data: { droppedWebhookCount: { increment: 1 } },
    });
    if (res.count === 0) return;
    await db.shopInstallState.updateMany({
      where: { shop, resyncRequiredSince: null },
      data: { resyncRequiredSince: new Date() },
    });
    logger.debug(`[ConnectionState] webhook dropped for blocked shop ${shop}`);
  } catch (error) {
    logger.debug(`[ConnectionState] noteDroppedWebhook failed for ${shop}: ${error instanceof Error ? error.name : "error"}`);
  }
}

/**
 * A webhook with a valid signature arrived: remember `X-Shopify-Triggered-At`
 * (evidence for "installed"). Written at most every 10 minutes per shop and
 * never backwards. Never creates a row, never throws.
 */
export async function recordWebhookSeen(shop: string, triggeredAt?: Date | string | null): Promise<void> {
  try {
    const nowMs = Date.now();
    const last = webhookSeenWrittenAt.get(shop);
    if (last !== undefined && nowMs - last < WEBHOOK_SEEN_WRITE_INTERVAL_MS) return;
    let at = triggeredAt ? new Date(triggeredAt) : new Date(nowMs);
    if (Number.isNaN(at.getTime())) at = new Date(nowMs);
    // A header from the future is not evidence of anything; clamp it.
    if (at.getTime() > nowMs) at = new Date(nowMs);
    webhookSeenWrittenAt.set(shop, nowMs);
    const db = await dbClient();
    await db.shopInstallState.updateMany({
      where: { shop, OR: [{ lastWebhookAt: null }, { lastWebhookAt: { lt: at } }] },
      data: { lastWebhookAt: at },
    });
  } catch (error) {
    webhookSeenWrittenAt.delete(shop);
    logger.debug(`[ConnectionState] recordWebhookSeen failed for ${shop}: ${error instanceof Error ? error.name : "error"}`);
  }
}

// ── read model loader ────────────────────────────────────────────────────────

interface SessionShapeRow {
  expires: Date | null;
  refreshTokenExpires: Date | null;
  tokenEmpty: boolean;
  hasRefreshToken: boolean;
}

/**
 * Load the facts for ONE shop and derive its status. The session is read as a
 * SHAPE through SQL (booleans and dates), so the token never enters memory; the
 * migration is read without its encrypted columns. The /admin overview needs a
 * batched variant of this later (one query for all shops); this is the
 * single-shop one for the sweep, the probe and the detail view.
 */
export async function loadConnectionStatus(shop: string, now: Date = new Date()): Promise<ConnectionStatusResult> {
  const db = await dbClient();
  const [install, sessionRows, migration] = await Promise.all([
    db.shopInstallState.findUnique({
      where: { shop },
      select: {
        uninstalledAt: true,
        uninstallSource: true,
        reinstallEvidenceAt: true,
        connectionState: true,
        connectionStateSince: true,
        connectionStateReason: true,
        resyncRequiredSince: true,
        droppedWebhookCount: true,
        lastWebhookAt: true,
        lastActivityAt: true,
        lastAuthAt: true,
      },
    }),
    db.$queryRaw<SessionShapeRow[]>`
      SELECT "expires", "refreshTokenExpires",
             ("accessToken" = '') AS "tokenEmpty",
             ("refreshToken" IS NOT NULL AND "refreshToken" <> '') AS "hasRefreshToken"
      FROM "Session"
      WHERE "shop" = ${shop} AND "isOnline" = false
      ORDER BY "id"
      LIMIT 1`,
    db.offlineTokenMigration.findUnique({
      where: { shop },
      select: { status: true, attempts: true, failureKind: true, failureKindSince: true },
    }),
  ]);
  const s = sessionRows[0];
  const session: ConnectionSessionFacts | null = s
    ? {
        tokenEmpty: !!s.tokenEmpty,
        hasRefreshToken: !!s.hasRefreshToken,
        expires: s.expires,
        refreshTokenExpires: s.refreshTokenExpires,
      }
    : null;
  return deriveConnectionStatus({
    now,
    install: install as ConnectionInstallFacts | null,
    session,
    migration: migration as ConnectionMigrationFacts | null,
  });
}
