/**
 * Sync Scheduler Service
 *
 * Manages background sync timers for shops based on activity.
 * - Starts syncing when a shop becomes active
 * - Syncs every 40 seconds while shop is active
 * - Stops syncing 5 minutes after last activity
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { BackgroundSyncService } from "./background-sync.service";
import { isShopActive } from "../middleware/activity-tracker.middleware";
import { logger } from "~/utils/logger.server";

interface SyncTimer {
  timer: NodeJS.Timeout;
  shop: string;
  startedAt: Date;
  isRunning: boolean; // Track if sync is currently running
  // Aborts an in-flight initial full sync when the shop's timer is stopped
  // (uninstall / re-auth / graceful shutdown) so it unwinds cleanly instead of
  // running on a revoked token.
  abortController: AbortController;
  // Incremental-cycle counter, used to run the low-frequency webhook-backed
  // drift reconcile (products/collections) only every Nth cycle.
  cycleCount: number;
}

/** 3h wall-clock cap on bypassing the inactivity gate during initial sync. */
const INITIAL_SYNC_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** Run the products/collections drift reconcile every N incremental cycles. */
const RECONCILE_EVERY_N_CYCLES = Math.max(
  1,
  parseInt(process.env.RECONCILE_EVERY_N_CYCLES || "30", 10),
);
/** Min interval between throttled initial-sync progress writes per shop. */
const PROGRESS_WRITE_THROTTLE_MS = 3000;

class SyncSchedulerService {
  private activeTimers: Map<string, SyncTimer> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS || "60000", 10); // default 60s, configurable
  private readonly INACTIVITY_THRESHOLD_MINUTES = 5;
  private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private lastCleanup: Date | null = null;

  // Global concurrency gate. Each shop has its own timer, so with many active
  // shops the per-shop timers eventually align and would run syncAll() for every
  // shop at once -> server CPU + Shopify rate-limit + DB load spike (this is what
  // took the server down). Cap the number of syncAll() running concurrently;
  // excess shops wait in slotWaiters. The per-shop `isRunning` flag guarantees
  // at most ONE waiter per shop, so the queue is bounded by the active-shop count.
  private readonly SYNC_MAX_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.SYNC_MAX_CONCURRENCY || "2", 10)
  );
  private runningSyncs = 0;
  private slotWaiters: Array<() => void> = [];
  // Last persisted-progress timestamp per shop (throttles initial-sync writes).
  private lastProgressWrite: Map<string, number> = new Map();

  constructor() {
    // R4-H4: the periodic GLOBAL database cleanup (expired tasks, old webhook
    // logs, free-plan excess images, orphan alt-translations) used to start
    // ONLY from startSyncForShop(). With no active shop (quiet period, or a
    // fresh deploy before any request) it never ran and the DB grew
    // unbounded. The cleanup is shop-independent, so start it at construction
    // (the singleton is created at server boot via entry.server importing
    // this module). ensureCleanupTimerRunning() is idempotent.
    this.ensureCleanupTimerRunning();
  }

  /**
   * Starts background sync for a shop
   * If sync is already running, it will be restarted
   */
  startSyncForShop(shop: string, admin: AdminApiContext): void {
    // Stop existing timer if running
    if (this.activeTimers.has(shop)) {
      logger.debug(`[SyncScheduler] Restarting sync for shop: ${shop}`);
      this.stopSyncForShop(shop);
    } else {
      logger.debug(`[SyncScheduler] Starting sync for shop: ${shop}`);
    }

    // Random phase offset (0..interval) before the recurring timer starts. A
    // batch of shops that become active in the same tick (server restart, install
    // burst) would otherwise phase-lock and all sync on the same ticks. The
    // concurrency gate in runSyncCycle is the hard cap; this just spreads arrivals
    // so they rarely have to queue at all.
    let entry: SyncTimer;
    const phaseOffset = Math.floor(Math.random() * this.SYNC_INTERVAL_MS);
    const phaseTimer = setTimeout(() => {
      // Shop may have been stopped (or restarted) during the phase offset.
      if (this.activeTimers.get(shop) !== entry) return;
      entry.timer = setInterval(() => {
        this.runSyncCycle(shop, admin).catch(err => {
          logger.error(`[SyncScheduler] Sync cycle failed for ${shop}:`, err);
        });
      }, this.SYNC_INTERVAL_MS);
    }, phaseOffset);

    // Store timer (the phase timer first; swapped to the interval once it fires)
    entry = {
      timer: phaseTimer,
      shop,
      startedAt: new Date(),
      isRunning: false,
      abortController: new AbortController(),
      cycleCount: 0,
    };
    this.activeTimers.set(shop, entry);

    // First sync runs after a short jittered delay (independent of the phase
    // offset) so the initial page load finishes before competing for the DB.
    setTimeout(() => {
      this.runSyncCycle(shop, admin).catch(err => {
        logger.error(`[SyncScheduler] Initial sync failed for ${shop}:`, err);
      });
    }, this.jitter(5000));

    // Start periodic cleanup if not already running
    this.ensureCleanupTimerRunning();
  }

  /**
   * Runs a single sync cycle for a shop
   * Checks activity and stops if shop is inactive
   */
  private async runSyncCycle(shop: string, admin: AdminApiContext): Promise<void> {
    const syncTimer = this.activeTimers.get(shop);

    // Skip if already running (concurrent protection)
    if (syncTimer?.isRunning) {
      logger.debug(`[SyncScheduler] Skipping sync for ${shop} - previous sync still running`);
      return;
    }

    try {
      // Mark as running
      if (syncTimer) {
        syncTimer.isRunning = true;
      }

      const { db } = await import("../db.server");

      // Branch on the "initial full sync completed" marker:
      //  - marker set  → incremental BackgroundSyncService.syncAll() (existing
      //    behaviour, gated by inactivity)
      //  - marker null → full initial sync via the shared orchestrator, server
      //    side, bypassing the inactivity gate until it completes (or 3h cap)
      const st = await db.shopInstallState.findUnique({
        where: { shop },
        select: {
          initialSyncCompletedAt: true,
          initialSyncStartedAt: true,
          initialSyncForceRequested: true,
        },
      });

      if (st?.initialSyncCompletedAt) {
        // ---- Incremental path (unchanged) ----
        const active = await isShopActive(shop, this.INACTIVITY_THRESHOLD_MINUTES);
        if (!active) {
          logger.debug(`[SyncScheduler] Shop ${shop} inactive for ${this.INACTIVITY_THRESHOLD_MINUTES}+ minutes - stopping sync`);
          this.stopSyncForShop(shop);
          return;
        }

        await this.acquireSyncSlot();
        try {
          logger.debug(`[SyncScheduler] Running incremental sync for ${shop} (slots ${this.runningSyncs}/${this.SYNC_MAX_CONCURRENCY})`);
          const syncService = new BackgroundSyncService(admin, shop);
          const stats = await syncService.syncAll();
          logger.debug(`[SyncScheduler] Sync complete for ${shop}: ${stats.total} items in ${stats.duration}ms`);

          // Low-frequency safety net for the webhook-backed types
          // (products/collections): repair missed-webhook drift every N
          // cycles. Runs inside the held slot, only for active shops, never
          // during the initial-sync path. Failures must not break the cycle.
          if (syncTimer) {
            syncTimer.cycleCount++;
            if (syncTimer.cycleCount % RECONCILE_EVERY_N_CYCLES === 0) {
              try {
                const { reconcileWebhookBackedTypes } = await import("./webhook-reconcile.service");
                await reconcileWebhookBackedTypes(admin, shop);
              } catch (err) {
                logger.warn(`[SyncScheduler] Webhook-backed reconcile failed for ${shop}`, {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            // C.3 (PLAN_THEME_SELECTION_B_LITE): periodically refresh the
            // merchant-selected NON-MAIN theme. syncAll() above only covers MAIN
            // (translatableResources can't list other themes), so this scoped pass
            // keeps a selected theme's mirror fresh against external theme-editor
            // edits. Same low cadence as the reconcile to bound API cost; a no-op
            // when the shop uses MAIN or the theme has no rows yet (syncTheme is
            // coalesced + incremental). Failures must not break the cycle.
            if (syncTimer.cycleCount % RECONCILE_EVERY_N_CYCLES === 0) {
              try {
                const { getCachedThemes, resolveSelectedThemeId, pickMainThemeId } = await import("./theme-selection.server");
                const themes = await getCachedThemes(admin, shop);
                const selected = await resolveSelectedThemeId(shop, admin, themes);
                if (selected && selected !== pickMainThemeId(themes)) {
                  await syncService.syncTheme(selected);
                }
              } catch (err) {
                logger.warn(`[SyncScheduler] Selected-theme scoped sync failed for ${shop}`, {
                  error: err instanceof Error ? err.message : String(err),
                });
              }

              // Keep the theme's llms.txt in step with the catalog. Same low
              // cadence as the reconcile above, and for the same reason: the
              // products/collections that feed llms.txt arrive via webhooks,
              // not via syncAll(), so there is no completion event to hang
              // this off. It reads the file, compares, and writes only on a
              // real difference — and does nothing at all while
              // AEO_THEME_WRITES is off. Failures must not break the cycle.
              try {
                const { refreshLlmsTxtIfStale } = await import("./seo/aeo.service");
                const outcome = await refreshLlmsTxtIfStale(admin, db, shop);
                if (outcome === "updated") {
                  logger.debug(`[SyncScheduler] llms.txt refreshed for ${shop}`);
                }
              } catch (err) {
                logger.warn(`[SyncScheduler] llms.txt refresh failed for ${shop}`, {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        } finally {
          this.releaseSyncSlot();
        }
        return;
      }

      // ---- Initial full sync path ----
      // Anchor the bypass cap. Persist initialSyncStartedAt on first cycle.
      let startedAt = st?.initialSyncStartedAt ?? null;
      if (!startedAt) {
        startedAt = new Date();
        await db.shopInstallState.upsert({
          where: { shop },
          create: { shop, initialSyncStartedAt: startedAt },
          update: { initialSyncStartedAt: startedAt },
        });
      }

      const aged = Date.now() - startedAt.getTime() > INITIAL_SYNC_MAX_AGE_MS;
      if (aged) {
        // Safety cap hit — stop bypassing the inactivity gate so a shop whose
        // catalog genuinely never completes does not occupy a slot forever.
        logger.warn(`[SyncScheduler] Initial sync for ${shop} exceeded 3h cap - falling back to inactivity gating`);
        await db.shopInstallState.update({
          where: { shop },
          data: { initialSyncError: "timeout" },
        }).catch(() => {});
        const active = await isShopActive(shop, this.INACTIVITY_THRESHOLD_MINUTES);
        if (!active) {
          this.stopSyncForShop(shop);
          return;
        }
      }
      // else: within cap → bypass the inactivity gate entirely.

      const signal = syncTimer?.abortController.signal;
      let lastWrittenPhase = "";
      const throttledWriter = (p: { phase: string; overallPercent: number; stats: Record<string, number> }) => {
        const now = Date.now();
        const last = this.lastProgressWrite.get(shop) ?? 0;
        const phaseChanged = p.phase !== lastWrittenPhase;
        if (!phaseChanged && p.overallPercent < 100 && now - last < PROGRESS_WRITE_THROTTLE_MS) {
          return;
        }
        lastWrittenPhase = p.phase;
        this.lastProgressWrite.set(shop, now);
        db.shopInstallState.update({
          where: { shop },
          data: {
            initialSyncPhase: p.phase,
            initialSyncPercent: Math.round(p.overallPercent),
            initialSyncStats: p.stats,
          },
        }).catch(() => { /* progress write is best-effort */ });
      };

      await this.acquireSyncSlot();
      try {
        logger.info(`[SyncScheduler] Running INITIAL full sync for ${shop} (force=${!!st?.initialSyncForceRequested}, slots ${this.runningSyncs}/${this.SYNC_MAX_CONCURRENCY})`);

        // Use a FRESH admin context (not the one captured in the timer closure):
        // the initial sync can run many minutes, longer than that token's life.
        const { unauthenticated } = await import("../shopify.server");
        const { admin: freshAdmin } = await unauthenticated.admin(shop);

        const { runInitialFullSync } = await import("./initial-sync.service");
        const { stats, completed } = await runInitialFullSync(freshAdmin, shop, {
          force: !!st?.initialSyncForceRequested,
          signal,
          onProgress: throttledWriter,
        });

        if (completed) {
          logger.info(`[SyncScheduler] Initial sync complete for ${shop}`, { stats });
        } else {
          // A phase failed: marker left unset on purpose → retry next cycle.
          logger.warn(`[SyncScheduler] Initial sync incomplete for ${shop} (phase failed) - will retry next cycle`, { stats });
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          logger.info(`[SyncScheduler] Initial sync aborted for ${shop} (timer stopped)`);
        } else {
          logger.error(`[SyncScheduler] Initial sync failed for ${shop} - will retry next cycle:`, err);
          await db.shopInstallState.update({
            where: { shop },
            data: { initialSyncError: err instanceof Error ? err.message : String(err) },
          }).catch(() => {});
        }
        // Marker stays null → next cycle resumes (idempotent upserts).
      } finally {
        this.releaseSyncSlot();
      }
    } catch (error) {
      logger.error(`[SyncScheduler] Sync cycle failed for ${shop}:`, error);
      // Don't stop timer on error - retry next cycle
    } finally {
      // Mark as not running — but ONLY on the timer entry this cycle started
      // with. If startSyncForShop replaced the entry mid-run (upgrade trigger /
      // force re-sync / multi-tab), this.activeTimers.get(shop) is the NEW
      // entry whose own first cycle may already be running; clearing its flag
      // would allow two concurrent syncs for the same shop.
      if (syncTimer && this.activeTimers.get(shop) === syncTimer) {
        syncTimer.isRunning = false;
      }
    }
  }

  /**
   * Stops background sync for a shop
   */
  stopSyncForShop(shop: string): void {
    const syncTimer = this.activeTimers.get(shop);

    if (syncTimer) {
      syncTimer.abortController.abort();
      clearInterval(syncTimer.timer);
      this.activeTimers.delete(shop);
      this.lastProgressWrite.delete(shop);
      logger.debug(`[SyncScheduler] Stopped sync for shop: ${shop}`);
    }
  }

  /**
   * Acquires a global sync slot. Resolves immediately if under the concurrency
   * limit, otherwise queues until another sync releases its slot.
   */
  private acquireSyncSlot(): Promise<void> {
    if (this.runningSyncs < this.SYNC_MAX_CONCURRENCY) {
      this.runningSyncs++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.slotWaiters.push(resolve);
    });
  }

  /**
   * Releases a global sync slot, handing it directly to the next waiter (if any)
   * so the running count never exceeds SYNC_MAX_CONCURRENCY.
   */
  private releaseSyncSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) {
      next(); // slot stays accounted for, just transferred to the waiter
    } else {
      this.runningSyncs = Math.max(0, this.runningSyncs - 1);
    }
  }

  /**
   * Returns `ms` with ±20% random jitter so independent timers don't phase-lock.
   */
  private jitter(ms: number): number {
    const spread = ms * 0.2;
    return Math.round(ms + (Math.random() * 2 - 1) * spread);
  }

  /**
   * Checks if sync is active for a shop
   */
  isShopActive(shop: string): boolean {
    return this.activeTimers.has(shop);
  }

  /**
   * Gets the number of active sync timers
   */
  getActiveShopsCount(): number {
    return this.activeTimers.size;
  }

  /**
   * Gets list of all shops with active sync
   */
  getActiveShops(): string[] {
    return Array.from(this.activeTimers.keys());
  }

  /**
   * Gets sync info for a specific shop
   */
  getSyncInfo(shop: string): { active: boolean; startedAt?: Date } {
    const syncTimer = this.activeTimers.get(shop);

    if (syncTimer) {
      return {
        active: true,
        startedAt: syncTimer.startedAt,
      };
    }

    return { active: false };
  }

  /**
   * Stops all sync timers (for graceful shutdown)
   */
  stopAll(): void {
    logger.debug(`[SyncScheduler] Stopping all sync timers (${this.activeTimers.size} active)`);

    for (const [shop, syncTimer] of this.activeTimers.entries()) {
      syncTimer.abortController.abort();
      clearInterval(syncTimer.timer);
      logger.debug(`[SyncScheduler] Stopped sync for: ${shop}`);
    }

    this.activeTimers.clear();
    this.lastProgressWrite.clear();

    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.debug(`[SyncScheduler] Stopped cleanup timer`);
    }

    logger.debug(`[SyncScheduler] All sync timers stopped`);
  }

  /**
   * Ensures the periodic cleanup timer is running
   */
  private ensureCleanupTimerRunning(): void {
    if (!this.cleanupTimer) {
      logger.debug(`[SyncScheduler] Starting periodic database cleanup timer`);
      this.cleanupTimer = setInterval(() => {
        this.runDatabaseCleanup().catch(err => {
          logger.error(`[SyncScheduler] Database cleanup failed:`, err);
        });
      }, this.CLEANUP_INTERVAL_MS);

      // Run cleanup immediately on first start
      this.runDatabaseCleanup().catch(err => {
        logger.error(`[SyncScheduler] Initial database cleanup failed:`, err);
      });
    }
  }

  /**
   * Runs periodic database cleanup to prevent data accumulation
   */
  private async runDatabaseCleanup(): Promise<void> {
    logger.debug(`[SyncScheduler] Running periodic database cleanup...`);
    this.lastCleanup = new Date();

    try {
      const { db } = await import("../db.server");

      // 1. Delete expired tasks (older than 3 days)
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const expiredTasks = await db.task.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: new Date() } },
            {
              status: { in: ['completed', 'failed', 'cancelled'] },
              completedAt: { lt: threeDaysAgo }
            }
          ]
        }
      });

      // 2. Delete old webhook logs.
      //   a) processed rows after 24h (minimise storage for multi-tenant SaaS).
      //   b) H6 fix: failed/unprocessed rows are NOT exempt from retention —
      //      previously they were never purged and accumulated unbounded. They
      //      get a longer grace window (7 days) so transient failures can still
      //      be inspected/retried, then are removed regardless of `processed`.
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [processedLogs, staleLogs] = await Promise.all([
        db.webhookLog.deleteMany({
          where: { createdAt: { lt: oneDayAgo }, processed: true }
        }),
        db.webhookLog.deleteMany({
          where: { createdAt: { lt: sevenDaysAgo } }
        })
      ]);
      const webhookLogs = { count: processedLogs.count + staleLogs.count };

      // 3. Delete excess product images ONLY for free-plan shops
      // Free plan: productImages = "featured-only", so only keep first image
      // Basic/Pro/Max plans: productImages = "all", keep all images cached
      const freeShops = await db.aISettings.findMany({
        where: {
          subscriptionPlan: "free"
        },
        select: { shop: true }
      });
      const freeShopNames = freeShops.map(s => s.shop);

      // R4-H4: batch the free-plan excess-image purge. A single deleteMany
      // with `product: { shop: { in: <all free shops> } }` is an unbatched
      // anti-join: one huge IN() list + a join-driven delete that can lock a
      // large slice of ProductImage for a long time on a multi-tenant DB.
      // Chunk the shop list so each statement is bounded.
      let excessImages = { count: 0 };
      const SHOP_BATCH = 50;
      for (let i = 0; i < freeShopNames.length; i += SHOP_BATCH) {
        const batch = freeShopNames.slice(i, i + SHOP_BATCH);
        const res = await db.productImage.deleteMany({
          where: {
            position: { gt: 0 },
            product: { shop: { in: batch } },
          },
        });
        excessImages.count += res.count;
      }

      // 4. Delete orphaned image alt-text translations (images that no longer exist).
      // Use a single atomic SQL statement instead of fetching all image IDs into Node
      // memory first — avoids OOM on shops with >10 000 images (N+1 pattern fix).
      await db.$executeRaw`
        DELETE FROM "ProductImageAltTranslation"
        WHERE "imageId" NOT IN (SELECT id FROM "ProductImage")
      `;

      // 5. R4-H5: ContentTranslation has a POLYMORPHIC resourceId (no FK /
      // ON DELETE CASCADE), so rows orphan whenever the underlying resource
      // disappears without going through a path that scrubs them, and there
      // was no periodic purge → unbounded growth. We only purge the
      // UNAMBIGUOUS, dominant case here — resourceType='Product' whose
      // resourceId no longer exists in Product — as one atomic anti-join
      // (same pattern as #4). Scoped strictly by resourceType so it can
      // never touch Collection/Article/Page/ShopPolicy/Metaobject or the
      // sub-resource (ProductOption/…/Metafield) rows, whose id spaces are
      // not the Product table; a correct purge for those needs per-type
      // mapping and is deliberately left for a dedicated change.
      const orphanCT = await db.$executeRaw`
        DELETE FROM "ContentTranslation"
        WHERE "resourceType" = 'Product'
          AND "resourceId" NOT IN (SELECT id FROM "Product")
      `;

      logger.debug(`[SyncScheduler] Cleanup complete: ${expiredTasks.count} tasks, ${webhookLogs.count} logs, ${excessImages.count} excess images (free-plan only), ${orphanCT} orphan product translations`);
      logger.debug(`[SyncScheduler] Note: Theme data cleanup is now handled by aggressive sync (every 40s)`);
    } catch (error) {
      logger.error(`[SyncScheduler] Cleanup error:`, error);
      throw error;
    }
  }

  /**
   * Gets statistics about the scheduler
   */
  getStats(): {
    activeShops: number;
    shops: string[];
    syncIntervalSeconds: number;
    inactivityThresholdMinutes: number;
    cleanupEnabled: boolean;
    lastCleanup: Date | null;
    nextCleanup: Date | null;
  } {
    const nextCleanup = this.lastCleanup
      ? new Date(this.lastCleanup.getTime() + this.CLEANUP_INTERVAL_MS)
      : null;

    return {
      activeShops: this.activeTimers.size,
      shops: Array.from(this.activeTimers.keys()),
      syncIntervalSeconds: this.SYNC_INTERVAL_MS / 1000,
      inactivityThresholdMinutes: this.INACTIVITY_THRESHOLD_MINUTES,
      cleanupEnabled: this.cleanupTimer !== null,
      lastCleanup: this.lastCleanup,
      nextCleanup,
    };
  }
}

// Singleton instance
export const syncScheduler = new SyncSchedulerService();
