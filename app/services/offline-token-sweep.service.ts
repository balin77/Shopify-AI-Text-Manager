/**
 * Offline-Token Sweep: migration and keep-alive for shops that never open the app
 *
 * Why it exists. From 2027-01-01 Shopify rejects Admin API requests made with a
 * NON-expiring offline token (403 "Non-expiring access tokens are no longer
 * accepted for the Admin API."). The migration to an expiring token only fired
 * from a running sync scheduler — and a scheduler only runs after the merchant
 * opened the app (authenticate.admin starts it). A shop that never opens the app
 * would break on that date with nothing having tried to migrate it. A
 * non-expiring session is always "active" to the library, so opening the app
 * does not migrate it either: only `maybeMigrateToExpiringToken` does.
 *
 * What it does, per tick. Gating (offline-token-flags.server.ts): with
 * SHOPIFY_EXPIRING_OFFLINE_TOKENS off `start()` starts no timer and `tick()` does
 * nothing, not even a query. Keep-alive needs only that switch; the MIGRATION
 * part additionally needs SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS:
 *
 *   1. MIGRATE shops whose offline session has a token and NO `expires`, that are
 *      installed, whose last authenticated activity (`Session.lastActivityAt`,
 *      stamped by every authenticate.admin) is older than `SWEEP_QUIET_MS` or
 *      unknown, and that have no running scheduler. They go through the same
 *      single-flight `maybeMigrateToExpiringToken` as the scheduler trigger, so
 *      the two can never run one shop twice. Also shops whose session LOST its
 *      token mid-migration but whose durable record still holds the old token
 *      (maybeMigrateToExpiringToken recovers those). Shops with a `needs_reauth`
 *      record are skipped: Shopify refused them for good, retrying is noise.
 *   2. KEEP ALIVE shops with an EXPIRING session whose `refreshTokenExpires` lies
 *      within `KEEP_ALIVE_WINDOW_MS` (14 days) and that are quiet: acquire
 *      through `getOfflineAdmin`, which makes the library refresh the (long
 *      expired) access token. Otherwise a dormant shop's refresh token dies after
 *      90 days and the shop falls off a cliff.
 *
 *      ASSUMPTION, not verified: that a refresh restarts the 90 days. Shopify's
 *      docs say the refresh token lives "90 days when issued" and that "using it
 *      to refresh can shorten it" — which can be read the other way. The sweep
 *      therefore logs `refreshTokenExpiresBefore/After` on every keep-alive so
 *      the first real one answers the question, and it refreshes a shop at most
 *      every `KEEP_ALIVE_MIN_INTERVAL_MS` even if the expiry does NOT move (no
 *      refresh storm). If it does not move, a dormant shop will still need its
 *      merchant after 90 days and this sweep only delays it.
 *
 * Throttling: at most `BATCH_SIZE` shops per kind per tick, processed
 * SEQUENTIALLY with `PAUSE_BETWEEN_SHOPS_MS` between them (Shopify documents no
 * rate limit for migration/refresh; this is courtesy, and keeps a deploy with
 * hundreds of dormant shops from becoming one burst). The tick interval spreads
 * the rest.
 *
 * Process-local on purpose: a single web instance is guaranteed
 * (RAILWAY-SETUP.md). A second instance would not corrupt anything — the
 * single-flight is per process, and Shopify answers a repeated migration with the
 * same pair for 7 days — but it could migrate a shop twice at the same moment.
 *
 * Pattern mirrors seo/llms-auto-refresh.service.ts: singleton, idempotent
 * start()/stop(), started from app/shopify.server.ts (at boot — a dormant shop
 * means nobody authenticates — and again from authenticate.admin, which is a
 * no-op), stopped in app/entry.server.tsx.
 */

import { db } from "../db.server";
import { logger } from "../utils/logger.server";
import { getLastActivity } from "../middleware/activity-tracker.middleware";
import {
  getOfflineAdmin,
  maybeMigrateToExpiringToken,
  MIGRATION_RETRY_DELAYS_MS,
  migrationMayBeNeeded,
  releaseStaleMigrationBlock,
} from "../utils/offline-admin.server";
import { expiringOfflineTokensEnabled, migrateToExpiringTokensEnabled } from "../utils/offline-token-flags.server";
import {
  eraseOldToken,
  listBlockingRecords,
  listMigrationShopsByStatus,
  listPastWindowTokenShops,
  MIGRATION_RECOVERY_WINDOW_MS,
  storedTokenDiffers,
  type BlockingRecord,
} from "../utils/offline-token-migration-store.server";
import { syncScheduler } from "./sync-scheduler.service";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Exchange attempts in one migration run (first try + one per retry delay); sizes the persisted backoff. */
const MIGRATION_ATTEMPTS_PER_RUN = MIGRATION_RETRY_DELAYS_MS.length + 1;

/** Disable the whole sweep without a redeploy. */
const SWEEP_DISABLED = process.env.OFFLINE_TOKEN_SWEEP_DISABLED === "true";

/**
 * An env knob as a finite number >= `min`; anything else (unset, "abc", "0",
 * negative, NaN) falls back to the default. `parseInt("abc")` is NaN, and a NaN
 * interval makes `setInterval` fire in a tight loop.
 */
export function envNumber(raw: string | undefined, fallback: number, min: number): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** How often the sweep looks for work. Default 10 min, never faster than once a minute. */
export const TICK_INTERVAL_MS = envNumber(process.env.OFFLINE_TOKEN_SWEEP_INTERVAL_MS, 10 * 60 * 1000, 60 * 1000);
/** The first tick waits this long after start, so a deploy's boot work is not competing with it. */
export const FIRST_TICK_DELAY_MS = 2 * 60 * 1000;
/**
 * A shop is "quiet" after this long without an authenticated request. Longer
 * than the scheduler's own 5-minute inactivity stop, so a scheduler of this shop
 * has wound down by then (its own migration trigger is the one for active shops).
 */
export const SWEEP_QUIET_MS = 30 * 60 * 1000;
/** Shops per kind (migrate / keep-alive) per tick. */
export const BATCH_SIZE = envNumber(process.env.OFFLINE_TOKEN_SWEEP_BATCH_SIZE, 5, 1);
/** Pause between two shops of one tick. */
export const PAUSE_BETWEEN_SHOPS_MS = envNumber(process.env.OFFLINE_TOKEN_SWEEP_PAUSE_MS, 5000, 0);
/** Refresh tokens that end within this are kept alive. */
export const KEEP_ALIVE_WINDOW_MS = 14 * DAY_MS;
/** A shop is kept alive at most this often (see the ASSUMPTION note above). */
export const KEEP_ALIVE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * The candidate query reads this many times BATCH_SIZE rows, because shops in
 * backoff / uninstalled / with an active scheduler are filtered AFTER the query
 * and must not starve the ones behind them.
 */
const CANDIDATE_OVERFETCH = 10;

export interface OfflineTokenSweepStats {
  migrateCandidates: number;
  migrated: number;
  migrateNeedsReauth: number;
  migrateFailed: number;
  migrateSkipped: number;
  keepAliveCandidates: number;
  keepAliveRefreshed: number;
  keepAliveFailed: number;
}

function emptyStats(): OfflineTokenSweepStats {
  return {
    migrateCandidates: 0,
    migrated: 0,
    migrateNeedsReauth: 0,
    migrateFailed: 0,
    migrateSkipped: 0,
    keepAliveCandidates: 0,
    keepAliveRefreshed: 0,
    keepAliveFailed: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export class OfflineTokenSweepService {
  private static instance: OfflineTokenSweepService;
  private intervalId: NodeJS.Timeout | null = null;
  private firstTickId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private ticking = false;
  private readonly keepAliveAt = new Map<string, number>();

  private constructor() {}

  static getInstance(): OfflineTokenSweepService {
    if (!OfflineTokenSweepService.instance) {
      OfflineTokenSweepService.instance = new OfflineTokenSweepService();
    }
    return OfflineTokenSweepService.instance;
  }

  /**
   * Start the sweep. Idempotent — safe to call from every authenticated request.
   * With the migration switches off (default) it starts nothing.
   */
  start(): void {
    if (this.isRunning) return;
    // The timer runs with expiring tokens on: keep-alive needs only that switch;
    // the migration part inside the tick additionally needs the migrate switch.
    if (!expiringOfflineTokensEnabled()) return;
    if (SWEEP_DISABLED) {
      logger.info("[OfflineTokenSweep] Disabled via OFFLINE_TOKEN_SWEEP_DISABLED - not starting");
      return;
    }
    this.isRunning = true;
    logger.info(
      `[OfflineTokenSweep] Starting (every ${Math.round(TICK_INTERVAL_MS / 60000)}min, batch ${BATCH_SIZE}, ` +
        `quiet after ${Math.round(SWEEP_QUIET_MS / 60000)}min, keep-alive window ${Math.round(KEEP_ALIVE_WINDOW_MS / DAY_MS)}d)`,
    );
    const run = () =>
      this.tick().catch((err) =>
        logger.error("[OfflineTokenSweep] Unhandled error in tick", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    this.firstTickId = setTimeout(run, FIRST_TICK_DELAY_MS);
    this.intervalId = setInterval(run, TICK_INTERVAL_MS);
    // A sweep must never keep the process alive on its own.
    this.firstTickId.unref?.();
    this.intervalId.unref?.();
  }

  stop(): void {
    if (this.firstTickId) clearTimeout(this.firstTickId);
    if (this.intervalId) clearInterval(this.intervalId);
    this.firstTickId = null;
    this.intervalId = null;
    this.isRunning = false;
  }

  /** Test seam. */
  __resetForTests(): void {
    this.stop();
    this.ticking = false;
    this.keepAliveAt.clear();
  }

  /**
   * One sweep. Public so tests can drive it directly with a mocked db and no
   * pauses (`pauseMs: 0`), like the other sweeps' `tick()`.
   */
  async tick(now: Date = new Date(), options: { pauseMs?: number } = {}): Promise<OfflineTokenSweepStats> {
    const stats = emptyStats();
    if (!expiringOfflineTokensEnabled()) return stats;
    if (this.ticking) return stats;
    this.ticking = true;
    try {
      const pauseMs = options.pauseMs ?? PAUSE_BETWEEN_SHOPS_MS;
      if (migrateToExpiringTokensEnabled()) await this.migrateDormantShops(now, pauseMs, stats);
      await this.keepAliveShops(now, pauseMs, stats);
      if (stats.migrateCandidates || stats.keepAliveCandidates) {
        logger.info(
          `[OfflineTokenSweep] Tick done: ${stats.migrated} migrated, ${stats.migrateNeedsReauth} need re-auth, ` +
            `${stats.migrateFailed} failed, ${stats.migrateSkipped} skipped; keep-alive ${stats.keepAliveRefreshed} ` +
            `refreshed, ${stats.keepAliveFailed} failed`,
        );
      }
    } finally {
      this.ticking = false;
    }
    return stats;
  }

  /** Shops among `shops` that are uninstalled (their sessions normally are gone, but a marker is authoritative). */
  private async uninstalled(shops: string[]): Promise<Set<string>> {
    if (shops.length === 0) return new Set();
    const rows = await db.shopInstallState.findMany({
      where: { shop: { in: shops }, uninstalledAt: { not: null } },
      select: { shop: true },
    });
    return new Set(rows.map((r) => r.shop));
  }

  /**
   * Quiet RIGHT NOW (the candidate query may be a moment old). An unknown
   * activity counts as quiet only if the candidate row itself said so
   * (`lastActivityAt` null); `getLastActivity` also answers null when its
   * lookup FAILED, and that must skip the shop, not release it.
   */
  private async isQuiet(shop: string, nowMs: number, rowActivityUnknown: boolean): Promise<boolean> {
    if (syncScheduler.isShopActive(shop)) return false;
    const last = await getLastActivity(shop);
    if (!last) return rowActivityUnknown;
    return nowMs - last.getTime() >= SWEEP_QUIET_MS;
  }

  /**
   * Blocking records whose shop's stored session token no longer matches the
   * record's fingerprint. One extra read, only of the blocked shops that HAVE a
   * fingerprint (bounded), decrypting in code — the session table holds random-IV
   * ciphertext, there is nothing to compare in SQL.
   */
  private async releasedByNewToken(blocking: BlockingRecord[]): Promise<Set<string>> {
    const fingerprints = new Map(blocking.filter((r) => r.tokenFingerprint).map((r) => [r.shop, r.tokenFingerprint]));
    if (fingerprints.size === 0) return new Set();
    const rows = await db.session.findMany({
      where: {
        isOnline: false,
        id: { startsWith: "offline_" },
        expires: null,
        accessToken: { not: "" },
        shop: { in: [...fingerprints.keys()] },
      },
      select: { shop: true, accessToken: true },
      take: 500,
    });
    return new Set(rows.filter((r) => storedTokenDiffers(fingerprints.get(r.shop), r.accessToken)).map((r) => r.shop));
  }

  /**
   * Erase the ciphertext of pending/failed records past the 7-day recovery
   * window whose session holds no token (unrecoverable: a credential at rest with
   * no use). The fingerprint stays. The window is measured from OUR first attempt
   * (`startedAt`), which can only be earlier than Shopify's own start — the
   * conservative side.
   */
  private async purgeUnrecoverableTokens(now: Date): Promise<void> {
    const shops = await listPastWindowTokenShops(now.getTime());
    if (shops.length === 0) return;
    const holding = await db.session.findMany({
      where: { isOnline: false, id: { startsWith: "offline_" }, shop: { in: shops }, accessToken: { not: "" } },
      select: { shop: true },
    });
    const stillHolds = new Set(holding.map((r) => r.shop));
    for (const shop of shops) {
      if (stillHolds.has(shop)) continue;
      await eraseOldToken(shop).catch(() => undefined);
    }
  }

  private async migrateDormantShops(now: Date, pauseMs: number, stats: OfflineTokenSweepStats): Promise<void> {
    await this.purgeUnrecoverableTokens(now);
    const quietBefore = new Date(now.getTime() - SWEEP_QUIET_MS);
    // `needs_reauth` records and `failed` ones inside their persisted
    // (exponential) backoff or given up on: left out IN SQL, so they cannot sit
    // at the front of the oldest-first order and starve the shops behind them
    // — except a record whose shop now holds a DIFFERENT token than the one it
    // was written for (re-issued while the switches were off): that record is
    // stale and the shop is a candidate again (runMigration deletes the record).
    const blocking = await listBlockingRecords(now.getTime(), MIGRATION_ATTEMPTS_PER_RUN);
    const released = await this.releasedByNewToken(blocking);
    const blockedShops = blocking.map((r) => r.shop).filter((shop) => !released.has(shop));
    // Shops whose migration is half-way and whose old token is still persisted:
    // their session may have lost its token, which would hide them from a
    // "has a token" filter.
    const retriable = await listMigrationShopsByStatus(["pending", "failed"], {
      withTokenSince: new Date(now.getTime() - MIGRATION_RECOVERY_WINDOW_MS),
    });

    const rows = await db.session.findMany({
      where: {
        isOnline: false,
        id: { startsWith: "offline_" },
        expires: null,
        shop: { notIn: blockedShops },
        AND: [
          { OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: quietBefore } }] },
          { OR: [{ accessToken: { not: "" } }, { shop: { in: retriable } }] },
        ],
      },
      select: { shop: true, lastActivityAt: true },
      // Longest-quiet first; an unknown activity is the longest quiet there is.
      orderBy: { lastActivityAt: { sort: "asc", nulls: "first" } },
      take: BATCH_SIZE * CANDIDATE_OVERFETCH,
    });
    const unknownActivity = new Map(rows.map((r) => [r.shop, r.lastActivityAt === null || r.lastActivityAt === undefined]));
    const shops = [...unknownActivity.keys()];
    stats.migrateCandidates = shops.length;
    if (shops.length === 0) return;

    const gone = await this.uninstalled(shops);
    let processed = 0;
    for (const shop of shops) {
      if (processed >= BATCH_SIZE) break;
      // Not installed, being migrated right now (scheduler trigger), in backoff,
      // settled, or refused for good in this process: nothing to do.
      // A candidate is not blocked by any record. If this process still holds a
      // backoff / needs_reauth verdict for it, the row was reset or deleted since
      // (operator SQL): honour the database, not the memory.
      releaseStaleMigrationBlock(shop);
      if (gone.has(shop) || !migrationMayBeNeeded(shop) || !(await this.isQuiet(shop, now.getTime(), unknownActivity.get(shop) ?? false))) {
        stats.migrateSkipped++;
        continue;
      }
      if (processed > 0) await sleep(pauseMs);
      processed++;
      const outcome = await maybeMigrateToExpiringToken(shop);
      if (outcome === "migrated") stats.migrated++;
      else if (outcome === "needs_reauth") stats.migrateNeedsReauth++;
      else if (outcome === "failed") stats.migrateFailed++;
      else stats.migrateSkipped++;
    }
  }

  private async keepAliveShops(now: Date, pauseMs: number, stats: OfflineTokenSweepStats): Promise<void> {
    const quietBefore = new Date(now.getTime() - SWEEP_QUIET_MS);
    const rows = await db.session.findMany({
      where: {
        isOnline: false,
        id: { startsWith: "offline_" },
        expires: { not: null },
        refreshToken: { not: null },
        // Already-dead refresh tokens are not retried (it can only fail again).
        refreshTokenExpires: { gt: now, lt: new Date(now.getTime() + KEEP_ALIVE_WINDOW_MS) },
        OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: quietBefore } }],
      },
      select: { shop: true, refreshTokenExpires: true, lastActivityAt: true },
      orderBy: { refreshTokenExpires: "asc" },
      take: BATCH_SIZE * CANDIDATE_OVERFETCH,
    });
    stats.keepAliveCandidates = rows.length;
    if (rows.length === 0) return;

    const gone = await this.uninstalled(rows.map((r) => r.shop));
    let processed = 0;
    for (const row of rows) {
      if (processed >= BATCH_SIZE) break;
      const last = this.keepAliveAt.get(row.shop);
      if (gone.has(row.shop) || (last !== undefined && now.getTime() - last < KEEP_ALIVE_MIN_INTERVAL_MS)) continue;
      if (!(await this.isQuiet(row.shop, now.getTime(), row.lastActivityAt === null || row.lastActivityAt === undefined))) continue;
      if (processed > 0) await sleep(pauseMs);
      processed++;
      this.keepAliveAt.set(row.shop, now.getTime());
      try {
        // The library refreshes a session within 5 min of its expiry — a
        // dormant shop's access token ended long ago, so this IS the refresh.
        const { session } = await getOfflineAdmin(row.shop);
        stats.keepAliveRefreshed++;
        logger.info("[OfflineTokenSweep] Keep-alive refresh", {
          shop: row.shop,
          refreshTokenExpiresBefore: row.refreshTokenExpires?.toISOString(),
          refreshTokenExpiresAfter: session.refreshTokenExpires
            ? new Date(session.refreshTokenExpires as unknown as string | number | Date).toISOString()
            : null,
        });
      } catch (error) {
        stats.keepAliveFailed++;
        logger.warn("[OfflineTokenSweep] Keep-alive refresh failed", {
          shop: row.shop,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
