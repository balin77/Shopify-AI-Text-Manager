/**
 * Task Cleanup Service (Standalone)
 * Automatically deletes tasks older than 3 days
 * This file is imported directly by server.js and not processed by Remix build
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class TaskCleanupService {
  static instance = null;
  intervalId = null;
  isRunning = false;

  constructor() {}

  static getInstance() {
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

      const result = await prisma.task.deleteMany({
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
  async triggerCleanup() {
    const now = new Date();
    const result = await prisma.task.deleteMany({
      where: {
        expiresAt: {
          lt: now,
        },
      },
    });
    return result.count;
  }
}
