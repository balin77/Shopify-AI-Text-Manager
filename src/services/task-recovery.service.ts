/**
 * Task Recovery Service
 * Recovers pending/queued tasks after server restart
 */

import { AIQueueService } from './ai-queue.service';
import { loggers } from '../../app/utils/logger.server';
import type { AIProvider } from './ai-queue.service';

// Task type from Prisma
interface Task {
  id: string;
  shop: string;
  type: string;
  status: string;
  resourceType: string | null;
  resourceId: string | null;
  resourceTitle: string | null;
  fieldType: string | null;
  targetLocale: string | null;
  prompt: string | null;
  provider: string | null;
  retryCount: number;
  estimatedTokens: number | null;
  updatedAt: Date;
}

// AISettings type
interface AISettings {
  huggingfaceApiKey?: string | null;
  geminiApiKey?: string | null;
  claudeApiKey?: string | null;
  openaiApiKey?: string | null;
  grokApiKey?: string | null;
  deepseekApiKey?: string | null;
}

// Timeout for stuck tasks (10 minutes). Applies to actively-progressing
// states only (running/pending) — a task that hasn't progressed in 10 min
// is genuinely stuck.
const STUCK_TASK_TIMEOUT_MS = 10 * 60 * 1000;

// `queued` tasks are waiting for an AI-queue slot BY DESIGN. Under load (or a
// provider-wide rate-limit backoff) they can legitimately sit for far longer
// than 10 min, so the short threshold above must NOT fail them — that was
// killing valid work. They still get a much longer hard safety cap so a truly
// abandoned/orphaned queued task is eventually cleaned up.
const QUEUED_TASK_HARD_CAP_MS = 6 * 60 * 60 * 1000; // 6 hours

// Check for stuck tasks every 2 minutes
const STUCK_CHECK_INTERVAL_MS = 2 * 60 * 1000;

export class TaskRecoveryService {
  private static instance: TaskRecoveryService;
  private stuckCheckInterval: NodeJS.Timeout | null = null;

  private constructor() {}

  static getInstance(): TaskRecoveryService {
    if (!TaskRecoveryService.instance) {
      TaskRecoveryService.instance = new TaskRecoveryService();
    }
    return TaskRecoveryService.instance;
  }

  /**
   * Start periodic check for stuck tasks
   * This should be called once at server startup after initial recovery
   */
  startStuckTaskMonitoring(): void {
    if (this.stuckCheckInterval) {
      loggers.queue('info', 'Stuck task monitoring already running');
      return;
    }

    loggers.queue('info', 'Starting stuck task monitoring (every 2 minutes)');

    this.stuckCheckInterval = setInterval(async () => {
      try {
        const stuckCount = await this.markStuckTasksAsFailed();
        if (stuckCount > 0) {
          loggers.queue('info', `Periodic check: marked ${stuckCount} stuck task(s) as failed`);
        }
      } catch (error) {
        loggers.queue('error', 'Error during stuck task check', { error: error instanceof Error ? error.message : String(error) });
      }
    }, STUCK_CHECK_INTERVAL_MS);
  }

  /**
   * Stop the stuck task monitoring
   */
  stopStuckTaskMonitoring(): void {
    if (this.stuckCheckInterval) {
      clearInterval(this.stuckCheckInterval);
      this.stuckCheckInterval = null;
      loggers.queue('info', 'Stopped stuck task monitoring');
    }
  }

  /**
   * Recover all pending tasks after server restart
   * Called once at server startup
   */
  async recoverPendingTasks(): Promise<{ recovered: number; failed: number }> {
    const { db } = await import('../../app/db.server');

    loggers.queue('info', 'Starting task recovery...');

    // First, mark stuck tasks as failed
    const stuckCount = await this.markStuckTasksAsFailed();

    // Find all recoverable tasks
    const recoverableTasks = await db.task.findMany({
      where: {
        status: { in: ['queued', 'pending'] },
        prompt: { not: null },
        provider: { not: null },
        expiresAt: { gt: new Date() }, // Not expired
      },
      orderBy: { createdAt: 'asc' }, // Process oldest first
    });

    loggers.queue('info', `Found ${recoverableTasks.length} tasks to recover`);

    let recovered = 0;
    let failed = stuckCount;

    for (const task of recoverableTasks) {
      try {
        const success = await this.recoverTask(task as Task);
        if (success) {
          recovered++;
          loggers.queue('info', `Recovered task ${task.id} (${task.type})`);
        } else {
          failed++;
          loggers.queue('warn', `Could not recover task ${task.id} - missing data`);
        }
      } catch (error) {
        failed++;
        loggers.queue('error', `Failed to recover task ${task.id}`, { error: error instanceof Error ? error.message : String(error) });

        // Mark as failed in database
        await db.task.update({
          where: { id: task.id },
          data: {
            status: 'failed',
            error: `Recovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            completedAt: new Date(),
          },
        });
      }
    }

    loggers.queue('info', `Recovery complete: ${recovered} recovered, ${failed} failed/stuck`);

    return { recovered, failed };
  }

  /**
   * Mark tasks stuck in "running" or "pending" status as failed
   * A task is considered stuck if it's been running/pending for more than 10 minutes without update
   *
   * R4-DI9 — known, ACCEPTED reaper↔finalizer interaction (LOW, not fixed):
   * app-wide task finalizers use `task.update({ where: { id } })` with no
   * status precondition, so a slow task reaped here can later be flipped
   * back by its own finalizer ("lost transition"). Left as-is: it is
   * observability-only — task side effects are status-independent and
   * idempotent, so nothing is lost/duplicated; only the final status label
   * can thrash for one >10-min task. A status-precondition sweep over ~100
   * update sites is disproportionate/risky for a cosmetic edge. If a
   * stricter, authoritative reaper is ever introduced, make finalizers
   * monotonic via `updateMany({ where:{ id, status:{ notIn: TERMINAL } } })`
   * (mirror note in task-recovery.service.js).
   */
  async markStuckTasksAsFailed(): Promise<number> {
    const { db } = await import('../../app/db.server');

    const now = Date.now();
    const stuckThreshold = new Date(now - STUCK_TASK_TIMEOUT_MS);
    const queuedHardCap = new Date(now - QUEUED_TASK_HARD_CAP_MS);

    // running/pending: short stuck threshold (no progress = genuinely stuck).
    const stuckResult = await db.task.updateMany({
      where: {
        status: { in: ['running', 'pending'] },
        updatedAt: { lt: stuckThreshold },
      },
      data: {
        status: 'failed',
        error: 'Task timed out - no progress for more than 10 minutes',
        completedAt: new Date(),
      },
    });

    // queued: only the long hard cap — legitimate waits are NOT failed.
    const queuedResult = await db.task.updateMany({
      where: {
        status: 'queued',
        updatedAt: { lt: queuedHardCap },
      },
      data: {
        status: 'failed',
        error: 'Task abandoned - queued for more than 6 hours',
        completedAt: new Date(),
      },
    });

    const total = stuckResult.count + queuedResult.count;
    if (total > 0) {
      loggers.queue('info', `Marked ${total} stuck task(s) as failed (running/pending: ${stuckResult.count}, queued>6h: ${queuedResult.count})`);
    }

    return total;
  }

  /**
   * Recover a single task by re-enqueueing it
   */
  private async recoverTask(task: Task): Promise<boolean> {
    const { db } = await import('../../app/db.server');

    // Validate required fields
    if (!task.prompt || !task.provider) {
      return false;
    }

    // Get AI settings for this shop
    const aiSettings = await db.aISettings.findUnique({
      where: { shop: task.shop },
    });

    if (!aiSettings) {
      loggers.queue('warn', `No AI settings found for shop ${task.shop}`);
      return false;
    }

    // Validate that the provider has an API key configured
    const provider = task.provider as AIProvider;
    if (!this.hasProviderApiKey(provider, aiSettings)) {
      loggers.queue('warn', `No API key for provider ${provider} in shop ${task.shop}`);
      return false;
    }

    // Get the queue service
    const queue = AIQueueService.getInstance();

    // Convert Prisma settings (null) to AIServiceConfig (undefined)
    const serviceConfig = {
      huggingfaceApiKey: aiSettings.huggingfaceApiKey ?? undefined,
      geminiApiKey: aiSettings.geminiApiKey ?? undefined,
      claudeApiKey: aiSettings.claudeApiKey ?? undefined,
      openaiApiKey: aiSettings.openaiApiKey ?? undefined,
      grokApiKey: aiSettings.grokApiKey ?? undefined,
      deepseekApiKey: aiSettings.deepseekApiKey ?? undefined,
    };

    // Update queue rate limits from settings
    await queue.updateRateLimits(aiSettings);

    // Parse the prompt to extract the actual prompt text
    // Task prompts may be stored as JSON arrays from batch operations
    let actualPrompt = task.prompt!;
    try {
      const parsed = JSON.parse(task.prompt!);
      if (Array.isArray(parsed) && parsed.length > 0) {
        actualPrompt = parsed[parsed.length - 1].prompt || task.prompt!;
      }
    } catch {
      // If parsing fails, use the raw prompt as-is
    }

    // Re-enqueue the task (prompt and provider are guaranteed non-null by the check above)
    await queue.enqueueFromTask({
      ...task,
      prompt: actualPrompt, // Use parsed prompt instead of raw task.prompt
      provider: task.provider!, // Non-null assertion safe due to check on line 144
    }, serviceConfig);

    return true;
  }

  /**
   * Check if a provider has a valid API key configured
   */
  private hasProviderApiKey(provider: AIProvider, settings: AISettings): boolean {
    switch (provider) {
      case 'huggingface':
        return !!settings.huggingfaceApiKey;
      case 'gemini':
        return !!settings.geminiApiKey;
      case 'claude':
        return !!settings.claudeApiKey;
      case 'openai':
        return !!settings.openaiApiKey;
      case 'grok':
        return !!settings.grokApiKey;
      case 'deepseek':
        return !!settings.deepseekApiKey;
      default:
        return false;
    }
  }
}
