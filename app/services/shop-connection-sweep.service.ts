/**
 * Connection sweep (PLAN_ADMIN_SHOP_OVERVIEW 2.6): keeps the stored connection
 * state of every shop honest, independent of the token-migration switches.
 *
 * Per tick (every 10 min):
 *
 *  1. BACKFILL, once per process, idempotent, switchable off
 *     (SHOP_CONNECTION_BACKFILL_DISABLED=true). Shops that were already dead
 *     before the state existed are recorded from evidence the database holds:
 *       - a migration record in `needs_reauth` (unless the shop holds a
 *         DIFFERENT token now: it re-authenticated) -> needs_reauth;
 *       - an offline session with an EMPTY token and no migration that can still
 *         recover it (pending/failed with the old token persisted) -> needs_reauth;
 *       - a failed record whose last error was a 404 and that has no kind yet
 *         -> failureKind not_found.
 *     403 records are left alone: they may come from the IP allowlist. No manual
 *     database work.
 *  2. PROBE of blocked shops every 6 hours: one `{ shop { id } }` with the stored
 *     token. A success lifts the block (cause probe_ok) and records
 *     lastApiOkAt; anything else records only lastProbeAt. A 403 is classified
 *     (shopify-forbidden.server.ts) and NEVER blocks or empties anything; a 401
 *     leaves the block as it is. Never for an uninstalled shop, never while the
 *     global IP-allowlist pause or the migration config hold is in force, at most
 *     PROBE_BATCH shops per tick with a pause between them. A shop without a
 *     token (nothing to probe with) is only stamped, so it does not sit at the
 *     front of the queue. A successful probe also drops a migration record that
 *     failed with a 404 / shop-specific 403: the shop works, so that verdict is
 *     stale and the migration may try afresh.
 *  3. CATCH-UP for unblocked, installed shops that owe one (resyncRequiredSince)
 *     and whose scheduler is not running (the scheduler does it itself for an
 *     active shop): `runWebhookCatchUp`, a few per tick. It runs without a sync
 *     slot (the scheduler's is private), hence the small bound.
 *  4. SUMMARY: one line a day with the blocked shops, what is owed and what the
 *     probes did.
 *
 * Process-local state only (one web instance, RAILWAY-SETUP). Never throws out
 * of a tick. Mirrors the other sweeps: singleton, idempotent start/stop, the
 * timer never keeps the process alive. Started at boot from shopify.server.ts
 * and stopped in entry.server.tsx.
 */

import { db } from "../db.server";
import { logger } from "../utils/logger.server";
import {
  getOfflineAdmin,
  isMigrationConfigHeld,
  isUnauthorizedError,
  OfflineAdminUnavailableError,
  reportNonExpiringTokenRejection,
} from "../utils/offline-admin.server";
import { blockShopConnection } from "../utils/shop-connection-block.server";
import { clearConnectionBlock } from "../utils/shop-connection-state.server";
import {
  deleteSingleAttemptKindRecord,
  listMigrationShopsByStatus,
  MIGRATION_MAX_ATTEMPTS,
  MIGRATION_RECOVERY_WINDOW_MS,
  storedTokenDiffers,
} from "../utils/offline-token-migration-store.server";
import { classifyForbidden, isIpAllowlistPaused, noteApiSuccess, reportForbidden } from "../utils/shopify-forbidden.server";

const HOUR_MS = 60 * 60 * 1000;

/** A positive integer from the environment, else the default. */
function envMs(raw: string | undefined, fallback: number, min: number): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export const TICK_INTERVAL_MS = envMs(process.env.SHOP_CONNECTION_SWEEP_INTERVAL_MS, 10 * 60 * 1000, 60 * 1000);
export const FIRST_TICK_DELAY_MS = 3 * 60 * 1000;
/** A blocked shop is probed at most this often (durable: ShopInstallState.lastProbeAt). */
export const PROBE_INTERVAL_MS = 6 * HOUR_MS;
/** Shops probed per tick. */
export const PROBE_BATCH = 5;
export const PROBE_PAUSE_MS = envMs(process.env.SHOP_CONNECTION_SWEEP_PAUSE_MS, 2000, 0);
/** The candidate read is this many times PROBE_BATCH, because tokenless shops are only stamped. */
const PROBE_OVERFETCH = 10;
/** Catch-ups that really ran (done / incomplete) per tick. */
export const CATCHUP_BATCH = 2;
/** Candidates read per tick; busy, paused or failing ones are skipped, not counted. */
export const CATCHUP_CANDIDATES = 50;
/** Catch-ups STARTED per tick, whatever came of them. */
export const CATCHUP_MAX_STARTS = 5;
/** A shop whose catch-up was tried waits this long before the sweep tries it again. */
export const CATCHUP_RETRY_MS = 30 * 60 * 1000;
export const SUMMARY_INTERVAL_MS = 24 * HOUR_MS;
/** Rows per backfill page. */
export const BACKFILL_BATCH = 500;
const BACKFILL_MAX_PAGES = 100;
/** At most this many shop names are spelled out in the summary line. */
const SUMMARY_NAMES = 10;

const SWEEP_DISABLED = process.env.SHOP_CONNECTION_SWEEP_DISABLED === "true";

export function connectionBackfillEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SHOP_CONNECTION_BACKFILL_DISABLED?.trim() !== "true";
}

export type ProbeOutcome = "ok" | "still_blocked" | "unauthorized" | "forbidden" | "unavailable" | "no_token" | "uninstalled" | "error";

export interface ConnectionSweepStats {
  backfilledNeedsReauth: number;
  backfilledNoToken: number;
  backfilledNotFound: number;
  probeCandidates: number;
  probed: number;
  probeLifted: number;
  probesPaused: boolean;
  catchUpCandidates: number;
  catchUpRun: number;
}

function emptyStats(): ConnectionSweepStats {
  return {
    backfilledNeedsReauth: 0,
    backfilledNoToken: 0,
    backfilledNotFound: 0,
    probeCandidates: 0,
    probed: 0,
    probeLifted: 0,
    probesPaused: false,
    catchUpCandidates: 0,
    catchUpRun: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export class ShopConnectionSweepService {
  private static instance: ShopConnectionSweepService;
  private intervalId: NodeJS.Timeout | null = null;
  private firstTickId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private ticking = false;
  private backfilled = false;
  private lastSummaryAt = 0;
  private readonly catchUpTriedAt = new Map<string, number>();
  /** Probe results since the last summary line. */
  private probeTally: Partial<Record<ProbeOutcome, number>> = {};

  private constructor() {}

  static getInstance(): ShopConnectionSweepService {
    if (!ShopConnectionSweepService.instance) {
      ShopConnectionSweepService.instance = new ShopConnectionSweepService();
    }
    return ShopConnectionSweepService.instance;
  }

  start(): void {
    if (this.isRunning) return;
    if (SWEEP_DISABLED) {
      logger.info("[ConnectionSweep] Disabled via SHOP_CONNECTION_SWEEP_DISABLED - not starting");
      return;
    }
    this.isRunning = true;
    logger.info(
      `[ConnectionSweep] Starting (every ${Math.round(TICK_INTERVAL_MS / 60000)}min, probe every ${Math.round(PROBE_INTERVAL_MS / HOUR_MS)}h, ` +
        `batch ${PROBE_BATCH}, backfill ${connectionBackfillEnabled() ? "on" : "off"})`,
    );
    const run = () =>
      this.tick().catch((err) =>
        logger.error("[ConnectionSweep] Unhandled error in tick", { error: err instanceof Error ? err.message : String(err) }),
      );
    this.firstTickId = setTimeout(run, FIRST_TICK_DELAY_MS);
    this.intervalId = setInterval(run, TICK_INTERVAL_MS);
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
    this.backfilled = false;
    this.lastSummaryAt = 0;
    this.probeTally = {};
    this.catchUpTriedAt.clear();
  }

  /** One sweep. Public so tests can drive it directly (`pauseMs: 0`). */
  async tick(now: Date = new Date(), options: { pauseMs?: number } = {}): Promise<ConnectionSweepStats> {
    const stats = emptyStats();
    if (this.ticking) return stats;
    this.ticking = true;
    try {
      const pauseMs = options.pauseMs ?? PROBE_PAUSE_MS;
      await this.guarded("backfill", () => this.backfill(now, stats));
      await this.guarded("probe", () => this.probeBlockedShops(now, pauseMs, stats));
      await this.guarded("catch-up", () => this.catchUpOwedShops(pauseMs, stats));
      await this.guarded("summary", () => this.summarize(now));
    } finally {
      this.ticking = false;
    }
    return stats;
  }

  /** One failing step must not take the others of the tick with it. */
  private async guarded(step: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      logger.warn(`[ConnectionSweep] ${step} failed: ${error instanceof Error ? error.name : "error"}`);
    }
  }

  // ── 1. backfill ────────────────────────────────────────────────────────────

  private async backfill(now: Date, stats: ConnectionSweepStats): Promise<void> {
    if (this.backfilled || !connectionBackfillEnabled()) return;
    // Marked first: a step that throws is retried on the next process start,
    // not on every tick (all steps are idempotent, none is urgent).
    this.backfilled = true;
    await this.backfillNeedsReauth(now, stats);
    await this.backfillNoToken(now, stats);
    await this.backfillNotFound(now, stats);
    if (stats.backfilledNeedsReauth || stats.backfilledNoToken || stats.backfilledNotFound) {
      logger.info(
        `[ConnectionSweep] BACKFILL needs_reauth=${stats.backfilledNeedsReauth} no_token=${stats.backfilledNoToken} not_found_records=${stats.backfilledNotFound}`,
      );
    }
  }

  /**
   * Shops of `shops` that are uninstalled or already blocked (nothing to
   * backfill for them), and the `connectionClearedAt` of the others: a shop
   * whose block was lifted AFTER the evidence was written has been proven
   * working since (probe, re-authentication) and must not be re-blocked by it.
   */
  private async settledShops(shops: string[]): Promise<{ settled: Set<string>; clearedAt: Map<string, Date> }> {
    if (shops.length === 0) return { settled: new Set(), clearedAt: new Map() };
    const rows = await db.shopInstallState.findMany({
      where: { shop: { in: shops } },
      select: { shop: true, uninstalledAt: true, connectionState: true, connectionClearedAt: true },
    });
    const settled = new Set<string>();
    const clearedAt = new Map<string, Date>();
    for (const r of rows) {
      if (r.uninstalledAt || r.connectionState) settled.add(r.shop);
      if (r.connectionClearedAt) clearedAt.set(r.shop, r.connectionClearedAt);
    }
    return { settled, clearedAt };
  }

  /** Pages through `read` (ordered by shop) until a short page, so no shop is silently left past the first 500. */
  private async eachPage<T extends { shop: string }>(
    read: (after: string | null) => Promise<T[]>,
    handle: (page: T[]) => Promise<void>,
  ): Promise<void> {
    let after: string | null = null;
    for (let i = 0; i < BACKFILL_MAX_PAGES; i++) {
      const page = await read(after);
      if (page.length === 0) return;
      await handle(page);
      if (page.length < BACKFILL_BATCH) return;
      after = page[page.length - 1].shop;
    }
    logger.warn(`[ConnectionSweep] backfill stopped after ${BACKFILL_MAX_PAGES} pages; the rest follows on the next process start`);
  }

  private async backfillNeedsReauth(now: Date, stats: ConnectionSweepStats): Promise<void> {
    await this.eachPage(
      (after) =>
        db.offlineTokenMigration.findMany({
          where: { status: "needs_reauth", ...(after ? { shop: { gt: after } } : {}) },
          select: { shop: true, tokenFingerprint: true, updatedAt: true },
          orderBy: { shop: "asc" },
          take: BACKFILL_BATCH,
        }),
      async (records) => {
        const shops = records.map((r) => r.shop);
        const { settled, clearedAt } = await this.settledShops(shops);
        const sessions = await db.session.findMany({
          where: { isOnline: false, id: { startsWith: "offline_" }, shop: { in: shops } },
          select: { shop: true, accessToken: true, expires: true },
        });
        const sessionOf = new Map(sessions.map((s) => [s.shop, s]));
        for (const record of records) {
          if (settled.has(record.shop)) continue;
          const cleared = clearedAt.get(record.shop);
          if (cleared && record.updatedAt && cleared.getTime() > record.updatedAt.getTime()) continue;
          const session = sessionOf.get(record.shop);
          // No session: nothing is installed to be "dead". An expiring session, or a
          // token that is not the one the verdict was about: the shop re-authenticated.
          if (!session || session.expires) continue;
          if (session.accessToken && storedTokenDiffers(record.tokenFingerprint, session.accessToken)) continue;
          if (await blockShopConnection(record.shop, "backfill_migration_needs_reauth", { observedAt: now })) stats.backfilledNeedsReauth++;
        }
      },
    );
  }

  private async backfillNoToken(now: Date, stats: ConnectionSweepStats): Promise<void> {
    // A migration that can still recover the token (old token persisted, inside
    // the 7-day window) is working on exactly this blank: not dead yet.
    const recovering = new Set(
      await listMigrationShopsByStatus(["pending", "failed"], { withTokenSince: new Date(now.getTime() - MIGRATION_RECOVERY_WINDOW_MS) }),
    );
    await this.eachPage(
      (after) =>
        db.session.findMany({
          where: { isOnline: false, id: { startsWith: "offline_" }, accessToken: "", ...(after ? { shop: { gt: after } } : {}) },
          select: { shop: true },
          orderBy: { shop: "asc" },
          take: BACKFILL_BATCH,
        }),
      async (empty) => {
        const { settled, clearedAt } = await this.settledShops(empty.map((r) => r.shop));
        for (const { shop } of empty) {
          if (settled.has(shop) || recovering.has(shop)) continue;
          // A session has no timestamp of its own to compare with: a shop that
          // was ever cleared (re-authenticated, probed) and is blank again is a
          // NEW event the live detection records; the backfill does not guess.
          if (clearedAt.has(shop)) continue;
          if (await blockShopConnection(shop, "backfill_no_token", { observedAt: now })) stats.backfilledNoToken++;
        }
      },
    );
  }

  private async backfillNotFound(now: Date, stats: ConnectionSweepStats): Promise<void> {
    await this.eachPage(
      (after) =>
        db.offlineTokenMigration.findMany({
          // Not yet terminal only: a record at the cap is given up and keeps its history as it is.
          where: { status: "failed", failureKind: null, attempts: { lt: MIGRATION_MAX_ATTEMPTS }, ...(after ? { shop: { gt: after } } : {}) },
          select: { shop: true, lastError: true, attempts: true, updatedAt: true },
          orderBy: { shop: "asc" },
          take: BACKFILL_BATCH,
        }),
      async (failed) => {
        for (const record of failed) {
          if (!record.lastError || !/\b404\b/.test(record.lastError)) continue;
          // Counted from scratch as runs of this kind (one attempt per run), with
          // the 24 h clock starting now: the backfill never finishes anybody off.
          // `updatedAt` is written back unchanged, so the retry timing of the
          // record is left alone (a plain update would stamp it and set every
          // backfilled row due in the same tick).
          const res = await db.offlineTokenMigration.updateMany({
            where: { shop: record.shop, failureKind: null },
            data: { failureKind: "not_found", failureKindSince: now, attempts: 1, updatedAt: record.updatedAt },
          });
          if (res.count > 0) stats.backfilledNotFound++;
        }
      },
    );
  }

  // ── 2. probe ───────────────────────────────────────────────────────────────

  private async probeBlockedShops(now: Date, pauseMs: number, stats: ConnectionSweepStats): Promise<void> {
    // The cause may be OUR address or OUR credentials: a probe then proves
    // nothing about any shop and would only add to the noise.
    if (isIpAllowlistPaused() || isMigrationConfigHeld()) {
      stats.probesPaused = true;
      return;
    }
    const dueBefore = new Date(now.getTime() - PROBE_INTERVAL_MS);
    const candidates = await db.shopInstallState.findMany({
      where: {
        connectionState: { not: null },
        uninstalledAt: null,
        OR: [{ lastProbeAt: null }, { lastProbeAt: { lt: dueBefore } }],
      },
      select: { shop: true },
      orderBy: { lastProbeAt: { sort: "asc", nulls: "first" } },
      take: PROBE_BATCH * PROBE_OVERFETCH,
    });
    stats.probeCandidates = candidates.length;
    if (candidates.length === 0) return;
    const withToken = new Set(
      (
        await db.session.findMany({
          where: { isOnline: false, id: { startsWith: "offline_" }, shop: { in: candidates.map((c) => c.shop) }, accessToken: { not: "" } },
          select: { shop: true },
        })
      ).map((s) => s.shop),
    );
    let probed = 0;
    for (const { shop } of candidates) {
      if (probed >= PROBE_BATCH) break;
      if (!withToken.has(shop)) {
        await this.stampProbe(shop, now);
        this.tally("no_token");
        continue;
      }
      // A 403 seen by an earlier probe of this very tick may have paused us.
      if (isIpAllowlistPaused()) {
        stats.probesPaused = true;
        break;
      }
      if (probed > 0) await sleep(pauseMs);
      probed++;
      const outcome = await this.probeShop(shop, now);
      this.tally(outcome);
      if (outcome === "ok") stats.probeLifted++;
    }
    stats.probed = probed;
  }

  private tally(outcome: ProbeOutcome): void {
    this.probeTally[outcome] = (this.probeTally[outcome] ?? 0) + 1;
  }

  private async stampProbe(shop: string, at: Date, ok = false): Promise<void> {
    await db.shopInstallState.updateMany({
      where: { shop },
      data: ok ? { lastProbeAt: at, lastApiOkAt: at } : { lastProbeAt: at },
    });
  }

  /**
   * Probe ONE blocked shop. Public for tests. Never throws. Uses the stored
   * access directly (getOfflineAdmin), not createAdminClientFromShop: that one
   * refuses a blocked shop, and the probe exists to find out whether it still
   * should. `startedAt` is when the probe BEGAN (the tick's start in practice):
   * it is the stamp, and a block set after it is not lifted.
   */
  async probeShop(shop: string, startedAt: Date = new Date()): Promise<ProbeOutcome> {
    try {
      const install = await db.shopInstallState.findUnique({ where: { shop }, select: { uninstalledAt: true } });
      if (install?.uninstalledAt) return "uninstalled";
      let response: unknown;
      try {
        const { admin } = await getOfflineAdmin(shop);
        response = await (admin.graphql as (q: string) => Promise<unknown>)("query ConnectionProbe { shop { id } }");
      } catch (error) {
        await this.stampProbe(shop, startedAt);
        if (error instanceof OfflineAdminUnavailableError) return "unavailable";
        if (isUnauthorizedError(error)) return "unauthorized";
        // record:false -- the shop is blocked already, so its own 403s say
        // nothing about our address and must not feed the allowlist suspicion.
        const kind = await classifyForbidden(shop, error, { record: false });
        if (kind) {
          // A 403 is never evidence about this shop: nothing is blocked, lifted
          // or emptied; an allowlist kind logs loud and pauses the next probes,
          // the deadline answer starts the migration handling like anywhere else.
          if (kind === "non_expiring_rejected") reportNonExpiringTokenRejection(shop);
          else reportForbidden(shop, kind);
          return "forbidden";
        }
        return "error";
      }
      if (!(await answeredWithShop(response))) {
        await this.stampProbe(shop, startedAt);
        return "still_blocked";
      }
      noteApiSuccess(shop);
      // Conditional in the database: only a block that already stood when the
      // probe began is lifted (one set after it says something it did not see).
      const lifted = await clearConnectionBlock(shop, "probe_ok", { sinceAtOrBefore: startedAt });
      await this.stampProbe(shop, startedAt, true);
      if (!lifted.cleared) return "still_blocked";
      // The shop works, so a 404 / shop-specific 403 of the token endpoint is
      // stale: let the migration try afresh instead of staying given up.
      await deleteSingleAttemptKindRecord(shop).catch(() => false);
      return "ok";
    } catch (error) {
      logger.debug(`[ConnectionSweep] probe of ${shop} failed: ${error instanceof Error ? error.name : "error"}`);
      await this.stampProbe(shop, startedAt).catch(() => undefined);
      return "error";
    }
  }

  // ── 3. catch-up ────────────────────────────────────────────────────────────

  private async catchUpOwedShops(pauseMs: number, stats: ConnectionSweepStats): Promise<void> {
    // Shops tried recently are left out IN SQL, so the queue moves past failing
    // or paused ones instead of re-reading them at its front every tick.
    const nowMs0 = Date.now();
    const recent = [...this.catchUpTriedAt].filter(([, at]) => nowMs0 - at < CATCHUP_RETRY_MS).map(([s]) => s);
    const owing = await db.shopInstallState.findMany({
      where: {
        resyncRequiredSince: { not: null },
        initialSyncCompletedAt: { not: null },
        connectionState: null,
        uninstalledAt: null,
        ...(recent.length ? { shop: { notIn: recent } } : {}),
      },
      select: { shop: true },
      orderBy: { resyncRequiredSince: "asc" },
      take: CATCHUP_CANDIDATES,
    });
    stats.catchUpCandidates = owing.length;
    if (owing.length === 0) return;
    const { syncScheduler } = await import("./sync-scheduler.service");
    const { createAdminClientFromShop } = await import("../utils/admin-client.server");
    const { runWebhookCatchUp } = await import("./webhook-catchup.server");
    const nowMs = Date.now();
    let started = 0;
    for (const { shop } of owing) {
      if (stats.catchUpRun >= CATCHUP_BATCH || started >= CATCHUP_MAX_STARTS) break;
      // Rotation: a shop tried recently (whatever came of it) waits, so shops
      // that are paused, busy or failing at the front of the queue cannot
      // starve the ones behind them.
      const tried = this.catchUpTriedAt.get(shop);
      if (tried !== undefined && nowMs - tried < CATCHUP_RETRY_MS) continue;
      // An active shop's scheduler does it itself, inside its own sync slot.
      if (syncScheduler.isShopActive(shop)) continue;
      if (started > 0) await sleep(pauseMs);
      started++;
      this.catchUpTriedAt.set(shop, nowMs);
      try {
        const admin = await createAdminClientFromShop(shop);
        const outcome = await runWebhookCatchUp(shop, admin);
        // Only a run that really worked through the shop uses up the per-tick
        // allowance; busy / paused / blocked / not_needed / error cost nothing.
        if (outcome === "done" || outcome === "incomplete") stats.catchUpRun++;
      } catch (error) {
        logger.debug(`[ConnectionSweep] catch-up of ${shop} skipped: ${error instanceof Error ? error.name : "error"}`);
      }
    }
    if (this.catchUpTriedAt.size > 1000) {
      for (const [s, at] of this.catchUpTriedAt) if (nowMs - at > CATCHUP_RETRY_MS) this.catchUpTriedAt.delete(s);
    }
  }

  // ── 4. summary ─────────────────────────────────────────────────────────────

  private async summarize(now: Date): Promise<void> {
    if (this.lastSummaryAt && now.getTime() - this.lastSummaryAt < SUMMARY_INTERVAL_MS) return;
    this.lastSummaryAt = now.getTime();
    const blocked = await db.shopInstallState.findMany({
      where: { connectionState: { not: null } },
      select: { shop: true, connectionState: true, uninstalledAt: true },
      take: 5000,
    });
    const owing = await db.shopInstallState.findMany({
      where: { resyncRequiredSince: { not: null } },
      select: { shop: true, droppedWebhookCount: true },
      take: 5000,
    });
    const by = (state: string) => blocked.filter((b) => b.connectionState === state).length;
    const dropped = owing.reduce((n, o) => n + (o.droppedWebhookCount ?? 0), 0);
    const tally = Object.entries(this.probeTally)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    this.probeTally = {};
    const names = blocked.slice(0, SUMMARY_NAMES).map((b) => b.shop).join(",");
    logger.info(
      `[ConnectionSweep] SUMMARY blocked=${blocked.length} (needs_reauth=${by("needs_reauth")} access_denied=${by("access_denied")} shop_not_found=${by("shop_not_found")}) ` +
        `owingCatchUp=${owing.length} droppedWebhooks=${dropped} probes[${tally || "none"}]` +
        (names ? ` shops=${names}${blocked.length > SUMMARY_NAMES ? ",..." : ""}` : ""),
    );
  }
}

/** Did a probe answer carry the shop's id? A 200 with GraphQL errors (or no data) is not a success. */
async function answeredWithShop(response: unknown): Promise<boolean> {
  try {
    const r = response as { json?: () => Promise<unknown> } | null;
    const body = (typeof r?.json === "function" ? await r.json() : response) as {
      data?: { shop?: { id?: unknown } };
      errors?: unknown;
    } | null;
    return !!body && !body.errors && typeof body.data?.shop?.id === "string" && body.data.shop.id.length > 0;
  } catch {
    return false;
  }
}
