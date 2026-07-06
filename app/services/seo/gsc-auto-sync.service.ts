/**
 * GSC Auto-Sync Service
 *
 * GSC keyword enrichment (position/clicks/impressions/ctr on SeoKeyword rows)
 * previously ran ONLY when the merchant clicked "Sync keyword rankings" on
 * app.seo.search-console.tsx (see enrichKeywordsFromGsc in
 * google-search-console.server.ts). This service adds a daily automatic
 * sweep on top of that, so rankings stay fresh without a manual click.
 *
 * Pattern mirrors src/services/shop-reaper.service.ts: a singleton with an
 * idempotent start()/stop() (isRunning guard — safe to call from every
 * authenticated request), started from app/shopify.server.ts (needs
 * TypeScript imports the plain-node server.js standalone jobs can't use) and
 * stopped in app/entry.server.tsx.
 *
 * Tick semantics:
 *   - runs every TICK_INTERVAL_MS (default hourly) — cheap "anything due?"
 *     check, not a per-shop timer (mirrors ShopReaperService, not the
 *     per-shop SyncScheduler).
 *   - a connection is "due" once propertyUrl is set AND lastKeywordSyncAt is
 *     null (never synced) or older than STALE_AFTER_MS (default 24h).
 *   - at most MAX_SHOPS_PER_TICK connections are processed per tick, to
 *     spread GSC-quota + DB load instead of syncing every connected shop in
 *     one burst (same reasoning as SyncSchedulerService.SYNC_MAX_CONCURRENCY).
 *   - shops below the "pro" plan, and shops with zero tracked SeoKeyword
 *     rows, are skipped WITHOUT calling GSC — but still get
 *     lastKeywordSyncAt stamped. Without that stamp a permanently-ineligible
 *     shop (free plan, or no keywords tracked yet) would keep winning the
 *     "due" query every tick and crowd out real work in the capped batch.
 *   - GscReconnectRequiredError: getGscAccessToken already deleted the
 *     connection row (see deleteGscConnection in
 *     google-search-console.server.ts) — nothing left to stamp, and the
 *     merchant sees "reconnect needed" next time they open the section.
 *   - any other error: logged as a warning, but lastKeywordSyncAt is STILL
 *     stamped (backoff). Without this, a shop with a persistent problem
 *     (network blip, Google outage, quota) would be retried — and burn a
 *     batch slot — on every single tick forever.
 */

import { db } from "../../db.server";
import { logger } from "../../utils/logger.server";
import { enrichKeywordsFromGsc, GscReconnectRequiredError } from "../google-search-console.server";
import { meetsPlan } from "../../utils/planUtils";
import type { Plan } from "../../config/plans";

/** Disable the whole sweep without a redeploy (e.g. during a GSC-quota incident). */
const AUTO_SYNC_DISABLED = process.env.GSC_AUTO_SYNC_DISABLED === "true";

/** How often the sweep checks for due connections. Default 1h. */
const TICK_INTERVAL_MS = parseInt(process.env.GSC_AUTO_SYNC_INTERVAL_MS || String(60 * 60 * 1000), 10);

/** A connection becomes "due" once its last sync is at least this old (or never happened). */
const STALE_AFTER_MS = parseInt(process.env.GSC_AUTO_SYNC_STALE_MS || String(24 * 60 * 60 * 1000), 10);

/** Cap on shops processed per tick. */
const MAX_SHOPS_PER_TICK = Math.max(1, parseInt(process.env.GSC_AUTO_SYNC_BATCH_SIZE || "5", 10));

export interface GscAutoSyncTickStats {
  candidates: number;
  synced: number;
  skippedPlan: number;
  skippedNoKeywords: number;
  reconnectRequired: number;
  errored: number;
}

export class GscAutoSyncService {
  private static instance: GscAutoSyncService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): GscAutoSyncService {
    if (!GscAutoSyncService.instance) {
      GscAutoSyncService.instance = new GscAutoSyncService();
    }
    return GscAutoSyncService.instance;
  }

  /**
   * Start the sweep. Runs once immediately, then on TICK_INTERVAL_MS.
   * Idempotent — safe to call from every authenticated request.
   */
  start(): void {
    if (this.isRunning) return;
    if (AUTO_SYNC_DISABLED) {
      logger.info("[GscAutoSync] Disabled via GSC_AUTO_SYNC_DISABLED - not starting");
      return;
    }

    this.isRunning = true;
    logger.info(
      `[GscAutoSync] Starting auto-sync sweep (every ${Math.round(TICK_INTERVAL_MS / 60000)}min, ` +
        `stale after ${Math.round(STALE_AFTER_MS / 3600000)}h, batch ${MAX_SHOPS_PER_TICK})`,
    );

    this.tick().catch((err) =>
      logger.error("[GscAutoSync] Unhandled error in initial tick", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    this.intervalId = setInterval(() => {
      this.tick().catch((err) =>
        logger.error("[GscAutoSync] Unhandled error in scheduled tick", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, TICK_INTERVAL_MS);
  }

  /** Stop the sweep. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info("[GscAutoSync] Stopped");
  }

  /**
   * One sweep: find due connections (capped), process each, return stats.
   * Public (not private) so tests can drive it directly with a mocked db,
   * the same way ShopReaperService exposes triggerReap().
   */
  async tick(now: Date = new Date()): Promise<GscAutoSyncTickStats> {
    const stats: GscAutoSyncTickStats = {
      candidates: 0,
      synced: 0,
      skippedPlan: 0,
      skippedNoKeywords: 0,
      reconnectRequired: 0,
      errored: 0,
    };

    const connections = await this.findDueConnections(now);
    stats.candidates = connections.length;
    if (connections.length === 0) return stats;

    logger.info(`[GscAutoSync] Tick: ${connections.length} connection(s) due`);

    for (const conn of connections) {
      await this.processShop(conn.shop, now, stats);
    }

    logger.info(
      `[GscAutoSync] Tick complete: ${stats.synced} synced, ${stats.skippedPlan} plan-gated, ` +
        `${stats.skippedNoKeywords} no-keywords, ${stats.reconnectRequired} reconnect-required, ${stats.errored} errored`,
    );

    return stats;
  }

  /**
   * Due connections = propertyUrl set AND (never synced OR stale), capped at
   * MAX_SHOPS_PER_TICK. Fetched in two passes — never-synced first, then
   * oldest-stale — instead of a single `orderBy: lastKeywordSyncAt asc` so
   * the result doesn't depend on the DB's NULL-ordering default (Postgres
   * sorts NULLS LAST on ASC, which would bury never-synced shops behind
   * stale ones instead of prioritizing them).
   */
  private async findDueConnections(now: Date): Promise<Array<{ shop: string }>> {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);

    const neverSynced = await db.googleSearchConsoleConnection.findMany({
      where: { propertyUrl: { not: "" }, lastKeywordSyncAt: null },
      select: { shop: true },
      take: MAX_SHOPS_PER_TICK,
    });

    if (neverSynced.length >= MAX_SHOPS_PER_TICK) return neverSynced;

    const stale = await db.googleSearchConsoleConnection.findMany({
      where: { propertyUrl: { not: "" }, lastKeywordSyncAt: { lt: cutoff } },
      select: { shop: true },
      orderBy: { lastKeywordSyncAt: "asc" },
      take: MAX_SHOPS_PER_TICK - neverSynced.length,
    });

    return [...neverSynced, ...stale];
  }

  /**
   * Process one shop: plan/keyword-count gates, then enrich + stamp. Errors
   * are caught here (per-shop) so one bad shop can't abort the whole tick.
   */
  private async processShop(shop: string, now: Date, stats: GscAutoSyncTickStats): Promise<void> {
    try {
      const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
      const plan = (settings?.subscriptionPlan || "free") as Plan;
      if (!meetsPlan(plan, "pro")) {
        stats.skippedPlan++;
        await this.stamp(shop, now);
        return;
      }

      // Cheap count before burning GSC quota — a shop with no tracked
      // keywords has nothing for enrichKeywordsFromGsc to write.
      const keywordCount = await db.seoKeyword.count({ where: { shop } });
      if (keywordCount === 0) {
        stats.skippedNoKeywords++;
        await this.stamp(shop, now);
        return;
      }

      const count = await enrichKeywordsFromGsc(db, shop, now);
      stats.synced++;
      await this.stamp(shop, now);
      logger.info(`[GscAutoSync] Synced ${shop}: ${count} keyword(s) enriched`);
    } catch (error) {
      if (error instanceof GscReconnectRequiredError) {
        stats.reconnectRequired++;
        logger.info(`[GscAutoSync] ${shop} needs reconnect (${error.reason}) - connection already cleared`);
        return;
      }
      stats.errored++;
      logger.warn(`[GscAutoSync] Sync failed for ${shop}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // Backoff: stamp anyway so a persistently-broken shop isn't retried
      // (and doesn't burn a batch slot) on every hourly tick.
      await this.stamp(shop, now);
    }
  }

  /**
   * updateMany (not update-by-unique-key): the GscReconnectRequiredError path
   * in getGscAccessToken may already have deleted the connection row, and
   * updateMany no-ops on zero matched rows instead of throwing P2025.
   */
  private async stamp(shop: string, now: Date): Promise<void> {
    await db.googleSearchConsoleConnection.updateMany({
      where: { shop },
      data: { lastKeywordSyncAt: now },
    });
  }
}
