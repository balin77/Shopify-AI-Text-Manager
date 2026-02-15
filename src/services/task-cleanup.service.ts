/**
 * Task Cleanup Service
 * Automatically deletes tasks older than 3 days
 */

import { db } from "../../app/db.server";
import { loggers } from '../../app/utils/logger.server';

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
      loggers.queue('info', 'Task cleanup service already running');
      return;
    }

    loggers.queue('info', 'Starting task cleanup service...');
    this.isRunning = true;

    // Run immediately on start (handle rejected promise to avoid unhandled rejection)
    this.cleanup().catch(err =>
      loggers.queue('error', 'Unhandled error in initial cleanup', { error: err instanceof Error ? err.message : String(err) })
    );

    // Then run every hour
    this.intervalId = setInterval(() => {
      this.cleanup().catch(err =>
        loggers.queue('error', 'Unhandled error in scheduled cleanup', { error: err instanceof Error ? err.message : String(err) })
      );
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
      loggers.queue('info', 'Task cleanup service stopped');
    }
  }

  /**
   * Clean up expired tasks
   * Deletes all tasks where expiresAt < now
   */
  async cleanup() {
    try {
      const now = new Date();
      loggers.queue('info', `Running cleanup at ${now.toISOString()}...`);

      const result = await db.task.deleteMany({
        where: {
          expiresAt: {
            lt: now,
          },
        },
      });

      if (result.count > 0) {
        loggers.queue('info', `Deleted ${result.count} expired task(s)`);
      } else {
        loggers.queue('debug', 'No expired tasks to delete');
      }
    } catch (error) {
      loggers.queue('error', 'Error during cleanup', { error: error instanceof Error ? error.message : String(error) });
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
