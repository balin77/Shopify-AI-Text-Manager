/**
 * Task Recovery Service
 * Recovers pending/queued tasks after server restart
 */

import { AIQueueService } from './ai-queue.service';
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

// Timeout for stuck tasks (10 minutes)
const STUCK_TASK_TIMEOUT_MS = 10 * 60 * 1000;

export class TaskRecoveryService {
  private static instance: TaskRecoveryService;

  private constructor() {}

  static getInstance(): TaskRecoveryService {
    if (!TaskRecoveryService.instance) {
      TaskRecoveryService.instance = new TaskRecoveryService();
    }
    return TaskRecoveryService.instance;
  }

  /**
   * Recover all pending tasks after server restart
   * Called once at server startup
   */
  async recoverPendingTasks(): Promise<{ recovered: number; failed: number }> {
    const { db } = await import('../../app/db.server');

    console.log('[TaskRecovery] Starting task recovery...');

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

    console.log(`[TaskRecovery] Found ${recoverableTasks.length} tasks to recover`);

    let recovered = 0;
    let failed = stuckCount;

    for (const task of recoverableTasks) {
      try {
        const success = await this.recoverTask(task as Task);
        if (success) {
          recovered++;
          console.log(`[TaskRecovery] Recovered task ${task.id} (${task.type})`);
        } else {
          failed++;
          console.log(`[TaskRecovery] Could not recover task ${task.id} - missing data`);
        }
      } catch (error) {
        failed++;
        console.error(`[TaskRecovery] Failed to recover task ${task.id}:`, error);

        // Mark as failed in database
        await db.task.update({
          where: { id: task.id },
          data: {
            status: 'failed',
            error: `Recovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        });
      }
    }

    console.log(`[TaskRecovery] Recovery complete: ${recovered} recovered, ${failed} failed/stuck`);

    return { recovered, failed };
  }

  /**
   * Mark tasks stuck in "running" status as failed
   * A task is considered stuck if it's been running for more than 10 minutes
   */
  private async markStuckTasksAsFailed(): Promise<number> {
    const { db } = await import('../../app/db.server');

    const stuckThreshold = new Date(Date.now() - STUCK_TASK_TIMEOUT_MS);

    const result = await db.task.updateMany({
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
      console.warn(`[TaskRecovery] No AI settings found for shop ${task.shop}`);
      return false;
    }

    // Validate that the provider has an API key configured
    const provider = task.provider as AIProvider;
    if (!this.hasProviderApiKey(provider, aiSettings)) {
      console.warn(`[TaskRecovery] No API key for provider ${provider} in shop ${task.shop}`);
      return false;
    }

    // Get the queue service
    const queue = AIQueueService.getInstance();

    // Update queue rate limits from settings
    await queue.updateRateLimits(aiSettings);

    // Re-enqueue the task
    await queue.enqueueFromTask(task, aiSettings);

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
