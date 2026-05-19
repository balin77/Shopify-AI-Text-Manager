/**
 * Task Recovery Service (Standalone)
 * Recovers pending/queued tasks after server restart
 * This file is imported directly by server.js and not processed by Remix build
 */

import { PrismaClient } from "@prisma/client";
import { refundImageOperations } from "./image-op-refund.js";

// Reuse the global PrismaClient shared with the Remix app (db.server.ts)
// instead of creating a separate instance with its own connection pool.
const prisma = globalThis.__db ?? new PrismaClient();
if (!globalThis.__db) globalThis.__db = prisma;

// Timeout for stuck tasks (10 minutes)
const STUCK_TASK_TIMEOUT_MS = 10 * 60 * 1000;

// Check for stuck tasks every 5 minutes (configurable via env)
const STUCK_CHECK_INTERVAL_MS = parseInt(process.env.STUCK_CHECK_INTERVAL_MS || String(5 * 60 * 1000), 10);

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

    // Recover WebP tasks that were "running" when the server stopped, BEFORE
    // markStuckTasksAsFailed would blanket-fail them. Step boundaries inside
    // webp-processor.service.js processTask determine whether a partial run
    // is safe to retry or must be flagged for manual review.
    const webpRecovered = await this.recoverRunningWebpTasks();

    // Mark stuck tasks as failed
    const stuckCount = await this.markStuckTasksAsFailed();

    // Reset queued/pending tasks so they can be retried
    // Note: We don't auto-requeue them because that requires AI settings
    // which should be loaded in the context of a user request
    const resetCount = await this.resetPendingTasks();

    console.log(`[TaskRecovery] Recovery complete: ${resetCount} reset to queued, ${stuckCount} marked as failed, ${webpRecovered.retried} WebP retried, ${webpRecovered.failed} WebP flagged`);

    return { recovered: resetCount, failed: stuckCount, webpRetried: webpRecovered.retried, webpFailed: webpRecovered.failed };
  }

  /**
   * Recover WebP conversion tasks that were "running" at server stop.
   *
   * Step boundaries (progress field, set in webp-processor.service.js processTask):
   *   <70:   nothing changed on Shopify yet -> safe to retry (reset to pending)
   *   70-89: new WebP may already exist on Shopify -> retry would duplicate
   *   >=90:  old PNG already deleted on Shopify, only DB swap missing -> manual review
   *
   * retryCount is capped at 3 to prevent loops when the underlying source is broken.
   */
  async recoverRunningWebpTasks() {
    const tasks = await prisma.task.findMany({
      where: { type: 'imageWebpConversion', status: 'running' },
      select: { id: true, progress: true, retryCount: true, shop: true },
    });

    let retried = 0;
    let failed = 0;
    for (const t of tasks) {
      if ((t.progress ?? 0) < 70 && (t.retryCount ?? 0) < 3) {
        await prisma.task.update({
          where: { id: t.id },
          data: {
            status: 'pending',
            retryCount: { increment: 1 },
            error: null,
            progress: 0,
          },
        });
        retried++;
      } else {
        await prisma.task.update({
          where: { id: t.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            error: `Server restarted at progress ${t.progress ?? 0} — partial Shopify state, manual review needed`,
          },
        });
        failed++;
        // R3-C4: this task consumed an image op at batch creation but
        // produced no result. Refund it (the status:'running' query filter
        // means a re-run won't re-select/double-refund this now-'failed'
        // task). The retry branch above intentionally does NOT refund — it
        // will run again.
        await refundImageOperations(prisma, t.shop, 1);
      }
    }

    if (retried > 0 || failed > 0) {
      console.log(`[TaskRecovery] WebP running-task recovery: ${retried} retried, ${failed} flagged for review`);
    }

    return { retried, failed };
  }

  /**
   * Mark tasks stuck in "running" or "pending" status as failed
   * A task is considered stuck if it's been running/pending for more than 10 minutes without update
   */
  async markStuckTasksAsFailed() {
    const stuckThreshold = new Date(Date.now() - STUCK_TASK_TIMEOUT_MS);

    // R3-C4: the blanket updateMany below also fails stuck
    // imageWebpConversion tasks, each of which consumed an image op at batch
    // creation. Capture them FIRST (still non-terminal) so we can refund;
    // after the updateMany they're 'failed' and no longer match this filter,
    // so a later recovery pass cannot re-select and double-refund them.
    const stuckWebp = await prisma.task.findMany({
      where: {
        type: 'imageWebpConversion',
        status: { in: ['running', 'pending', 'queued'] },
        updatedAt: { lt: stuckThreshold },
      },
      select: { shop: true },
    });

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

    if (stuckWebp.length > 0) {
      const byShop = new Map();
      for (const t of stuckWebp) byShop.set(t.shop, (byShop.get(t.shop) ?? 0) + 1);
      for (const [shop, n] of byShop) {
        await refundImageOperations(prisma, shop, n);
      }
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
