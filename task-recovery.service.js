/**
 * Task Recovery Service (Standalone)
 * Recovers pending/queued tasks after server restart
 * This file is imported directly by server.js and not processed by Remix build
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Timeout for stuck tasks (10 minutes)
const STUCK_TASK_TIMEOUT_MS = 10 * 60 * 1000;

export class TaskRecoveryService {
  static instance = null;

  constructor() {}

  static getInstance() {
    if (!TaskRecoveryService.instance) {
      TaskRecoveryService.instance = new TaskRecoveryService();
    }
    return TaskRecoveryService.instance;
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
   * Mark tasks stuck in "running" status as failed
   * A task is considered stuck if it's been running for more than 10 minutes
   */
  async markStuckTasksAsFailed() {
    const stuckThreshold = new Date(Date.now() - STUCK_TASK_TIMEOUT_MS);

    const result = await prisma.task.updateMany({
      where: {
        status: 'running',
        updatedAt: { lt: stuckThreshold },
      },
      data: {
        status: 'failed',
        error: 'Task was stuck in running state after server restart',
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
