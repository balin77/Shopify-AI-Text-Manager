/**
 * Shop Reaper Service
 *
 * Final fallback for GDPR shop-data deletion (regression R3).
 *
 * Full data deletion normally happens via Shopify's shop/redact webhook
 * (~48 h after uninstall). If that webhook permanently fails, this job is the
 * guaranteed backstop: it purges every shop that has been uninstalled for more
 * than the retention window (default 30 days) by calling the single source of
 * truth, `redactShopData` (app/services/gdpr.service.ts). Because that function
 * is deleteMany-based inside a transaction — and itself removes the
 * ShopInstallState marker — the reaper is fully idempotent.
 *
 * Scheduling note: unlike the sibling standalone cleanup services
 * (gdpr-audit-cleanup, task-cleanup) this one is NOT started from server.js.
 * It reuses the TypeScript `redactShopData`, which the plain-`node` server.js
 * entrypoint cannot import. It is therefore bootstrapped from the authenticated
 * request path (app/shopify.server.ts) and stopped in app/entry.server.tsx,
 * the same lifecycle the in-app SyncScheduler uses.
 *
 * Safety guards — a shop is purged ONLY when ALL hold:
 *   1. ShopInstallState.uninstalledAt is set and older than the retention window
 *   2. it has zero Session rows (no active install — cleared on reinstall)
 *   3. it has no paid plan (AISettings.subscriptionPlan is "free" or absent)
 */

import { db } from "../../app/db.server";
import { loggers } from "../../app/utils/logger.server";
import { redactShopData } from "../../app/services/gdpr.service";

/** Retention window before an uninstalled shop is purged. Default 30 days. */
const RETENTION_DAYS = parseInt(process.env.REAPER_RETENTION_DAYS || "30", 10);
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** How often the reaper sweeps. Default once per day. */
const INTERVAL_MS = parseInt(
  process.env.REAPER_INTERVAL_MS || String(24 * 60 * 60 * 1000),
  10,
);

export class ShopReaperService {
  private static instance: ShopReaperService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): ShopReaperService {
    if (!ShopReaperService.instance) {
      ShopReaperService.instance = new ShopReaperService();
    }
    return ShopReaperService.instance;
  }

  /**
   * Start the reaper. Runs once immediately, then on INTERVAL_MS.
   * Idempotent — safe to call from every authenticated request.
   */
  start() {
    if (this.isRunning) return;

    loggers.queue(
      "info",
      `Starting shop reaper (retention ${RETENTION_DAYS}d, interval ${Math.round(INTERVAL_MS / 3600000)}h)`,
    );
    this.isRunning = true;

    this.reapInactiveShops().catch((err) =>
      loggers.queue("error", "Unhandled error in initial shop reap", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    this.intervalId = setInterval(() => {
      this.reapInactiveShops().catch((err) =>
        loggers.queue("error", "Unhandled error in scheduled shop reap", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, INTERVAL_MS);
  }

  /** Stop the reaper. */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      loggers.queue("info", "Shop reaper stopped");
    }
  }

  /**
   * Purge every shop uninstalled longer than the retention window, subject to
   * the safety guards. Returns the purged shop domains and a skipped count.
   */
  async reapInactiveShops(): Promise<{ purged: string[]; skipped: number }> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    loggers.queue(
      "info",
      `Running shop reap (uninstalled before ${cutoff.toISOString()})`,
    );

    const candidates = await db.shopInstallState.findMany({
      where: { uninstalledAt: { not: null, lt: cutoff } },
      select: { shop: true, uninstalledAt: true },
    });

    const purged: string[] = [];
    let skipped = 0;

    for (const { shop } of candidates) {
      // Guard 1: an active install (sessions exist) — cleared on uninstall,
      // recreated on reinstall. Never purge a shop that is installed.
      const sessionCount = await db.session.count({ where: { shop } });
      if (sessionCount > 0) {
        skipped++;
        loggers.queue("info", `Shop reap: skipping ${shop} — ${sessionCount} active session(s)`);
        continue;
      }

      // Guard 2: a paying shop. Only "free" (or no AISettings at all) is
      // eligible — never delete data for a shop that looks like it pays.
      const aiSettings = await db.aISettings.findUnique({
        where: { shop },
        select: { subscriptionPlan: true },
      });
      if (aiSettings && aiSettings.subscriptionPlan !== "free") {
        skipped++;
        loggers.queue(
          "info",
          `Shop reap: skipping ${shop} — paid plan "${aiSettings.subscriptionPlan}"`,
        );
        continue;
      }

      // All guards passed — purge via the single source of truth. shop_id is
      // unused by the deletion logic (only shop_domain is). redactShopData
      // also deletes the ShopInstallState marker, so this won't re-process.
      try {
        await redactShopData({ shop_id: 0, shop_domain: shop });
        purged.push(shop);
        loggers.queue("info", `Shop reap: purged inactive shop ${shop}`);
      } catch (error) {
        skipped++;
        loggers.queue("error", `Shop reap: failed to purge ${shop}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    loggers.queue(
      "info",
      `Shop reap complete: ${purged.length} purged, ${skipped} skipped, ${candidates.length} candidate(s)`,
    );

    return { purged, skipped };
  }

  /** Manually trigger a reap (tests / admin endpoints). */
  async triggerReap(): Promise<{ purged: string[]; skipped: number }> {
    return this.reapInactiveShops();
  }
}
