/**
 * Weekly storefront-crawl sweep — the second unattended Max feature
 * (§Plan-Matrix), sibling of audit-auto-run.service.ts.
 *
 * The crawl is otherwise entirely pull-based: broken links, redirect chains and
 * orphan pages only surface when someone remembers to press "Jetzt scannen".
 * But those are exactly the problems that appear WITHOUT anyone touching the
 * shop — a deleted product 404s the links pointing at it, an app uninstall
 * strips a page, a theme update changes head tags. On Max the crawl therefore
 * runs by itself once a week, so the crawl-to-crawl diff has something to
 * compare and a delivery regression is visible without a visit.
 *
 * Report-only, like the audit: it writes a snapshot and nothing else. No
 * "autopilot" that rewrites merchant content (§2.2.1 of the competitive
 * analysis).
 *
 * Why WEEKLY rather than nightly, unlike the audit: the audit reads the DB
 * cache, this fetches every page of the storefront. Nightly would multiply the
 * request load on the merchant's own shop for findings that do not change that
 * fast — and the crawl's own cap (2000 pages) makes a run genuinely expensive.
 *
 * Tick semantics mirror the audit sweep exactly:
 *   - runs every TICK_INTERVAL_MS (default 1h) and picks shops whose last
 *     automatic crawl is missing or older than DUE_AFTER_MS (default 7d).
 *     Hourly ticks mean a restart cannot make a shop miss its week.
 *   - candidates come from AISettings.subscriptionPlan (never from a caller)
 *     ANDed with the merchant switch `seoAutoCrawlEnabled` — entitlement and
 *     consent must both hold, and an ineligible shop is filtered IN THE QUERY.
 *   - `lastAutoCrawlAt` is a backoff stamp, NOT a lock, written on EVERY path
 *     (started, skipped, error). An unstamped shop wins the due query forever.
 *   - at most MAX_SHOPS_PER_TICK shops per tick, longest-waiting first (nulls
 *     first — Postgres sorts NULLS LAST and would starve never-crawled shops).
 *   - single-flight lives in `startCrawlRun`, so a shop with a crawl already
 *     running is stamped and skipped rather than crawled twice.
 *
 * The sweep only STARTS the crawl; the detached runner finishes it. A tick
 * therefore returns quickly even though a crawl takes minutes.
 */

import { db } from "../../db.server";
import { createAdminClientFromShop } from "../../utils/admin-client.server";
import { logger } from "../../utils/logger.server";
import { canUseScheduledSeoCrawl } from "../../utils/planUtils";
import type { Plan } from "../../config/plans";
import { PLAN_CONFIG } from "../../config/plans";
import { startCrawlRun } from "./crawl-run.server";

/** Disable the whole sweep without a redeploy. */
const SWEEP_DISABLED = process.env.SEO_CRAWL_AUTO_RUN_DISABLED === "true";

/** How often the sweep looks for due shops. Default 1h. */
const TICK_INTERVAL_MS = parseInt(
  process.env.SEO_CRAWL_AUTO_RUN_INTERVAL_MS || String(60 * 60 * 1000),
  10,
);

/** A shop becomes due again this long after its last automatic crawl. Default 7d. */
const DUE_AFTER_MS = parseInt(
  process.env.SEO_CRAWL_AUTO_RUN_DUE_MS || String(7 * 24 * 60 * 60 * 1000),
  10,
);

/**
 * Cap on crawls STARTED per tick. Lower than the audit sweep's: each one keeps
 * fetching for minutes after the tick returns, so this is a concurrency limit
 * on live crawls, not a batch size.
 */
const MAX_SHOPS_PER_TICK = Math.max(
  1,
  parseInt(process.env.SEO_CRAWL_AUTO_RUN_BATCH_SIZE || "3", 10),
);

/** Plans whose entitlement includes the weekly crawl — derived, never hardcoded. */
const SCHEDULED_CRAWL_PLANS: Plan[] = (Object.keys(PLAN_CONFIG) as Plan[]).filter(
  canUseScheduledSeoCrawl,
);

export interface SeoCrawlAutoRunTickStats {
  candidates: number;
  started: number;
  skipped: number;
  errored: number;
}

export class SeoCrawlAutoRunService {
  private static instance: SeoCrawlAutoRunService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): SeoCrawlAutoRunService {
    if (!SeoCrawlAutoRunService.instance) {
      SeoCrawlAutoRunService.instance = new SeoCrawlAutoRunService();
    }
    return SeoCrawlAutoRunService.instance;
  }

  /**
   * Start the sweep. Runs once immediately, then on TICK_INTERVAL_MS.
   * Idempotent — safe to call from every authenticated request.
   */
  start(): void {
    if (this.isRunning) return;
    if (SWEEP_DISABLED) {
      logger.info("[SeoCrawlAutoRun] Disabled via SEO_CRAWL_AUTO_RUN_DISABLED - not starting");
      return;
    }
    if (SCHEDULED_CRAWL_PLANS.length === 0) {
      logger.info("[SeoCrawlAutoRun] No plan grants scheduledCrawl - not starting");
      return;
    }

    this.isRunning = true;
    logger.info(
      `[SeoCrawlAutoRun] Starting sweep (every ${Math.round(TICK_INTERVAL_MS / 60000)}min, ` +
        `due after ${Math.round(DUE_AFTER_MS / 3600000)}h, batch ${MAX_SHOPS_PER_TICK})`,
    );

    this.tick().catch((err) =>
      logger.error("[SeoCrawlAutoRun] Unhandled error in initial tick", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    this.intervalId = setInterval(() => {
      this.tick().catch((err) =>
        logger.error("[SeoCrawlAutoRun] Unhandled error in scheduled tick", {
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
    logger.info("[SeoCrawlAutoRun] Stopped");
  }

  /**
   * One sweep: start a crawl for the due shops (capped) and return stats.
   * Public so tests can drive it directly, mirroring the sibling sweeps.
   */
  async tick(now: Date = new Date()): Promise<SeoCrawlAutoRunTickStats> {
    const stats: SeoCrawlAutoRunTickStats = { candidates: 0, started: 0, skipped: 0, errored: 0 };

    const shops = await this.findDueShops(now);
    stats.candidates = shops.length;
    if (shops.length === 0) return stats;

    logger.info(`[SeoCrawlAutoRun] Tick: ${shops.length} shop(s) due`);

    for (const settings of shops) {
      try {
        const admin = await createAdminClientFromShop(settings.shop);
        const result = await startCrawlRun({ db, admin: admin as never, shop: settings.shop });
        if (result.started) {
          stats.started++;
          logger.info(`[SeoCrawlAutoRun] ${settings.shop}: crawl started (task ${result.taskId})`);
        } else {
          // A crawl the merchant started minutes ago. Stamped anyway (below),
          // so this shop waits a full window instead of being retried hourly.
          stats.skipped++;
        }
      } catch (err) {
        stats.errored++;
        logger.warn(`[SeoCrawlAutoRun] Crawl start failed for ${settings.shop}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Stamped on EVERY path — see the header note.
        await this.stamp(settings.shop, now);
      }
    }

    logger.info(
      `[SeoCrawlAutoRun] Tick done: ${stats.started} started, ${stats.skipped} skipped, ` +
        `${stats.errored} errored`,
    );
    return stats;
  }

  /**
   * Shops entitled to the weekly crawl whose last automatic run is missing or
   * older than the due window, longest-waiting first.
   */
  private async findDueShops(now: Date) {
    const dueBefore = new Date(now.getTime() - DUE_AFTER_MS);
    return db.aISettings.findMany({
      where: {
        subscriptionPlan: { in: SCHEDULED_CRAWL_PLANS },
        // Merchant opt-out (Settings → SEO). Entitlement AND consent.
        seoAutoCrawlEnabled: true,
        OR: [{ lastAutoCrawlAt: null }, { lastAutoCrawlAt: { lt: dueBefore } }],
      },
      select: { shop: true, lastAutoCrawlAt: true },
      // Nulls first: a shop that has never been crawled is the longest waiting.
      orderBy: { lastAutoCrawlAt: { sort: "asc", nulls: "first" } },
      take: MAX_SHOPS_PER_TICK,
    });
  }

  /** Backoff stamp — never a lock. A failed write must not abort the sweep. */
  private async stamp(shop: string, now: Date): Promise<void> {
    await db.aISettings
      .update({ where: { shop }, data: { lastAutoCrawlAt: now } })
      .catch(() => {});
  }
}
