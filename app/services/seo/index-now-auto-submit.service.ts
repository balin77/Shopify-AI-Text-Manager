/**
 * IndexNow auto-submit sweep.
 *
 * The point of IndexNow is that a change reaches the engine in minutes. The
 * webhooks fill `SeoIndexNowQueue` within seconds of a product/collection
 * change — but until this sweep existed nothing ever emptied it: the queue only
 * drained when a merchant happened to open the section and click "send
 * pending". The feature described itself as automatic while being entirely
 * manual, and a shop nobody opens for weeks notified nobody.
 *
 * Pattern mirrors seo/llms-auto-refresh.service.ts and seo/gsc-auto-sync.service.ts:
 * a singleton with an idempotent start()/stop() (isRunning guard — safe to call
 * from every authenticated request), started from app/shopify.server.ts and
 * stopped in app/entry.server.tsx.
 *
 * Tick semantics:
 *   - runs every TICK_INTERVAL_MS (default 15min). Instant indexing wants a
 *     short delay, and a tick that finds nothing costs one indexed groupBy.
 *   - candidates are the shops that actually HAVE queued URLs (groupBy on the
 *     shop-indexed queue), intersected with enabled configs whose
 *     `lastAutoRunAt` is null or older than DUE_AFTER_MS. A shop with an empty
 *     queue is never selected, so it cannot burn a batch slot.
 *   - `lastAutoRunAt` is a backoff guard, NOT a lock. Two replicas whose ticks
 *     overlap can select the same shop and both drain it; IndexNow submissions
 *     are idempotent and `drainQueue` deletes only the rows whose chunk
 *     succeeded, so the worst case is a duplicate notification, not corruption.
 *   - at most MAX_SHOPS_PER_TICK shops per tick, longest-waiting first (nulls
 *     first — a never-run shop IS the longest waiting; Postgres would sort
 *     NULLS LAST by default and starve new shops).
 *   - shops below the "pro" plan the section requires are skipped WITHOUT any
 *     network call, and shops are stamped on EVERY path (success, skip, error)
 *     so a permanently ineligible or broken shop can't win the due query on
 *     every tick forever.
 */

import { db } from "../../db.server";
import { logger } from "../../utils/logger.server";
import { meetsPlan } from "../../utils/planUtils";
import { createAdminClientFromShop } from "../../utils/admin-client.server";
import { resolvePrimaryDomain } from "../../utils/shop-domain.server";
import type { Plan } from "../../config/plans";
import { drainQueue, firstFailureKind, syncIndexNowHost } from "./index-now.service";

/** Disable the whole sweep without a redeploy. */
const SWEEP_DISABLED = process.env.INDEXNOW_AUTO_SUBMIT_DISABLED === "true";

/** How often the sweep looks for shops with pending URLs. Default 15min. */
const TICK_INTERVAL_MS = parseInt(
  process.env.INDEXNOW_AUTO_SUBMIT_INTERVAL_MS || String(15 * 60 * 1000),
  10,
);

/** A shop becomes "due" again this long after its last sweep run. */
const DUE_AFTER_MS = parseInt(
  process.env.INDEXNOW_AUTO_SUBMIT_DUE_MS || String(TICK_INTERVAL_MS),
  10,
);

/** Cap on shops processed per tick. */
const MAX_SHOPS_PER_TICK = Math.max(
  1,
  parseInt(process.env.INDEXNOW_AUTO_SUBMIT_BATCH_SIZE || "25", 10),
);

/** Upper bound on the candidate scan, so one pathological tick can't read every shop. */
const MAX_CANDIDATE_SHOPS = 500;

/** How stale a verified host may get before the sweep re-resolves it. Default 24h. */
const HOST_RECHECK_MS = parseInt(
  process.env.INDEXNOW_HOST_RECHECK_MS || String(24 * 60 * 60 * 1000),
  10,
);

export interface IndexNowAutoSubmitTickStats {
  candidates: number;
  drained: number;
  submitted: number;
  failed: number;
  skippedPlan: number;
  errored: number;
}

export class IndexNowAutoSubmitService {
  private static instance: IndexNowAutoSubmitService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): IndexNowAutoSubmitService {
    if (!IndexNowAutoSubmitService.instance) {
      IndexNowAutoSubmitService.instance = new IndexNowAutoSubmitService();
    }
    return IndexNowAutoSubmitService.instance;
  }

  /**
   * Start the sweep. Runs once immediately, then on TICK_INTERVAL_MS.
   * Idempotent — safe to call from every authenticated request.
   */
  start(): void {
    if (this.isRunning) return;
    if (SWEEP_DISABLED) {
      logger.info("[IndexNowAutoSubmit] Disabled via INDEXNOW_AUTO_SUBMIT_DISABLED - not starting");
      return;
    }

    this.isRunning = true;
    logger.info(
      `[IndexNowAutoSubmit] Starting sweep (every ${Math.round(TICK_INTERVAL_MS / 60000)}min, ` +
        `batch ${MAX_SHOPS_PER_TICK})`,
    );

    this.tick().catch((err) =>
      logger.error("[IndexNowAutoSubmit] Unhandled error in initial tick", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    this.intervalId = setInterval(() => {
      this.tick().catch((err) =>
        logger.error("[IndexNowAutoSubmit] Unhandled error in scheduled tick", {
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
    logger.info("[IndexNowAutoSubmit] Stopped");
  }

  /**
   * One sweep: find due shops with pending URLs (capped), drain each, return
   * stats. Public so tests can drive it directly with a mocked db, mirroring
   * GscAutoSyncService.tick() / LlmsAutoRefreshService.tick().
   */
  async tick(now: Date = new Date()): Promise<IndexNowAutoSubmitTickStats> {
    const stats: IndexNowAutoSubmitTickStats = {
      candidates: 0,
      drained: 0,
      submitted: 0,
      failed: 0,
      skippedPlan: 0,
      errored: 0,
    };

    const shops = await this.findDueShops(now);
    stats.candidates = shops.length;
    if (shops.length === 0) return stats;

    const plans = await this.loadPlans(shops);
    logger.info(`[IndexNowAutoSubmit] Tick: ${shops.length} shop(s) with pending URLs`);

    for (const { shop, hostCheckedAt } of shops) {
      try {
        if (!meetsPlan(plans.get(shop) ?? "free", "pro")) {
          stats.skippedPlan++;
          continue;
        }
        await this.refreshHostIfStale(shop, hostCheckedAt, now);
        const outcome = await drainQueue(db, shop, now);
        if (outcome.status === "submitted") {
          stats.drained++;
          stats.submitted += outcome.result.submitted;
          stats.failed += outcome.result.failed;
          if (outcome.result.failed > 0) {
            logger.warn(
              `[IndexNowAutoSubmit] ${shop}: ${outcome.result.failed} URL(s) rejected ` +
                `(${firstFailureKind(outcome.result)}) - kept for retry`,
            );
          }
        }
      } catch (err) {
        stats.errored++;
        logger.warn(`[IndexNowAutoSubmit] Drain failed for ${shop}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Stamped on EVERY path — success, skip and error alike. See the header
        // note: an unstamped shop wins the due query forever.
        await this.stamp(shop, now);
      }
    }

    logger.info(
      `[IndexNowAutoSubmit] Tick done: ${stats.drained} shop(s) drained, ` +
        `${stats.submitted} URL(s) submitted, ${stats.failed} kept, ` +
        `${stats.skippedPlan} below plan, ${stats.errored} errored`,
    );
    return stats;
  }

  /**
   * Re-resolve the primary domain when it has not been verified for a day (or
   * never — every row the migration backfilled).
   *
   * Without this, only the section's loader ever corrected the host, so a shop
   * that connected a custom domain and never reopened the page would keep
   * auto-submitting `*.myshopify.com` URLs unattended: precisely the failure
   * this whole change exists to remove. Costs at most one Admin call per shop
   * per day, and only for shops that actually have URLs to send.
   *
   * A failed lookup is a no-op — `resolvePrimaryDomain` returns null rather
   * than the myshopify fallback, so a hiccup can never overwrite a good host.
   */
  private async refreshHostIfStale(
    shop: string,
    hostCheckedAt: Date | null,
    now: Date,
  ): Promise<void> {
    if (hostCheckedAt && now.getTime() - hostCheckedAt.getTime() < HOST_RECHECK_MS) return;
    try {
      const admin = await createAdminClientFromShop(shop);
      const primaryDomain = await resolvePrimaryDomain(admin as never);
      if (primaryDomain) await syncIndexNowHost(db, shop, primaryDomain, now);
    } catch (err) {
      // Uninstalled shop / expired session: leave the host as is and let the
      // drain proceed. Nothing here may abort the sweep for other shops.
      logger.warn(`[IndexNowAutoSubmit] Could not refresh host for ${shop}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Shops that have queued URLs AND an enabled config that is due again. */
  private async findDueShops(now: Date): Promise<Array<{ shop: string; hostCheckedAt: Date | null }>> {
    const pending = await db.seoIndexNowQueue.groupBy({
      by: ["shop"],
      _count: { _all: true },
      orderBy: { shop: "asc" },
      take: MAX_CANDIDATE_SHOPS,
    });
    if (pending.length === 0) return [];

    const cutoff = new Date(now.getTime() - DUE_AFTER_MS);
    const configs = await db.seoIndexNowConfig.findMany({
      where: {
        shop: { in: pending.map((p) => p.shop) },
        enabled: true,
        OR: [{ lastAutoRunAt: null }, { lastAutoRunAt: { lt: cutoff } }],
      },
      select: { shop: true, hostCheckedAt: true },
      orderBy: { lastAutoRunAt: { sort: "asc", nulls: "first" } },
      take: MAX_SHOPS_PER_TICK,
    });
    return configs;
  }

  private async loadPlans(shops: Array<{ shop: string }>): Promise<Map<string, Plan>> {
    const rows = await db.aISettings.findMany({
      where: { shop: { in: shops.map((s) => s.shop) } },
      select: { shop: true, subscriptionPlan: true },
    });
    return new Map(rows.map((r) => [r.shop, (r.subscriptionPlan || "free") as Plan]));
  }

  private async stamp(shop: string, now: Date): Promise<void> {
    try {
      await db.seoIndexNowConfig.updateMany({ where: { shop }, data: { lastAutoRunAt: now } });
    } catch (err) {
      // A shop whose config vanished mid-tick (uninstall/GDPR purge) is fine to
      // ignore — it won't be a candidate next time either.
      logger.warn(`[IndexNowAutoSubmit] Could not stamp ${shop}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
