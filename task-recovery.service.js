/**
 * Task Recovery Service (Standalone)
 * Recovers pending/queued tasks after server restart
 * This file is imported directly by server.js and not processed by Remix build
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Timeout for stuck tasks (10 minutes)
const STUCK_TASK_TIMEOUT_MS = 10 * 60 * 1000;

// Check for stuck tasks every 2 minutes
const STUCK_CHECK_INTERVAL_MS = 2 * 60 * 1000;

export class TaskRecoveryService {
  static instance = null;
  stuckCheckInterval = null;

  constructor() {}

  static getInstance() {
    if (!TaskRecoveryService.instance) {
      TaskRecoveryService.instance = new TaskRecoveryService();
    }
    return TaskRecoveryService.instance;
  }

  /**
   * Start periodic check for stuck tasks
   * This should be called once at server startup after initial recovery
   */
  startStuckTaskMonitoring() {
    if (this.stuckCheckInterval) {
      console.log('[TaskRecovery] Stuck task monitoring already running');
      return;
    }

    console.log('[TaskRecovery] Starting stuck task monitoring (every 2 minutes)');

    this.stuckCheckInterval = setInterval(async () => {
      try {
        const stuckCount = await this.markStuckTasksAsFailed();
        if (stuckCount > 0) {
          console.log(`[TaskRecovery] Periodic check: marked ${stuckCount} stuck task(s) as failed`);
        }
      } catch (error) {
        console.error('[TaskRecovery] Error during stuck task check:', error);
      }
    }, STUCK_CHECK_INTERVAL_MS);
  }

  /**
   * Stop the stuck task monitoring
   */
  stopStuckTaskMonitoring() {
    if (this.stuckCheckInterval) {
      clearInterval(this.stuckCheckInterval);
      this.stuckCheckInterval = null;
      console.log('[TaskRecovery] Stopped stuck task monitoring');
    }
  }

  /**
   * Recover all pending tasks after server restart
   * Called once at server startup
   */
  async recoverPendingTasks() {
    console.log('[TaskRecovery] Starting task recovery...');

    // Mark stuck tasks as failed
    const stuckCount = await this.markStuckTasksAsFailed();

    // Reset queued/pending tasks so they can be retried
    // Note: We don't auto-requeue them because that requires AI settings
    // which should be loaded in the context of a user request
    const resetCount = await this.resetPendingTasks();

    console.log(`[TaskRecovery] Recovery complete: ${resetCount} reset to queued, ${stuckCount} marked as failed`);

    return { recovered: resetCount, failed: stuckCount };
  }

  /**
   * Mark tasks stuck in "running" or "pending" status as failed
   * A task is considered stuck if it's been running/pending for more than 10 minutes without update
   */
  async markStuckTasksAsFailed() {
    const stuckThreshold = new Date(Date.now() - STUCK_TASK_TIMEOUT_MS);

    const result = await prisma.task.updateMany({
      where: {
        status: { in: ['running', 'pending', 'queued'] },
        updatedAt: { lt: stuckThreshold },
      },
      data: {
        status: 'failed',
        error: 'Task timed out - no progress for more than 10 minutes',
        completedAt: new Date(),
      },
    });

    if (result.count > 0) {
      console.log(`[TaskRecovery] Marked ${result.count} stuck task(s) as failed`);
    }

    return result.count;
  }

  /**
   * Reset pending tasks to queued status
   * Tasks that were "pending" when the server restarted are reset to "queued"
   * so the queue processor will pick them up again
   */
  async resetPendingTasks() {
    const result = await prisma.task.updateMany({
      where: {
        status: 'pending',
        expiresAt: { gt: new Date() }, // Not expired
      },
      data: {
        status: 'queued',
        error: null,
      },
    });

    if (result.count > 0) {
      console.log(`[TaskRecovery] Reset ${result.count} pending task(s) to queued`);
    }

    return result.count;
  }
}
