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
}

class SyncSchedulerService {
  private activeTimers: Map<string, SyncTimer> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS || "60000", 10); // default 60s, configurable
  private readonly INACTIVITY_THRESHOLD_MINUTES = 5;
  private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private lastCleanup: Date | null = null;

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

    // Create new timer
    const timer = setInterval(async () => {
      await this.runSyncCycle(shop, admin);
    }, this.SYNC_INTERVAL_MS);

    // Store timer
    this.activeTimers.set(shop, {
      timer,
      shop,
      startedAt: new Date(),
      isRunning: false,
    });

    // Delay first sync by 5 s so the initial page load can finish before competing for DB
    setTimeout(() => {
      this.runSyncCycle(shop, admin).catch(err => {
        logger.error(`[SyncScheduler] Initial sync failed for ${shop}:`, err);
      });
    }, 5000);

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

      // Check if shop is still active
      const active = await isShopActive(shop, this.INACTIVITY_THRESHOLD_MINUTES);

      if (!active) {
        logger.debug(`[SyncScheduler] Shop ${shop} inactive for ${this.INACTIVITY_THRESHOLD_MINUTES}+ minutes - stopping sync`);
        this.stopSyncForShop(shop);
        return;
      }

      // Shop is active - run sync
      logger.debug(`[SyncScheduler] Running sync cycle for ${shop}`);

      const syncService = new BackgroundSyncService(admin, shop);
      const stats = await syncService.syncAll();

      logger.debug(`[SyncScheduler] Sync complete for ${shop}: ${stats.total} items in ${stats.duration}ms`);
    } catch (error) {
      logger.error(`[SyncScheduler] Sync cycle failed for ${shop}:`, error);
      // Don't stop timer on error - retry next cycle
    } finally {
      // Mark as not running
      const timer = this.activeTimers.get(shop);
      if (timer) {
        timer.isRunning = false;
      }
    }
  }

  /**
   * Stops background sync for a shop
   */
  stopSyncForShop(shop: string): void {
    const syncTimer = this.activeTimers.get(shop);

    if (syncTimer) {
      clearInterval(syncTimer.timer);
      this.activeTimers.delete(shop);
      logger.debug(`[SyncScheduler] Stopped sync for shop: ${shop}`);
    }
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
      clearInterval(syncTimer.timer);
      logger.debug(`[SyncScheduler] Stopped sync for: ${shop}`);
    }

    this.activeTimers.clear();

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

      let excessImages = { count: 0 };
      if (freeShopNames.length > 0) {
        excessImages = await db.productImage.deleteMany({
          where: {
            position: { gt: 0 },
            product: {
              shop: { in: freeShopNames }
            }
          }
        });
      }

      // 4. Delete orphaned image alt-text translations (images that no longer exist).
      // Use a single atomic SQL statement instead of fetching all image IDs into Node
      // memory first — avoids OOM on shops with >10 000 images (N+1 pattern fix).
      await db.$executeRaw`
        DELETE FROM "ProductImageAltTranslation"
        WHERE "imageId" NOT IN (SELECT id FROM "ProductImage")
      `;

      logger.debug(`[SyncScheduler] Cleanup complete: ${expiredTasks.count} tasks, ${webhookLogs.count} logs, ${excessImages.count} excess images (free-plan only)`);
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
