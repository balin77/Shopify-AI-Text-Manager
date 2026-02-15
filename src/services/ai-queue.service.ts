import type { AIProvider, AIServiceConfig } from './ai.service';
import { loggers } from '../../app/utils/logger.server';

// Re-export AIProvider for use in other services
export type { AIProvider } from './ai.service';

interface RateLimitConfig {
  maxTokensPerMinute: number;
  maxRequestsPerMinute: number;
}

interface QueuedRequest {
  id: string;
  shop: string;
  taskId: string;
  provider: AIProvider;
  estimatedTokens: number;
  execute: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  retryCount: number;
  createdAt: Date;
}

interface UsageWindow {
  timestamp: number;
  tokens: number;
  requests: number;
}

/**
 * AI Queue Service
 * Manages all AI requests with rate limiting and retry logic
 *
 * MULTI-TENANT NOTE:
 * - Queues are SHOP-SPECIFIC: Each shop has its own queue
 * - Processing uses ROUND-ROBIN: Fair distribution across all shops
 * - Rate limits are GLOBAL per AI provider (shared API keys)
 *
 * This ensures no single shop can block others while still respecting
 * global rate limits from AI providers.
 */
export class AIQueueService {
  private static instance: AIQueueService;

  // Shop-specific queues: Map<shopDomain, QueuedRequest[]>
  private queues: Map<string, QueuedRequest[]> = new Map();
  private processing = false;

  // Round-robin tracking: which shop to process next
  private lastProcessedShopIndex = 0;

  // Track usage per provider using sliding window (global - shared API keys)
  private usageWindows: Map<AIProvider, UsageWindow[]> = new Map();

  // Rate limit configurations per provider (global)
  private rateLimits: Map<AIProvider, RateLimitConfig> = new Map();

  // Track last activity time per shop for cleanup (memory leak prevention)
  private lastShopActivity: Map<string, number> = new Map();

  // Cleanup interval ID
  private cleanupIntervalId?: NodeJS.Timeout;

  private constructor() {
    // Default rate limits (will be overridden by database settings)
    this.setDefaultRateLimits();

    // Start processing queue
    this.startProcessing();

    // Start cleanup interval (runs every hour to prevent memory leaks)
    this.startCleanupInterval();
  }

  static getInstance(): AIQueueService {
    if (!AIQueueService.instance) {
      AIQueueService.instance = new AIQueueService();
    }
    return AIQueueService.instance;
  }

  private setDefaultRateLimits() {
    this.rateLimits.set('huggingface', {
      maxTokensPerMinute: 1000000,
      maxRequestsPerMinute: 100,
    });
    this.rateLimits.set('gemini', {
      maxTokensPerMinute: 1000000,
      maxRequestsPerMinute: 15,
    });
    this.rateLimits.set('claude', {
      maxTokensPerMinute: 40000,
      maxRequestsPerMinute: 5,
    });
    this.rateLimits.set('openai', {
      maxTokensPerMinute: 200000,
      maxRequestsPerMinute: 500,
    });
    this.rateLimits.set('grok', {
      maxTokensPerMinute: 100000,
      maxRequestsPerMinute: 60,
    });
    this.rateLimits.set('deepseek', {
      maxTokensPerMinute: 100000,
      maxRequestsPerMinute: 60,
    });
  }

  /**
   * Update rate limits from database settings
   */
  async updateRateLimits(settings: any) {
    if (settings.hfMaxTokensPerMinute && settings.hfMaxRequestsPerMinute) {
      this.rateLimits.set('huggingface', {
        maxTokensPerMinute: settings.hfMaxTokensPerMinute,
        maxRequestsPerMinute: settings.hfMaxRequestsPerMinute,
      });
    }
    if (settings.geminiMaxTokensPerMinute && settings.geminiMaxRequestsPerMinute) {
      this.rateLimits.set('gemini', {
        maxTokensPerMinute: settings.geminiMaxTokensPerMinute,
        maxRequestsPerMinute: settings.geminiMaxRequestsPerMinute,
      });
    }
    if (settings.claudeMaxTokensPerMinute && settings.claudeMaxRequestsPerMinute) {
      this.rateLimits.set('claude', {
        maxTokensPerMinute: settings.claudeMaxTokensPerMinute,
        maxRequestsPerMinute: settings.claudeMaxRequestsPerMinute,
      });
    }
    if (settings.openaiMaxTokensPerMinute && settings.openaiMaxRequestsPerMinute) {
      this.rateLimits.set('openai', {
        maxTokensPerMinute: settings.openaiMaxTokensPerMinute,
        maxRequestsPerMinute: settings.openaiMaxRequestsPerMinute,
      });
    }
    if (settings.grokMaxTokensPerMinute && settings.grokMaxRequestsPerMinute) {
      this.rateLimits.set('grok', {
        maxTokensPerMinute: settings.grokMaxTokensPerMinute,
        maxRequestsPerMinute: settings.grokMaxRequestsPerMinute,
      });
    }
    if (settings.deepseekMaxTokensPerMinute && settings.deepseekMaxRequestsPerMinute) {
      this.rateLimits.set('deepseek', {
        maxTokensPerMinute: settings.deepseekMaxTokensPerMinute,
        maxRequestsPerMinute: settings.deepseekMaxRequestsPerMinute,
      });
    }
  }

  /**
   * Get or create a shop-specific queue
   */
  private getShopQueue(shop: string): QueuedRequest[] {
    let queue = this.queues.get(shop);
    if (!queue) {
      queue = [];
      this.queues.set(shop, queue);
    }
    // Update last activity timestamp for this shop
    this.lastShopActivity.set(shop, Date.now());
    return queue;
  }

  /**
   * Get total queue length across all shops
   */
  private getTotalQueueLength(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Add a request to the shop-specific queue
   */
  async enqueue<T>(
    shop: string,
    taskId: string,
    provider: AIProvider,
    estimatedTokens: number,
    execute: () => Promise<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const request: QueuedRequest = {
        id: `${Date.now()}-${Math.random()}`,
        shop,
        taskId,
        provider,
        estimatedTokens,
        execute,
        resolve,
        reject,
        retryCount: 0,
        createdAt: new Date(),
      };

      const shopQueue = this.getShopQueue(shop);
      shopQueue.push(request);
      loggers.queue('debug', `Enqueued request ${request.id} for shop ${shop}, task ${taskId}`, { shopQueueSize: shopQueue.length, totalQueueSize: this.getTotalQueueLength() });

      // Update task queue position in database (shop-specific)
      this.updateQueuePositions(shop);
    });
  }

  /**
   * Get current usage for a provider in the last minute
   */
  private getCurrentUsage(provider: AIProvider): { tokens: number; requests: number } {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    const windows = this.usageWindows.get(provider) || [];

    // Remove old windows
    const recentWindows = windows.filter(w => w.timestamp > oneMinuteAgo);
    this.usageWindows.set(provider, recentWindows);

    // Sum up usage
    const tokens = recentWindows.reduce((sum, w) => sum + w.tokens, 0);
    const requests = recentWindows.reduce((sum, w) => sum + w.requests, 0);

    return { tokens, requests };
  }

  /**
   * Record usage for a provider
   */
  private recordUsage(provider: AIProvider, tokens: number) {
    const windows = this.usageWindows.get(provider) || [];
    windows.push({
      timestamp: Date.now(),
      tokens,
      requests: 1,
    });
    this.usageWindows.set(provider, windows);
  }

  /**
   * Check if a request can be executed without exceeding rate limits
   */
  private canExecute(provider: AIProvider, estimatedTokens: number): boolean {
    const limits = this.rateLimits.get(provider);
    if (!limits) {
      loggers.queue('warn', `No rate limits configured for provider: ${provider}`);
      return true;
    }

    const usage = this.getCurrentUsage(provider);

    const canExecute =
      usage.tokens + estimatedTokens <= limits.maxTokensPerMinute &&
      usage.requests + 1 <= limits.maxRequestsPerMinute;

    if (!canExecute) {
      loggers.queue('debug', `Rate limit check for ${provider}`, { tokens: usage.tokens + estimatedTokens, maxTokens: limits.maxTokensPerMinute, requests: usage.requests + 1, maxRequests: limits.maxRequestsPerMinute });
    }

    return canExecute;
  }

  /**
   * Calculate wait time until rate limit allows execution
   */
  private calculateWaitTime(provider: AIProvider, estimatedTokens: number): number {
    const windows = this.usageWindows.get(provider) || [];
    if (windows.length === 0) return 0;

    const now = Date.now();
    const oldestWindow = windows[0];
    const timeUntilOldestExpires = 60000 - (now - oldestWindow.timestamp);

    return Math.max(0, timeUntilOldestExpires + 100); // Add 100ms buffer
  }

  /**
   * Get the next shop to process using round-robin
   * Returns null if no shop has executable requests
   */
  private getNextExecutableRequest(): { shop: string; request: QueuedRequest; index: number } | null {
    const shops = Array.from(this.queues.keys());
    if (shops.length === 0) return null;

    // Start from the next shop after the last processed one (round-robin)
    const startIndex = (this.lastProcessedShopIndex + 1) % shops.length;

    // Try each shop in round-robin order
    for (let i = 0; i < shops.length; i++) {
      const shopIndex = (startIndex + i) % shops.length;
      const shop = shops[shopIndex];
      const queue = this.queues.get(shop) || [];

      // Find first executable request in this shop's queue
      const requestIndex = queue.findIndex(req =>
        this.canExecute(req.provider, req.estimatedTokens)
      );

      if (requestIndex !== -1) {
        this.lastProcessedShopIndex = shopIndex;
        return { shop, request: queue[requestIndex], index: requestIndex };
      }
    }

    return null;
  }

  /**
   * Process queues with fair round-robin across shops
   * Uses adaptive polling: 100ms when queue has items, 1000ms when empty
   */
  private async startProcessing() {
    let pollingInterval = 1000; // Start with 1 second (empty queue)

    const processNext = async () => {
      if (this.processing) return;

      const totalLength = this.getTotalQueueLength();

      // Adaptive polling based on queue size
      if (totalLength === 0) {
        pollingInterval = 1000; // 1 second when queue is empty (save CPU)
      } else {
        pollingInterval = 100; // 100ms when queue has items (responsive)
      }

      // Skip if queue is empty
      if (totalLength === 0) {
        setTimeout(processNext, pollingInterval);
        return;
      }

      this.processing = true;

      try {
        // Find next executable request using round-robin
        const next = this.getNextExecutableRequest();

        if (!next) {
          // No request can be executed right now (rate limited)
          return;
        }

        const { shop, request, index } = next;
        const shopQueue = this.queues.get(shop)!;

        // Remove request from queue
        shopQueue.splice(index, 1);

        // Clean up empty queues
        if (shopQueue.length === 0) {
          this.queues.delete(shop);
        }

        loggers.queue('debug', `Executing request ${request.id} for shop ${shop}, task ${request.taskId}`, { shopQueueRemaining: shopQueue.length, totalQueueSize: this.getTotalQueueLength() });

        // Update task status to running
        await this.updateTaskStatus(shop, request.taskId, 'running');

        try {
          // Execute the request
          const result = await request.execute();

          // Record usage
          this.recordUsage(request.provider, request.estimatedTokens);

          // Resolve the promise
          request.resolve(result);

          loggers.queue('debug', `Successfully executed request ${request.id}`);
        } catch (error: any) {
          loggers.queue('error', `Error executing request ${request.id}`, { error: error?.message || String(error) });

          // Check if it's a rate limit error
          const isRateLimitError =
            error.message?.includes('rate limit') ||
            error.message?.includes('quota') ||
            error.message?.includes('429') ||
            error.status === 429;

          if (isRateLimitError && request.retryCount < 3) {
            // Retry with exponential backoff
            request.retryCount++;
            const backoffTime = Math.pow(2, request.retryCount) * 1000;

            loggers.queue('warn', `Rate limit hit. Retrying request ${request.id}`, { attempt: request.retryCount, maxAttempts: 3, backoffMs: backoffTime });

            // Update retry count in database
            await this.updateTaskRetryCount(shop, request.taskId, request.retryCount);

            // Re-queue the request to the front of the shop's queue
            setTimeout(() => {
              const queue = this.getShopQueue(shop);
              queue.unshift(request);
            }, backoffTime);
          } else {
            // Reject the promise
            request.reject(error);
          }
        }

        // Update queue positions for the affected shop
        await this.updateQueuePositions(shop);
      } finally {
        this.processing = false;
        // Schedule next iteration with adaptive interval
        setTimeout(processNext, pollingInterval);
      }
    };

    // Start processing
    processNext();
    loggers.queue('info', 'Started adaptive queue processing (100ms when active, 1s when idle)');
  }

  /**
   * Update queue positions in database for a specific shop
   */
  private async updateQueuePositions(shop: string) {
    try {
      const { db } = await import('../../app/db.server');

      const shopQueue = this.queues.get(shop) || [];

      // Update positions only for tasks in this shop's queue
      const updates = shopQueue.map((req, index) =>
        db.task.update({
          where: { id: req.taskId },
          data: {
            queuePosition: index + 1,
            status: 'queued',
          },
        })
      );

      // Use Promise.allSettled to handle partial failures gracefully
      const results = await Promise.allSettled(updates);

      // Log any failures but don't throw - queue positions are not critical
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        loggers.queue('error', `${failures.length}/${updates.length} queue position updates failed for shop ${shop}`);
        failures.forEach((failure, index) => {
          loggers.queue('error', `Update ${index} failed`, { reason: failure.reason });
        });
      }
    } catch (error) {
      loggers.queue('error', `Error updating queue positions for shop ${shop}`, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Update task status
   */
  private async updateTaskStatus(shop: string, taskId: string, status: string) {
    try {
      const { db } = await import('../../app/db.server');

      await db.task.update({
        where: { id: taskId },
        data: {
          status,
          queuePosition: status === 'running' ? null : undefined,
        },
      });
    } catch (error) {
      loggers.queue('error', 'Error updating task status', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Update task retry count
   */
  private async updateTaskRetryCount(shop: string, taskId: string, retryCount: number) {
    try {
      const { db } = await import('../../app/db.server');

      await db.task.update({
        where: { id: taskId },
        data: { retryCount },
      });
    } catch (error) {
      loggers.queue('error', 'Error updating retry count', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Re-enqueue a task from the database (for recovery after server restart)
   * Uses the stored prompt directly without creating a new AIService instance
   */
  async enqueueFromTask(
    task: {
      id: string;
      shop: string;
      prompt: string;
      provider: string;
      estimatedTokens: number | null;
      retryCount: number;
    },
    aiSettings: AIServiceConfig
  ): Promise<void> {
    const provider = task.provider as AIProvider;
    const estimatedTokens = task.estimatedTokens || 2500; // Default estimate

    // Import AIService dynamically to avoid circular dependency
    const { AIService } = await import('./ai.service');

    // Create a new AIService instance with the stored provider
    const aiService = new AIService(provider, aiSettings, task.shop, task.id);

    // Create the execute function that will re-run the AI request
    const execute = async () => {
      return aiService.replayRequest(task.prompt);
    };

    // Enqueue the task (fire and forget - result handling is done by the original caller)
    return new Promise((resolve, reject) => {
      const request: QueuedRequest = {
        id: `recovery-${Date.now()}-${Math.random()}`,
        shop: task.shop,
        taskId: task.id,
        provider,
        estimatedTokens,
        execute,
        resolve: (result) => {
          // Update task as completed
          this.completeRecoveredTask(task.id, result);
          resolve();
        },
        reject: (error) => {
          // Update task as failed
          this.failRecoveredTask(task.id, error);
          reject(error);
        },
        retryCount: task.retryCount,
        createdAt: new Date(),
      };

      const shopQueue = this.getShopQueue(task.shop);
      shopQueue.push(request);
      loggers.queue('info', `Re-enqueued recovered task ${task.id} for shop ${task.shop}`, { shopQueueSize: shopQueue.length, totalQueueSize: this.getTotalQueueLength() });

      // Update task queue position in database
      this.updateQueuePositions(task.shop);
    });
  }

  /**
   * Mark a recovered task as completed
   */
  private async completeRecoveredTask(taskId: string, result: any) {
    try {
      const { db } = await import('../../app/db.server');

      await db.task.update({
        where: { id: taskId },
        data: {
          status: 'completed',
          progress: 100,
          result: typeof result === 'string' ? result.substring(0, 500) : JSON.stringify(result).substring(0, 500),
          completedAt: new Date(),
        },
      });

      loggers.queue('info', `Recovered task ${taskId} completed successfully`);
    } catch (error) {
      loggers.queue('error', `Error completing recovered task ${taskId}`, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Mark a recovered task as failed
   */
  private async failRecoveredTask(taskId: string, error: any) {
    try {
      const { db } = await import('../../app/db.server');

      await db.task.update({
        where: { id: taskId },
        data: {
          status: 'failed',
          error: error?.message || 'Unknown error during recovery',
        },
      });

      loggers.queue('warn', `Recovered task ${taskId} failed`, { error: error?.message });
    } catch (dbError) {
      loggers.queue('error', `Error failing recovered task ${taskId}`, { error: dbError instanceof Error ? dbError.message : String(dbError) });
    }
  }

  /**
   * Get queue statistics
   * @param shop - If provided, returns stats for that specific shop only
   */
  getQueueStats(shop?: string): {
    queueLength: number;
    byProvider: Record<AIProvider, number>;
    byShop: Record<string, number>;
  } {
    const stats = {
      queueLength: 0,
      byProvider: {} as Record<AIProvider, number>,
      byShop: {} as Record<string, number>,
    };

    // If specific shop requested, only return that shop's stats
    if (shop) {
      const shopQueue = this.queues.get(shop) || [];
      stats.queueLength = shopQueue.length;
      stats.byShop[shop] = shopQueue.length;

      for (const request of shopQueue) {
        stats.byProvider[request.provider] = (stats.byProvider[request.provider] || 0) + 1;
      }

      return stats;
    }

    // Otherwise, aggregate across all shops
    for (const [shopDomain, queue] of this.queues.entries()) {
      stats.queueLength += queue.length;
      stats.byShop[shopDomain] = queue.length;

      for (const request of queue) {
        stats.byProvider[request.provider] = (stats.byProvider[request.provider] || 0) + 1;
      }
    }

    return stats;
  }

  /**
   * Start cleanup interval to prevent memory leaks from inactive shops
   * Runs every hour and removes empty queues for shops inactive for > 24 hours
   */
  private startCleanupInterval() {
    // Run cleanup every hour
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupInactiveShops();
    }, 60 * 60 * 1000); // 1 hour

    loggers.queue('info', 'Cleanup interval started (runs every hour)');
  }

  /**
   * Clean up queues for shops that have been inactive for more than 24 hours
   * This prevents memory leaks from accumulating shop entries
   */
  private cleanupInactiveShops() {
    const now = Date.now();
    const INACTIVE_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours
    let cleanedCount = 0;

    for (const [shop, lastActivity] of this.lastShopActivity.entries()) {
      const inactiveDuration = now - lastActivity;
      const queue = this.queues.get(shop);

      // Remove if inactive for > 24 hours AND queue is empty (or doesn't exist)
      if (inactiveDuration > INACTIVE_THRESHOLD && (!queue || queue.length === 0)) {
        this.queues.delete(shop);
        this.lastShopActivity.delete(shop);
        cleanedCount++;
        loggers.queue('info', `Cleaned up inactive shop: ${shop}`, { inactiveHours: Math.round(inactiveDuration / 1000 / 60 / 60) });
      }
    }

    if (cleanedCount > 0) {
      loggers.queue('info', `Cleanup complete: Removed ${cleanedCount} inactive shop(s)`, { remainingShops: this.queues.size });
    } else {
      loggers.queue('debug', 'Cleanup complete: No inactive shops to remove', { activeShops: this.queues.size });
    }
  }

  /**
   * Manually trigger cleanup (useful for testing or forced cleanup)
   */
  public forceCleanup() {
    this.cleanupInactiveShops();
  }

  /**
   * Stop cleanup interval (useful for testing or shutdown)
   */
  public stopCleanup() {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
      loggers.queue('info', 'Cleanup interval stopped');
    }
  }
}
