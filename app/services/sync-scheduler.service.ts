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

interface SyncTimer {
  timer: NodeJS.Timeout;
  shop: string;
  startedAt: Date;
  isRunning: boolean; // Track if sync is currently running
}

class SyncSchedulerService {
  private activeTimers: Map<string, SyncTimer> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly SYNC_INTERVAL_MS = 40000; // 40 seconds
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
      console.log(`[SyncScheduler] Restarting sync for shop: ${shop}`);
      this.stopSyncForShop(shop);
    } else {
      console.log(`[SyncScheduler] Starting sync for shop: ${shop}`);
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

    // Run first sync immediately
    this.runSyncCycle(shop, admin).catch(err => {
      console.error(`[SyncScheduler] Initial sync failed for ${shop}:`, err);
    });

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
      console.log(`[SyncScheduler] Skipping sync for ${shop} - previous sync still running`);
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
        console.log(`[SyncScheduler] Shop ${shop} inactive for ${this.INACTIVITY_THRESHOLD_MINUTES}+ minutes - stopping sync`);
        this.stopSyncForShop(shop);
        return;
      }

      // Shop is active - run sync
      console.log(`[SyncScheduler] Running sync cycle for ${shop}`);

      const syncService = new BackgroundSyncService(admin, shop);
      const stats = await syncService.syncAll();

      console.log(`[SyncScheduler] Sync complete for ${shop}: ${stats.total} items in ${stats.duration}ms`);
    } catch (error) {
      console.error(`[SyncScheduler] Sync cycle failed for ${shop}:`, error);
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
      console.log(`[SyncScheduler] Stopped sync for shop: ${shop}`);
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
    console.log(`[SyncScheduler] Stopping all sync timers (${this.activeTimers.size} active)`);

    for (const [shop, syncTimer] of this.activeTimers.entries()) {
      clearInterval(syncTimer.timer);
      console.log(`[SyncScheduler] Stopped sync for: ${shop}`);
    }

    this.activeTimers.clear();

    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      console.log('[SyncScheduler] Stopped cleanup timer');
    }

    console.log('[SyncScheduler] All sync timers stopped');
  }

  /**
   * Ensures the periodic cleanup timer is running
   */
  private ensureCleanupTimerRunning(): void {
    if (!this.cleanupTimer) {
      console.log('[SyncScheduler] Starting periodic database cleanup timer');
      this.cleanupTimer = setInterval(() => {
        this.runDatabaseCleanup().catch(err => {
          console.error('[SyncScheduler] Database cleanup failed:', err);
        });
      }, this.CLEANUP_INTERVAL_MS);

      // Run cleanup immediately on first start
      this.runDatabaseCleanup().catch(err => {
        console.error('[SyncScheduler] Initial database cleanup failed:', err);
      });
    }
  }

  /**
   * Runs periodic database cleanup to prevent data accumulation
   */
  private async runDatabaseCleanup(): Promise<void> {
    console.log('[SyncScheduler] Running periodic database cleanup...');
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

      // 2. Delete old webhook logs (older than 24 hours)
      // Reduced from 7 days to 24h to minimize database storage for multi-tenant SaaS
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const webhookLogs = await db.webhookLog.deleteMany({
        where: {
          createdAt: { lt: oneDayAgo },
          processed: true
        }
      });

      console.log(`[SyncScheduler] Cleanup complete: ${expiredTasks.count} tasks, ${webhookLogs.count} logs`);
      console.log(`[SyncScheduler] Note: Theme data cleanup is now handled by aggressive sync (every 40s)`);
    } catch (error) {
      console.error('[SyncScheduler] Cleanup error:', error);
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
