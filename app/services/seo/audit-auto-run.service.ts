/**
 * Nightly SEO audit sweep — the Max-plan differentiator (§Plan-Matrix).
 *
 * The store audit is otherwise entirely pull-based: a snapshot only exists for
 * as long as someone remembers to click "rescan". That makes the score history
 * (SeoScoreSnapshot) a record of when the merchant visited, not of how the shop
 * developed — and a shop nobody opens for a month has no trend at all. On Max
 * the scan runs by itself once a day, so the trend chart is a real time series
 * and a score drop after a bulk import is visible without anyone looking.
 *
 * Report-only, deliberately: it writes a snapshot and nothing else. It never
 * rewrites merchant content — the "autopilot" failure mode the competitive
 * analysis warns about (§2.2.1) stays out of the product.
 *
 * Pattern mirrors seo/index-now-auto-submit.service.ts and
 * seo/gsc-auto-sync.service.ts: a singleton with an idempotent start()/stop()
 * (isRunning guard, safe to call from every authenticated request), started
 * from app/shopify.server.ts and stopped in app/entry.server.tsx.
 *
 * Tick semantics:
 *   - runs every TICK_INTERVAL_MS (default 1h) and processes the shops whose
 *     last automatic run is older than DUE_AFTER_MS (default 24h), so each
 *     eligible shop gets roughly one scan per day without needing a real
 *     scheduler. Ticking hourly (rather than daily) means a restart cannot
 *     make a shop miss its day.
 *   - candidates are shops on a plan with `seo.scheduledAudit` — resolved from
 *     AISettings.subscriptionPlan, never trusted from the caller. Free/Basic/
 *     Pro shops are filtered out IN THE QUERY, so an ineligible shop costs
 *     nothing per tick.
 *   - `lastAutoAuditAt` is a backoff stamp, NOT a lock, and is written on
 *     EVERY path (success, skip, error) — same rule the sibling sweeps
 *     document: an unstamped shop wins the due query forever. Two replicas
 *     whose ticks overlap can both scan one shop; the worst case is a
 *     duplicate snapshot, which saveAuditSnapshot's retention prunes anyway.
 *   - at most MAX_SHOPS_PER_TICK shops per tick, longest-waiting first (nulls
 *     first — a never-scanned shop IS the longest waiting; Postgres sorts
 *     NULLS LAST by default and would starve new shops).
 *   - only the PRIMARY locale is scanned. The manual run fans out over every
 *     published locale, which is fine when a merchant is waiting for it; doing
 *     that unattended for every Max shop every night would multiply the scan
 *     cost by the locale count for a chart nobody asked to refresh.
 */

import { db } from "../../db.server";
import { logger } from "../../utils/logger.server";
import { canUseScheduledSeoAudit } from "../../utils/planUtils";
import { seoTitleEffectiveLimit } from "../../utils/seo-score";
import type { Plan } from "../../config/plans";
import { PLAN_CONFIG } from "../../config/plans";
import { analyzeStore, saveAuditSnapshot } from "./audit.service";

/** Disable the whole sweep without a redeploy. */
const SWEEP_DISABLED = process.env.SEO_AUDIT_AUTO_RUN_DISABLED === "true";

/** How often the sweep looks for due shops. Default 1h. */
const TICK_INTERVAL_MS = parseInt(
  process.env.SEO_AUDIT_AUTO_RUN_INTERVAL_MS || String(60 * 60 * 1000),
  10,
);

/** A shop becomes due again this long after its last automatic scan. Default 24h. */
const DUE_AFTER_MS = parseInt(
  process.env.SEO_AUDIT_AUTO_RUN_DUE_MS || String(24 * 60 * 60 * 1000),
  10,
);

/** Cap on shops scanned per tick — a full store scan is the expensive part. */
const MAX_SHOPS_PER_TICK = Math.max(
  1,
  parseInt(process.env.SEO_AUDIT_AUTO_RUN_BATCH_SIZE || "10", 10),
);

/** Plans whose entitlement includes the nightly scan — derived, never hardcoded. */
const SCHEDULED_AUDIT_PLANS: Plan[] = (Object.keys(PLAN_CONFIG) as Plan[]).filter(
  canUseScheduledSeoAudit,
);

export interface SeoAuditAutoRunTickStats {
  candidates: number;
  scanned: number;
  errored: number;
}

export class SeoAuditAutoRunService {
  private static instance: SeoAuditAutoRunService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): SeoAuditAutoRunService {
    if (!SeoAuditAutoRunService.instance) {
      SeoAuditAutoRunService.instance = new SeoAuditAutoRunService();
    }
    return SeoAuditAutoRunService.instance;
  }

  /**
   * Start the sweep. Runs once immediately, then on TICK_INTERVAL_MS.
   * Idempotent — safe to call from every authenticated request.
   */
  start(): void {
    if (this.isRunning) return;
    if (SWEEP_DISABLED) {
      logger.info("[SeoAuditAutoRun] Disabled via SEO_AUDIT_AUTO_RUN_DISABLED - not starting");
      return;
    }
    if (SCHEDULED_AUDIT_PLANS.length === 0) {
      logger.info("[SeoAuditAutoRun] No plan grants scheduledAudit - not starting");
      return;
    }

    this.isRunning = true;
    logger.info(
      `[SeoAuditAutoRun] Starting sweep (every ${Math.round(TICK_INTERVAL_MS / 60000)}min, ` +
        `due after ${Math.round(DUE_AFTER_MS / 3600000)}h, batch ${MAX_SHOPS_PER_TICK})`,
    );

    this.tick().catch((err) =>
      logger.error("[SeoAuditAutoRun] Unhandled error in initial tick", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    this.intervalId = setInterval(() => {
      this.tick().catch((err) =>
        logger.error("[SeoAuditAutoRun] Unhandled error in scheduled tick", {
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
    logger.info("[SeoAuditAutoRun] Stopped");
  }

  /**
   * One sweep: scan the due shops (capped) and return stats. Public so tests
   * can drive it directly, mirroring the sibling sweeps.
   */
  async tick(now: Date = new Date()): Promise<SeoAuditAutoRunTickStats> {
    const stats: SeoAuditAutoRunTickStats = { candidates: 0, scanned: 0, errored: 0 };

    const shops = await this.findDueShops(now);
    stats.candidates = shops.length;
    if (shops.length === 0) return stats;

    logger.info(`[SeoAuditAutoRun] Tick: ${shops.length} shop(s) due`);

    for (const settings of shops) {
      try {
        await this.scanShop(settings);
        stats.scanned++;
      } catch (err) {
        stats.errored++;
        logger.warn(`[SeoAuditAutoRun] Scan failed for ${settings.shop}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Stamped on EVERY path — see the header note.
        await this.stamp(settings.shop, now);
      }
    }

    logger.info(
      `[SeoAuditAutoRun] Tick done: ${stats.scanned} scanned, ${stats.errored} errored`,
    );
    return stats;
  }

  /**
   * Shops entitled to the nightly scan whose last automatic run is missing or
   * older than the due window, longest-waiting first.
   */
  private async findDueShops(now: Date) {
    const dueBefore = new Date(now.getTime() - DUE_AFTER_MS);
    return db.aISettings.findMany({
      where: {
        subscriptionPlan: { in: SCHEDULED_AUDIT_PLANS },
        OR: [{ lastAutoAuditAt: null }, { lastAutoAuditAt: { lt: dueBefore } }],
      },
      select: {
        shop: true,
        subscriptionPlan: true,
        seoTitleSuffixEnabled: true,
        seoTitleSuffix: true,
        seoLimits: true,
        lastAutoAuditAt: true,
      },
      // Nulls first: a shop that has never been scanned is the longest waiting.
      orderBy: { lastAutoAuditAt: { sort: "asc", nulls: "first" } },
      take: MAX_SHOPS_PER_TICK,
    });
  }

  /**
   * Run the primary-locale audit for one shop and persist the snapshot —
   * exactly what the manual "rescan" writes, so the dashboard and the trend
   * chart cannot tell the two apart.
   */
  private async scanShop(settings: {
    shop: string;
    subscriptionPlan: string | null;
    seoTitleSuffixEnabled: boolean | null;
    seoTitleSuffix: string | null;
    seoLimits: unknown;
  }): Promise<void> {
    // No Admin client needed: analyzeStore reads the DB content cache only.
    // The manual runner fetches the shop name for display; an unattended scan
    // has no display to fill, and analyzeStore defaults it to "".
    const suffix =
      settings.seoTitleSuffixEnabled && settings.seoTitleSuffix ? settings.seoTitleSuffix : "";
    const seoLimits = (settings.seoLimits ?? null) as Record<string, number> | null;

    const audit = await analyzeStore(settings.shop, {
      db,
      seoTitleEffectiveLimit: seoTitleEffectiveLimit(suffix, seoLimits),
      seoLimits,
      plan: (settings.subscriptionPlan || "free") as Plan,
    });
    await saveAuditSnapshot(db, settings.shop, audit, "");
    logger.info(
      `[SeoAuditAutoRun] ${settings.shop}: score ${audit.averageScore} ` +
        `over ${audit.totalScanned} item(s)`,
    );
  }

  /** Backoff stamp — never a lock. A failed write must not abort the sweep. */
  private async stamp(shop: string, now: Date): Promise<void> {
    await db.aISettings
      .update({ where: { shop }, data: { lastAutoAuditAt: now } })
      .catch(() => {});
  }
}
