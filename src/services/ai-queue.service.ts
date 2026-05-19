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

  // Number of provider calls currently executing. Previously a single
  // `processing` boolean serialized the ENTIRE service to 1 in-flight request
  // globally, so one slow shop blocked every other shop.
  private inFlight = 0;
  // Max provider calls in flight at once, prozessweit über alle Shops.
  // Configurable via the AI_QUEUE_CONCURRENCY env var (Railway etc.);
  // defaults to 4 and is clamped to a sane 1..32 range. Invalid/missing
  // values fall back to the default.
  private static readonly MAX_GLOBAL_CONCURRENCY = AIQueueService.resolveConcurrency();

  private static resolveConcurrency(): number {
    const DEFAULT = 4;
    const MIN = 1;
    const MAX = 32;
    const raw = process.env.AI_QUEUE_CONCURRENCY;
    if (!raw) return DEFAULT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < MIN || parsed > MAX) {
      loggers.queue('warn', `Invalid AI_QUEUE_CONCURRENCY="${raw}" — falling back to ${DEFAULT} (allowed: integer ${MIN}–${MAX})`);
      return DEFAULT;
    }
    return parsed;
  }

  // Hard per-shop queue depth cap (env-configurable). MAX_GLOBAL_CONCURRENCY
  // only bounds how many requests EXECUTE at once, not how many a tenant can
  // stack up waiting — without this cap one shop can grow memory unboundedly
  // (N-H2). Default 1000.
  private readonly maxQueuePerShop: number = (() => {
    const raw = Number(process.env.AI_QUEUE_MAX_PER_SHOP);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1000;
  })();

  // Re-entrancy guard for the scheduler tick only (not the executions).
  private scheduling = false;

  // Shutdown coordination (H2): stop dispatching, drain in-flight work, and
  // cancel pending retry timers so SIGTERM doesn't strand running tasks or
  // write to a disconnected Prisma client.
  private shuttingDown = false;
  private pollTimer?: NodeJS.Timeout;
  private readonly retryTimers: Set<NodeJS.Timeout> = new Set();

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
      // Expose the live singleton process-wide so the custom server's
      // graceful-shutdown handler (server.js, outside the Remix bundle's
      // module graph) can stop/drain THIS instance. Mirrors globalThis.__db.
      (globalThis as { __aiQueue?: AIQueueService }).__aiQueue = AIQueueService.instance;
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
    if (!settings) return;
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

      // Bounded queue (N-H2): reject instead of growing memory without limit.
      if (shopQueue.length >= this.maxQueuePerShop) {
        loggers.queue('warn', `Queue full for shop ${shop} (${shopQueue.length}/${this.maxQueuePerShop}) — rejecting request for task ${taskId}`);
        reject(new Error(`AI queue is full for this shop (max ${this.maxQueuePerShop} pending requests). Please retry later.`));
        return;
      }

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
  private calculateWaitTime(provider?: AIProvider, estimatedTokens?: number): number {
    // If no provider specified, find the minimum wait time across all providers with active windows
    if (!provider) {
      let minWait = Infinity;
      for (const [p, windows] of this.usageWindows.entries()) {
        if (windows.length > 0) {
          const wait = this.calculateWaitTime(p, 0);
          if (wait < minWait) minWait = wait;
        }
      }
      return minWait === Infinity ? 0 : minWait;
    }

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
    const tick = () => {
      if (this.shuttingDown) return;

      // The ENTIRE body is guarded so a synchronous throw from
      // getNextExecutableRequest()/getTotalQueueLength() can never propagate
      // past the re-arm line and kill the poller, leaving every enqueue()
      // promise hanging forever (N-H1). The timer is re-armed exactly once,
      // on every exit path except shutdown.
      try {
        // Re-entrancy guard: only the dispatch loop is guarded, NOT the
        // executions themselves (those run concurrently up to the cap).
        if (!this.scheduling) {
          this.scheduling = true;
          try {
            while (
              this.inFlight < AIQueueService.MAX_GLOBAL_CONCURRENCY &&
              this.getTotalQueueLength() > 0
            ) {
              const next = this.getNextExecutableRequest();
              if (!next) break; // nothing executable right now (rate limited)

              const { shop, request, index } = next;
              const shopQueue = this.queues.get(shop)!;
              shopQueue.splice(index, 1);
              if (shopQueue.length === 0) this.queues.delete(shop);

              this.inFlight++;
              // Fire-and-forget: do NOT await here, so multiple requests run
              // concurrently. inFlight is decremented in runRequest's finally.
              void this.runRequest(shop, request);
            }
          } finally {
            this.scheduling = false;
          }
        }
      } catch (error) {
        loggers.queue('error', 'Queue scheduler tick crashed — recovering', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!this.shuttingDown) {
          let interval = 1000;
          try {
            interval = this.getTotalQueueLength() === 0 ? 1000 : 100;
          } catch {
            // Never let interval computation prevent re-arming the poller.
          }
          this.pollTimer = setTimeout(tick, interval);
        }
      }
    };

    tick();
    loggers.queue('info', `Started adaptive queue processing (concurrency ${AIQueueService.MAX_GLOBAL_CONCURRENCY}, 100ms active / 1s idle)`);
  }

  /**
   * Execute a single dequeued request. Runs concurrently with other requests
   * (bounded by MAX_GLOBAL_CONCURRENCY). Always decrements inFlight.
   */
  private async runRequest(shop: string, request: QueuedRequest): Promise<void> {
    try {
      loggers.queue('debug', `Executing request ${request.id} for shop ${shop}, task ${request.taskId}`, { inFlight: this.inFlight, totalQueueSize: this.getTotalQueueLength() });

      await this.updateTaskStatus(shop, request.taskId, 'running');

      try {
        const result = await request.execute();
        request.resolve(result);
        loggers.queue('debug', `Successfully executed request ${request.id}`);
      } catch (error: any) {
        loggers.queue('error', `Error executing request ${request.id}`, { error: error?.message || String(error) });

        const isRateLimitError =
          error.message?.includes('rate limit') ||
          error.message?.includes('quota') ||
          error.message?.includes('429') ||
          error.status === 429;

        // Don't re-enqueue during shutdown — reject so the caller settles and
        // the task is not left dangling against a closing DB client.
        if (isRateLimitError && request.retryCount < 3 && !this.shuttingDown) {
          request.retryCount++;
          // Exponential backoff WITH jitter (H7): without jitter, a
          // provider-wide 429 makes every shop retry in lock-step and
          // stampede the provider again at the same instant.
          const base = Math.pow(2, request.retryCount) * 1000;
          const jitter = Math.floor(Math.random() * 1000);
          const backoffTime = base + jitter;

          loggers.queue('warn', `Rate limit hit. Retrying request ${request.id}`, { attempt: request.retryCount, maxAttempts: 3, backoffMs: backoffTime });

          await this.updateTaskRetryCount(shop, request.taskId, request.retryCount);

          const retryTimer = setTimeout(() => {
            this.retryTimers.delete(retryTimer);
            if (this.shuttingDown) {
              request.reject(error);
              return;
            }
            const queue = this.getShopQueue(shop);
            queue.unshift(request);
          }, backoffTime);
          this.retryTimers.add(retryTimer);
        } else {
          request.reject(error);
        }
      } finally {
        // Record provider usage for EVERY attempt that reached the provider,
        // success or failure. Counting only successes under-reports the
        // sliding window and triggers 429 storms precisely when the provider
        // is already failing/timing out (N-H8).
        this.recordUsage(request.provider, request.estimatedTokens);
      }

      await this.updateQueuePositions(shop);
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Stop dispatching and cancel timers. Idempotent. Call before drain().
   */
  public stop(): void {
    this.shuttingDown = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.stopCleanup();
    loggers.queue('info', 'AI queue stopped (no new dispatch; pending retries cancelled)');
  }

  /**
   * Wait until all in-flight provider calls settle, or until timeoutMs.
   * Queued-but-not-started requests are rejected so their callers settle.
   */
  public async drain(timeoutMs = 8000): Promise<void> {
    // Reject everything still waiting in the queues — it never started.
    for (const [shop, queue] of this.queues.entries()) {
      for (const req of queue.splice(0)) {
        req.reject(new Error('Server shutting down — request not processed'));
      }
      this.queues.delete(shop);
    }

    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    loggers.queue('info', `AI queue drained (inFlight=${this.inFlight} after ${Date.now() - start}ms)`);
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
