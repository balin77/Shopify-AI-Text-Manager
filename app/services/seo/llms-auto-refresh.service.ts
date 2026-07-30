/**
 * llms.txt Auto-Refresh Sweep
 *
 * The in-session refresh (sync-scheduler.service.ts) only runs while a merchant
 * is working in the app, so a shop nobody opens for weeks keeps serving a stale
 * llms.txt. This service adds the shop-independent daily pass on top of it.
 *
 * Pattern mirrors seo/gsc-auto-sync.service.ts: a singleton with an idempotent
 * start()/stop() (isRunning guard — safe to call from every authenticated
 * request), started from app/shopify.server.ts and stopped in
 * app/entry.server.tsx.
 *
 * Tick semantics:
 *   - runs every TICK_INTERVAL_MS (default hourly) — a cheap "anything due?"
 *     query, not a per-shop timer.
 *   - a shop is "due" once llmsTxtLastAutoRunAt is null or older than
 *     STALE_AFTER_MS (default 24h). That column also keeps a restart cheap: the
 *     initial tick re-reads the stamps and finds nothing due.
 *
 *     It is a guard, NOT a lock. Two replicas whose ticks overlap can select
 *     the same batch before either stamps, and both would refresh those shops.
 *     The consequence is a duplicate theme read plus at most a duplicate write
 *     of identical content, not corruption — refreshLlmsTxtIfStale compares
 *     before writing and verifies the echo. If that ever needs to be airtight,
 *     an `updateMany({ where: { shop, llmsTxtLastAutoRunAt: <observed> } })`
 *     claim-then-work would provide it.
 *   - at most MAX_SHOPS_PER_TICK shops per tick, to spread Admin-API and DB
 *     load rather than sweeping every shop in one burst.
 *   - shops that switched the toggle off, and shops below the "basic" plan the
 *     AEO section requires, are skipped WITHOUT any Shopify call — but still
 *     get stamped. Without the stamp a permanently-ineligible shop would keep
 *     winning the "due" query every tick and crowd out real work in the capped
 *     batch (the same trap documented in GscAutoSyncService).
 *   - errors are logged as a warning and the shop is STILL stamped (backoff),
 *     so an uninstalled shop or a persistent API problem can't burn a batch
 *     slot on every tick forever.
 *
 * The actual work is `refreshLlmsTxtIfStale` — the same function the in-session
 * path calls. It re-reads the theme file, compares against freshly built
 * content and writes only on a real difference, and it never CREATES an
 * llms.txt: generating one stays an explicit merchant decision. Which also
 * means this sweep is a no-op for every shop that never generated the file.
 */

import { db } from "../../db.server";
import { logger } from "../../utils/logger.server";
import { createAdminClientFromShop } from "../../utils/admin-client.server";
import { meetsPlan } from "../../utils/planUtils";
import type { Plan } from "../../config/plans";
import { refreshLlmsTxtIfStale, themeWritesEnabled } from "./aeo.service";

/** Disable the whole sweep without a redeploy. */
const SWEEP_DISABLED = process.env.LLMS_AUTO_REFRESH_DISABLED === "true";

/** How often the sweep checks for due shops. Default 1h. */
const TICK_INTERVAL_MS = parseInt(
  process.env.LLMS_AUTO_REFRESH_INTERVAL_MS || String(60 * 60 * 1000),
  10,
);

/** A shop becomes "due" once its last run is at least this old (or never happened). */
const STALE_AFTER_MS = parseInt(
  process.env.LLMS_AUTO_REFRESH_STALE_MS || String(24 * 60 * 60 * 1000),
  10,
);

/** Cap on shops processed per tick. */
const MAX_SHOPS_PER_TICK = Math.max(
  1,
  parseInt(process.env.LLMS_AUTO_REFRESH_BATCH_SIZE || "10", 10),
);

export interface LlmsAutoRefreshTickStats {
  candidates: number;
  updated: number;
  unchanged: number;
  /** File doesn't exist yet — we never create one. */
  absent: number;
  skippedPlan: number;
  skippedOptOut: number;
  errored: number;
}

export class LlmsAutoRefreshService {
  private static instance: LlmsAutoRefreshService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): LlmsAutoRefreshService {
    if (!LlmsAutoRefreshService.instance) {
      LlmsAutoRefreshService.instance = new LlmsAutoRefreshService();
    }
    return LlmsAutoRefreshService.instance;
  }

  /**
   * Start the sweep. Runs once immediately, then on TICK_INTERVAL_MS.
   * Idempotent — safe to call from every authenticated request.
   */
  start(): void {
    if (this.isRunning) return;
    if (SWEEP_DISABLED) {
      logger.info("[LlmsAutoRefresh] Disabled via LLMS_AUTO_REFRESH_DISABLED - not starting");
      return;
    }

    this.isRunning = true;
    logger.info(
      `[LlmsAutoRefresh] Starting sweep (every ${Math.round(TICK_INTERVAL_MS / 60000)}min, ` +
        `stale after ${Math.round(STALE_AFTER_MS / 3600000)}h, batch ${MAX_SHOPS_PER_TICK})`,
    );

    this.tick().catch((err) =>
      logger.error("[LlmsAutoRefresh] Unhandled error in initial tick", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    this.intervalId = setInterval(() => {
      this.tick().catch((err) =>
        logger.error("[LlmsAutoRefresh] Unhandled error in scheduled tick", {
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
    logger.info("[LlmsAutoRefresh] Stopped");
  }

  /**
   * One sweep: find due shops (capped), process each, return stats.
   * Public so tests can drive it directly with a mocked db, mirroring
   * GscAutoSyncService.tick().
   */
  async tick(now: Date = new Date()): Promise<LlmsAutoRefreshTickStats> {
    const stats: LlmsAutoRefreshTickStats = {
      candidates: 0,
      updated: 0,
      unchanged: 0,
      absent: 0,
      skippedPlan: 0,
      skippedOptOut: 0,
      errored: 0,
    };

    // Nothing here may write a theme file while the Shopify approval is
    // missing, so don't even query for candidates — and crucially don't stamp
    // anyone, or every shop would look "recently handled" once the flag is
    // finally switched on.
    if (!themeWritesEnabled()) return stats;

    const shops = await this.findDueShops(now);
    stats.candidates = shops.length;
    if (shops.length === 0) return stats;

    logger.info(`[LlmsAutoRefresh] Tick: ${shops.length} shop(s) due`);

    for (const row of shops) {
      try {
        if (row.llmsTxtAutoUpdate === false) {
          stats.skippedOptOut++;
          continue;
        }
        if (!meetsPlan((row.subscriptionPlan || "free") as Plan, "basic")) {
          stats.skippedPlan++;
          continue;
        }

        const admin = await createAdminClientFromShop(row.shop);
        const outcome = await refreshLlmsTxtIfStale(admin as never, db, row.shop);
        if (outcome === "updated") stats.updated++;
        else if (outcome === "unchanged") stats.unchanged++;
        else if (outcome === "absent") stats.absent++;
        else if (outcome === "failed") stats.errored++;
      } catch (err) {
        stats.errored++;
        logger.warn(`[LlmsAutoRefresh] Refresh failed for ${row.shop}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Stamped on EVERY path — success, skip and error alike. See the
        // header note: an unstamped shop wins the due query forever.
        await this.stamp(row.shop, now);
      }
    }

    logger.info(
      `[LlmsAutoRefresh] Tick done: ${stats.updated} updated, ${stats.unchanged} unchanged, ` +
        `${stats.absent} without file, ${stats.skippedOptOut} opted out, ` +
        `${stats.skippedPlan} below plan, ${stats.errored} errored`,
    );
    return stats;
  }

  private async findDueShops(now: Date) {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
    return db.aISettings.findMany({
      where: {
        OR: [{ llmsTxtLastAutoRunAt: null }, { llmsTxtLastAutoRunAt: { lt: cutoff } }],
      },
      select: { shop: true, subscriptionPlan: true, llmsTxtAutoUpdate: true },
      // Longest-waiting first — and never-run shops ARE the longest waiting, so
      // nulls must sort first. Postgres defaults `ASC` to NULLS LAST, which
      // parked every new shop behind the stale-but-stamped ones and starved
      // them whenever the due set exceeded MAX_SHOPS_PER_TICK.
      orderBy: { llmsTxtLastAutoRunAt: { sort: "asc", nulls: "first" } },
      take: MAX_SHOPS_PER_TICK,
    });
  }

  private async stamp(shop: string, now: Date): Promise<void> {
    try {
      await db.aISettings.update({
        where: { shop },
        data: { llmsTxtLastAutoRunAt: now },
      });
    } catch (err) {
      // A shop whose settings row vanished mid-tick (uninstall) is fine to
      // ignore — it won't be a candidate next time either.
      logger.warn(`[LlmsAutoRefresh] Could not stamp ${shop}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
