/**
 * Task Cleanup Service
 * Automatically deletes tasks older than 3 days
 */

import { db } from "../../app/db.server";

export class TaskCleanupService {
  private static instance: TaskCleanupService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): TaskCleanupService {
    if (!TaskCleanupService.instance) {
      TaskCleanupService.instance = new TaskCleanupService();
    }
    return TaskCleanupService.instance;
  }

  /**
   * Start the cleanup service
   * Runs every hour to clean up expired tasks
   */
  start() {
    if (this.isRunning) {
      console.log('[TaskCleanup] Service already running');
      return;
    }

    console.log('[TaskCleanup] Starting task cleanup service...');
    this.isRunning = true;

    // Run immediately on start
    this.cleanup();

    // Then run every hour
    this.intervalId = setInterval(() => {
      this.cleanup();
    }, 60 * 60 * 1000); // 1 hour
  }

  /**
   * Stop the cleanup service
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      console.log('[TaskCleanup] Service stopped');
    }
  }

  /**
   * Clean up expired tasks
   * Deletes all tasks where expiresAt < now
   */
  async cleanup() {
    try {
      const now = new Date();
      console.log(`[TaskCleanup] Running cleanup at ${now.toISOString()}...`);

      const result = await db.task.deleteMany({
        where: {
          expiresAt: {
            lt: now,
          },
        },
      });

      if (result.count > 0) {
        console.log(`[TaskCleanup] Deleted ${result.count} expired task(s)`);
      } else {
        console.log('[TaskCleanup] No expired tasks to delete');
      }
    } catch (error) {
      console.error('[TaskCleanup] Error during cleanup:', error);
    }
  }

  /**
   * Manually trigger cleanup (useful for testing or API endpoints)
   */
  async triggerCleanup(): Promise<number> {
    const now = new Date();
    const result = await db.task.deleteMany({
      where: {
        expiresAt: {
          lt: now,
        },
      },
    });
    return result.count;
  }
}
