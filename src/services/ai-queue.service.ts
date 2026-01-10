import { AIProvider } from './ai.service';

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
 */
export class AIQueueService {
  private static instance: AIQueueService;
  private queue: QueuedRequest[] = [];
  private processing = false;

  // Track usage per provider using sliding window
  private usageWindows: Map<AIProvider, UsageWindow[]> = new Map();

  // Rate limit configurations per provider
  private rateLimits: Map<AIProvider, RateLimitConfig> = new Map();

  private constructor() {
    // Default rate limits (will be overridden by database settings)
    this.setDefaultRateLimits();

    // Start processing queue
    this.startProcessing();
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
   * Add a request to the queue
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

      this.queue.push(request);
      console.log(`[AIQueue] Enqueued request ${request.id} for task ${taskId}. Queue size: ${this.queue.length}`);

      // Update task queue position in database
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
      console.warn(`[AIQueue] No rate limits configured for provider: ${provider}`);
      return true;
    }

    const usage = this.getCurrentUsage(provider);

    const canExecute =
      usage.tokens + estimatedTokens <= limits.maxTokensPerMinute &&
      usage.requests + 1 <= limits.maxRequestsPerMinute;

    if (!canExecute) {
      console.log(
        `[AIQueue] Rate limit check for ${provider}: ` +
        `tokens ${usage.tokens + estimatedTokens}/${limits.maxTokensPerMinute}, ` +
        `requests ${usage.requests + 1}/${limits.maxRequestsPerMinute}`
      );
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
   * Process the queue
   */
  private async startProcessing() {
    setInterval(async () => {
      if (this.processing || this.queue.length === 0) return;

      this.processing = true;

      try {
        // Find the first request that can be executed
        const index = this.queue.findIndex(req =>
          this.canExecute(req.provider, req.estimatedTokens)
        );

        if (index === -1) {
          // No request can be executed right now
          const firstRequest = this.queue[0];
          if (firstRequest) {
            const waitTime = this.calculateWaitTime(
              firstRequest.provider,
              firstRequest.estimatedTokens
            );
            console.log(
              `[AIQueue] Waiting ${waitTime}ms before next execution. ` +
              `Queue size: ${this.queue.length}`
            );
          }
          return;
        }

        // Remove request from queue
        const [request] = this.queue.splice(index, 1);

        console.log(
          `[AIQueue] Executing request ${request.id} for task ${request.taskId}. ` +
          `Remaining in queue: ${this.queue.length}`
        );

        // Update task status to running
        await this.updateTaskStatus(request.shop, request.taskId, 'running');

        try {
          // Execute the request
          const result = await request.execute();

          // Record usage
          this.recordUsage(request.provider, request.estimatedTokens);

          // Resolve the promise
          request.resolve(result);

          console.log(`[AIQueue] Successfully executed request ${request.id}`);
        } catch (error: any) {
          console.error(`[AIQueue] Error executing request ${request.id}:`, error);

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

            console.log(
              `[AIQueue] Rate limit hit. Retrying request ${request.id} ` +
              `(attempt ${request.retryCount}/3) after ${backoffTime}ms`
            );

            // Update retry count in database
            await this.updateTaskRetryCount(request.shop, request.taskId, request.retryCount);

            // Re-queue the request
            setTimeout(() => {
              this.queue.unshift(request);
            }, backoffTime);
          } else {
            // Reject the promise
            request.reject(error);
          }
        }

        // Update queue positions for remaining tasks
        await this.updateQueuePositions(request.shop);
      } finally {
        this.processing = false;
      }
    }, 100); // Check every 100ms
  }

  /**
   * Update queue positions in database
   */
  private async updateQueuePositions(shop: string) {
    try {
      const { db } = await import('../../app/db.server');

      // Update positions for tasks in queue
      const updates = this.queue.map((req, index) =>
        db.task.update({
          where: { id: req.taskId },
          data: {
            queuePosition: index + 1,
            status: 'queued',
          },
        })
      );

      await Promise.all(updates);
    } catch (error) {
      console.error('[AIQueue] Error updating queue positions:', error);
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
      console.error('[AIQueue] Error updating task status:', error);
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
      console.error('[AIQueue] Error updating retry count:', error);
    }
  }

  /**
   * Get queue statistics
   */
  getQueueStats(shop?: string): {
    queueLength: number;
    byProvider: Record<AIProvider, number>;
    byShop: Record<string, number>;
  } {
    const stats = {
      queueLength: this.queue.length,
      byProvider: {} as Record<AIProvider, number>,
      byShop: {} as Record<string, number>,
    };

    for (const request of this.queue) {
      // Count by provider
      stats.byProvider[request.provider] = (stats.byProvider[request.provider] || 0) + 1;

      // Count by shop
      stats.byShop[request.shop] = (stats.byShop[request.shop] || 0) + 1;
    }

    return stats;
  }
}
