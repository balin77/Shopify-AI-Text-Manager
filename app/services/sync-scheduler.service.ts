/**
 * Sync Scheduler Service
 *
 * Manages background sync timers for shops based on activity.
 * - Starts syncing when a shop becomes active
 * - Syncs every 40 seconds while shop is active
 * - Stops syncing 5 minutes after last activity
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { BackgroundSyncService } from "./background-sync.service";
import { getLastActivity, isShopActive } from "../middleware/activity-tracker.middleware";
import { logger } from "~/utils/logger.server";
import { NOT_OPEN_BATCH_TASK, SETTLED_TASK_STATUSES } from "~/config/task-statuses.js";
import { backgroundAdmin, createRefreshingAdmin, maybeMigrateToExpiringToken, migrationMayBeNeeded } from "~/utils/offline-admin.server";
import { expiringOfflineTokensEnabled } from "~/utils/offline-token-flags.server";

/** The scheduler's first minute is left alone by the token migration (see runSyncCycle). */
export const MIGRATION_SETTLE_MS = 60 * 1000;
/**
 * ...and it only migrates while the shop has made no authenticated request for
 * this long (`Session.lastActivityAt`, stamped by every `authenticate.admin`).
 * The scheduler runs only while the merchant is active, so without this gate a
 * migration would land in the middle of their clicking, and a request in
 * flight then holds the revoked token and fails (see
 * maybeMigrateToExpiringToken).
 */
export const MIGRATION_QUIET_MS = 20 * 1000;

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
/**
 * Cycle on which the llms.txt refresh runs once per active session, before the
 * slow `RECONCILE_EVERY_N_CYCLES` cadence takes over. Low enough that a short
 * visit still gets a check, high enough to stay out of the way of the initial
 * page load and the first sync.
 */
const LLMS_REFRESH_FIRST_CYCLE = 3;

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
  private async runSyncCycle(shop: string, capturedAdmin: AdminApiContext): Promise<void> {
    const syncTimer = this.activeTimers.get(shop);
    // The admin captured in the timer closure belongs to the request that
    // started the scheduler. With expiring offline tokens it dies ~1h later
    // while the timer keeps firing, so each cycle uses a client that asks for a
    // (refreshed) token per call instead. Flag off: the captured one, as before.
    const admin = backgroundAdmin(shop, capturedAdmin);

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

      // Lazy token migration for shops the scheduler keeps alive (double-gated
      // by env, a no-op by default, never throws). This background cycle is
      // the ONLY trigger — never the request path, whose captured session
      // still holds the old token (see maybeMigrateToExpiringToken). Not on
      // the cycles of the first minute either: the scheduler is started BY a
      // request, and the initial cycle fires ~5s later, while that request may
      // still be using the old token. And only in a QUIET moment: the
      // scheduler runs only while the merchant is active, so a migration at
      // any later cycle could still collide with a request in flight — it
      // waits until the shop has made no authenticated request for
      // MIGRATION_QUIET_MS. No timer entry (a cycle of a stopped scheduler) or
      // an unknown last activity (failed lookup) migrates nothing.
      if (
        syncTimer &&
        Date.now() - syncTimer.startedAt.getTime() >= MIGRATION_SETTLE_MS &&
        migrationMayBeNeeded(shop)
      ) {
        const lastActivity = await getLastActivity(shop);
        if (lastActivity && Date.now() - lastActivity.getTime() >= MIGRATION_QUIET_MS) {
          // AWAITED, and this cycle's sync does not run after one that acted.
          // Shopify revokes the old token the moment the exchange lands, so a
          // sync started beside it (this used to be `void`) carried the dead
          // token into its reads: on dev the in-flight sync took 401s and the
          // raw CookieBanner fetch lost four translation reads that cycle. The
          // call never throws and is bounded (each attempt is cut off after
          // MIGRATION_ATTEMPT_TIMEOUT_MS, at most four attempts with 2/5/15 s
          // pauses, about two minutes in the worst case), and `isRunning` keeps
          // the next tick from stacking.
          //
          // Skipped for "migrated", "failed" and "needs_reauth", not only
          // "migrated": after a failed or refused exchange we cannot tell
          // whether the old token still lives, and a sync on an unknown token is
          // the very 401 burst above. This only spares THIS cycle: only after
          // "migrated" is the next cycle (SYNC_INTERVAL_MS, 60 s by default)
          // on a settled token. After "failed" the migration is in back-off and
          // later cycles sync during it (their migration call answers "backoff",
          // a quiet outcome) on a token that may be revoked, until a retry
          // lands; after "needs_reauth" the dead token was blanked and they
          // fail with no_token until the merchant opens the app. Both end in
          // the migration retry / the merchant's next visit, not in this skip.
          // The quiet outcomes ("not_needed", "disabled", "backoff",
          // "no_session") changed nothing, so the sync goes ahead.
          const outcome = await maybeMigrateToExpiringToken(shop);
          if (outcome === "migrated" || outcome === "failed" || outcome === "needs_reauth") {
            logger.info(`[SyncScheduler] Token migration ran for ${shop} (${outcome}) - sync deferred to the next cycle`);
            return;
          }
          // The wait can outlast this cycle's timer entry: the scheduler may
          // have been stopped or restarted (upgrade trigger, force re-sync,
          // multi-tab) meanwhile. The cycle of a REPLACED entry must not run a
          // sync beside the new one. `finally` still releases what it holds
          // (and, by the identity check there, never touches the live entry).
          if (this.activeTimers.get(shop) !== syncTimer) {
            logger.debug(`[SyncScheduler] Timer for ${shop} was replaced or stopped during the token migration - cycle abandoned`);
            return;
          }
        }
      }

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
          resyncRequiredSince: true,
        },
      });

      if (st?.initialSyncCompletedAt) {
        // ---- Incremental path ----
        // Changes missed while the shop was blocked or uninstalled are owed a
        // catch-up (PLAN_ADMIN_SHOP_OVERVIEW 2.4). BEFORE the inactivity check,
        // so even a short visit after the new login repairs them; the periodic
        // reconcile below needs ~30 minutes of uninterrupted activity. Holds a
        // sync slot like any other Shopify work, never throws, and the helper
        // refuses a blocked shop and runs at most once per shop at a time.
        if (st.resyncRequiredSince) {
          await this.acquireSyncSlot();
          try {
            const { runWebhookCatchUp } = await import("./webhook-catchup.server");
            await runWebhookCatchUp(shop, admin);
          } catch (err) {
            logger.warn(`[SyncScheduler] Webhook catch-up failed for ${shop}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            this.releaseSyncSlot();
          }
        }

        const active = await isShopActive(shop, this.INACTIVITY_THRESHOLD_MINUTES);
        if (!active) {
          logger.debug(`[SyncScheduler] Shop ${shop} inactive for ${this.INACTIVITY_THRESHOLD_MINUTES}+ minutes - stopping sync`);
          this.stopSyncForShop(shop);
          return;
        }

        // A catch-up of this shop started elsewhere (the connection sweep) is
        // still reading and writing the same caches: no syncAll beside it.
        const { isCatchUpInFlight } = await import("./webhook-catchup.server");
        if (isCatchUpInFlight(shop)) {
          logger.debug(`[SyncScheduler] Catch-up in flight for ${shop} - incremental sync deferred to the next cycle`);
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

            }

            // Keep the theme's llms.txt in step with the catalog. The
            // products/collections that feed it arrive via webhooks, not
            // through syncAll(), so there is no completion event to hang this
            // off and it has to be time-based.
            //
            // NOT on the reconcile cadence: cycleCount resets in
            // startSyncForShop and the scheduler stops after
            // INACTIVITY_THRESHOLD_MINUTES, so a 30-cycle trigger would need 30
            // UNINTERRUPTED minutes in the app and would, for most merchants,
            // never fire at all. Instead: once shortly after the merchant
            // becomes active, then on the slow cadence while they stay.
            //
            // Cost is bounded — a shop with the toggle off is one indexed
            // lookup and no Shopify call. Failures must not break the cycle.
            if (
              syncTimer.cycleCount === LLMS_REFRESH_FIRST_CYCLE ||
              syncTimer.cycleCount % RECONCILE_EVERY_N_CYCLES === 0
            ) {
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
        // the initial sync can run many minutes — with expiring offline tokens
        // HOURS past one token's life — so with the flag on the client
        // re-acquires (and refreshes) its token per call.
        let freshAdmin: AdminApiContext;
        if (expiringOfflineTokensEnabled()) {
          freshAdmin = createRefreshingAdmin(shop);
        } else {
          const { unauthenticated } = await import("../shopify.server");
          ({ admin: freshAdmin } = await unauthenticated.admin(shop));
        }

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

      // 0. Copy the per-shop task statistics of the last three days into
      //    ShopUsageDay BEFORE the tasks below are deleted (it is idempotent,
      //    never lowers a figure and never touches the tracker's counters), and
      //    drop usage rows past their 90-day retention. A failure here is
      //    logged inside and must not stop the cleanup.
      {
        const { rollupTaskUsage, pruneShopUsage } = await import("./shop-usage-rollup.server");
        await rollupTaskUsage(db as never);
        await pruneShopUsage(db as never);
      }

      // 1. Delete expired tasks (older than 3 days)
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const expiredTasks = await db.task.deleteMany({
        where: {
          OR: [
            // Never an open batch task (submitting / waiting_batch /
            // cancel_requested): its row is the only handle on a paid
            // provider batch (PLAN_BULK_TRANSLATE_BATCHING 19.4).
            { expiresAt: { lt: new Date() }, ...NOT_OPEN_BATCH_TASK },
            {
              status: { in: [...SETTLED_TASK_STATUSES] },
              completedAt: { lt: threeDaysAgo }
            }
          ]
        }
      });

      // Batch housekeeping that must not depend on the poller being switched
      // on: (1) the absolute end of an open batch run (a run that has waited
      // longer than any provider batch lives is closed as batch_unreachable and
      // its hold released), (2) the reservation sweep -- a settled row whose
      // release was lost (crash, failed transaction) would otherwise keep part
      // of the shop's budget and of the global pool for ever.
      try {
        const { expireStaleBatches } = await import('./bulk-editor/translate-batch-expiry.server');
        await expireStaleBatches();
        const { releaseSettledReservations } = await import('./ai/usage-meter.server');
        await releaseSettledReservations();
      } catch (error) {
        logger.warn('[SyncScheduler] Batch housekeeping failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // The batch state of a settled run goes with its (expired) task. A row
      // still holding a reservation stays until the reservation sweep has
      // released it (usage-meter.server.ts releaseSettledReservations).
      try {
        await db.bulkTranslateBatch.deleteMany({
          where: { state: 'done', reservationState: { not: 'held' }, updatedAt: { lt: threeDaysAgo } },
        });
      } catch (error) {
        // Housekeeping only: never let it stop the rest of the cleanup.
        logger.warn('[SyncScheduler] Settled batch rows could not be pruned', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

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
