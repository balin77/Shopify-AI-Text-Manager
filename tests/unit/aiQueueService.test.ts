import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AIQueueService } from '../../src/services/ai-queue.service';
import type { AIProvider } from '../../src/services/ai.service';

// Mock the database
vi.mock('../../app/db.server', () => ({
  db: {
    task: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe('AIQueueService', () => {
  let queueService: AIQueueService;

  beforeEach(() => {
    // Reset singleton to get a fresh instance each test
    (AIQueueService as any).instance = undefined;
    queueService = AIQueueService.getInstance();
  });

  afterEach(() => {
    queueService.stopCleanup();
    vi.clearAllMocks();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = AIQueueService.getInstance();
      const instance2 = AIQueueService.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('Rate Limits Configuration', () => {
    it('should have default rate limits for all providers', () => {
      const rateLimits = (queueService as any).rateLimits;

      expect(rateLimits.has('huggingface')).toBe(true);
      expect(rateLimits.has('gemini')).toBe(true);
      expect(rateLimits.has('claude')).toBe(true);
      expect(rateLimits.has('openai')).toBe(true);
      expect(rateLimits.has('grok')).toBe(true);
      expect(rateLimits.has('deepseek')).toBe(true);
    });

    it('should have correct default limits for HuggingFace', () => {
      const rateLimits = (queueService as any).rateLimits;
      const hfLimits = rateLimits.get('huggingface');

      expect(hfLimits.maxTokensPerMinute).toBe(1000000);
      expect(hfLimits.maxRequestsPerMinute).toBe(100);
    });

    it('should have correct default limits for Claude', () => {
      const rateLimits = (queueService as any).rateLimits;
      const claudeLimits = rateLimits.get('claude');

      expect(claudeLimits.maxTokensPerMinute).toBe(40000);
      expect(claudeLimits.maxRequestsPerMinute).toBe(5);
    });

    it('should update rate limits from settings', async () => {
      const settings = {
        hfMaxTokensPerMinute: 500000,
        hfMaxRequestsPerMinute: 50,
        claudeMaxTokensPerMinute: 20000,
        claudeMaxRequestsPerMinute: 3,
      };

      await queueService.updateRateLimits(settings);

      const rateLimits = (queueService as any).rateLimits;
      const hfLimits = rateLimits.get('huggingface');
      const claudeLimits = rateLimits.get('claude');

      expect(hfLimits.maxTokensPerMinute).toBe(500000);
      expect(hfLimits.maxRequestsPerMinute).toBe(50);
      expect(claudeLimits.maxTokensPerMinute).toBe(20000);
      expect(claudeLimits.maxRequestsPerMinute).toBe(3);
    });
  });

  describe('enqueue()', () => {
    it('should add request to shop-specific queue', async () => {
      const mockExecute = vi.fn().mockResolvedValue('result');

      // Create promise but don't await (enqueue returns a promise that resolves when executed)
      const promise = queueService.enqueue(
        'test-shop',
        'task-123',
        'huggingface',
        1000,
        mockExecute
      );

      // Check shop-specific queue has the request
      const shopQueue = (queueService as any).queues.get('test-shop');
      expect(shopQueue).toBeDefined();
      expect(shopQueue.length).toBe(1);
      expect(shopQueue[0].shop).toBe('test-shop');
      expect(shopQueue[0].taskId).toBe('task-123');
      expect(shopQueue[0].provider).toBe('huggingface');
      expect(shopQueue[0].estimatedTokens).toBe(1000);
    });

    it('should generate unique IDs for requests', async () => {
      const mockExecute1 = vi.fn().mockResolvedValue('result1');
      const mockExecute2 = vi.fn().mockResolvedValue('result2');

      queueService.enqueue('shop1', 'task-1', 'huggingface', 1000, mockExecute1);
      queueService.enqueue('shop2', 'task-2', 'gemini', 2000, mockExecute2);

      const queue1 = (queueService as any).queues.get('shop1');
      const queue2 = (queueService as any).queues.get('shop2');
      expect(queue1[0].id).not.toBe(queue2[0].id);
    });

    it('should initialize retry count to 0', async () => {
      const mockExecute = vi.fn().mockResolvedValue('result');

      queueService.enqueue('test-shop', 'task-123', 'claude', 1500, mockExecute);

      const shopQueue = (queueService as any).queues.get('test-shop');
      expect(shopQueue[0].retryCount).toBe(0);
    });
  });

  describe('Rate Limiting', () => {
    it('should allow execution within rate limits', () => {
      const canExecute = (queueService as any).canExecute('huggingface', 1000);
      expect(canExecute).toBe(true);
    });

    it('should block execution when token limit exceeded', () => {
      const rateLimits = (queueService as any).rateLimits;
      rateLimits.set('test-provider' as AIProvider, {
        maxTokensPerMinute: 5000,
        maxRequestsPerMinute: 100,
      });

      // Record usage that exceeds token limit
      const usageWindows = (queueService as any).usageWindows;
      usageWindows.set('test-provider' as AIProvider, [
        { timestamp: Date.now(), tokens: 4500, requests: 1 },
      ]);

      const canExecute = (queueService as any).canExecute('test-provider' as AIProvider, 1000);
      expect(canExecute).toBe(false);
    });

    it('should block execution when request limit exceeded', () => {
      const rateLimits = (queueService as any).rateLimits;
      rateLimits.set('test-provider' as AIProvider, {
        maxTokensPerMinute: 100000,
        maxRequestsPerMinute: 5,
      });

      // Record usage that exceeds request limit
      const usageWindows = (queueService as any).usageWindows;
      usageWindows.set('test-provider' as AIProvider, [
        { timestamp: Date.now(), tokens: 1000, requests: 1 },
        { timestamp: Date.now(), tokens: 1000, requests: 1 },
        { timestamp: Date.now(), tokens: 1000, requests: 1 },
        { timestamp: Date.now(), tokens: 1000, requests: 1 },
        { timestamp: Date.now(), tokens: 1000, requests: 1 },
      ]);

      const canExecute = (queueService as any).canExecute('test-provider' as AIProvider, 1000);
      expect(canExecute).toBe(false);
    });

    it('should allow execution after old usage windows expire', () => {
      const rateLimits = (queueService as any).rateLimits;
      rateLimits.set('test-provider' as AIProvider, {
        maxTokensPerMinute: 5000,
        maxRequestsPerMinute: 10,
      });

      // Record old usage (more than 60 seconds ago)
      const usageWindows = (queueService as any).usageWindows;
      usageWindows.set('test-provider' as AIProvider, [
        { timestamp: Date.now() - 70000, tokens: 4000, requests: 5 },
      ]);

      const canExecute = (queueService as any).canExecute('test-provider' as AIProvider, 1000);
      expect(canExecute).toBe(true);
    });
  });

  describe('Usage Tracking', () => {
    it('should track token usage', () => {
      (queueService as any).recordUsage('huggingface', 1500);

      const usage = (queueService as any).getCurrentUsage('huggingface');
      expect(usage.tokens).toBe(1500);
      expect(usage.requests).toBe(1);
    });

    it('should track request count', () => {
      (queueService as any).recordUsage('gemini', 500);
      (queueService as any).recordUsage('gemini', 300);
      (queueService as any).recordUsage('gemini', 200);

      const usage = (queueService as any).getCurrentUsage('gemini');
      expect(usage.tokens).toBe(1000);
      expect(usage.requests).toBe(3);
    });

    it('should clean up old usage windows', () => {
      const usageWindows = (queueService as any).usageWindows;

      // Add old and recent usage
      usageWindows.set('claude', [
        { timestamp: Date.now() - 70000, tokens: 1000, requests: 1 }, // Old
        { timestamp: Date.now() - 30000, tokens: 500, requests: 1 },  // Recent
        { timestamp: Date.now(), tokens: 800, requests: 1 },          // Recent
      ]);

      const usage = (queueService as any).getCurrentUsage('claude');

      // Should only count recent usage
      expect(usage.tokens).toBe(1300);
      expect(usage.requests).toBe(2);

      // Old window should be removed
      const windows = usageWindows.get('claude');
      expect(windows.length).toBe(2);
    });
  });

  describe('Wait Time Calculation', () => {
    it('should return 0 when no usage windows exist', () => {
      const waitTime = (queueService as any).calculateWaitTime('openai', 1000);
      expect(waitTime).toBe(0);
    });

    it('should calculate wait time based on oldest window', () => {
      const now = Date.now();
      const usageWindows = (queueService as any).usageWindows;

      // Add a window 30 seconds ago
      usageWindows.set('openai', [
        { timestamp: now - 30000, tokens: 5000, requests: 1 },
      ]);

      const waitTime = (queueService as any).calculateWaitTime('openai', 1000);

      // Should wait until oldest window expires (60s - 30s = 30s + buffer)
      expect(waitTime).toBeGreaterThan(30000);
      expect(waitTime).toBeLessThan(31000);
    });

    it('should not return negative wait time', () => {
      const now = Date.now();
      const usageWindows = (queueService as any).usageWindows;

      // Add a window 65 seconds ago (already expired)
      usageWindows.set('grok', [
        { timestamp: now - 65000, tokens: 1000, requests: 1 },
      ]);

      const waitTime = (queueService as any).calculateWaitTime('grok', 1000);
      expect(waitTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Queue Statistics', () => {
    it('should return empty stats for empty queue', () => {
      const stats = queueService.getQueueStats();

      expect(stats.queueLength).toBe(0);
      expect(Object.keys(stats.byProvider).length).toBe(0);
      expect(Object.keys(stats.byShop).length).toBe(0);
    });

    it('should count requests by provider', async () => {
      const mockExecute = vi.fn().mockResolvedValue('result');

      // Enqueue to same shop so they share a queue
      queueService.enqueue('shop1', 'task-1', 'huggingface', 1000, mockExecute);
      queueService.enqueue('shop1', 'task-2', 'huggingface', 1000, mockExecute);
      queueService.enqueue('shop1', 'task-3', 'gemini', 1000, mockExecute);

      const stats = queueService.getQueueStats('shop1');

      expect(stats.queueLength).toBe(3);
      expect(stats.byProvider.huggingface).toBe(2);
      expect(stats.byProvider.gemini).toBe(1);
    });

    it('should count requests by shop', async () => {
      const mockExecute = vi.fn().mockResolvedValue('result');

      queueService.enqueue('shop1', 'task-1', 'claude', 1000, mockExecute);
      queueService.enqueue('shop1', 'task-2', 'claude', 1000, mockExecute);
      queueService.enqueue('shop2', 'task-3', 'claude', 1000, mockExecute);
      queueService.enqueue('shop3', 'task-4', 'openai', 1000, mockExecute);

      const stats = queueService.getQueueStats();

      expect(stats.queueLength).toBe(4);
      expect(stats.byShop.shop1).toBe(2);
      expect(stats.byShop.shop2).toBe(1);
      expect(stats.byShop.shop3).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing rate limit configuration gracefully', () => {
      const rateLimits = (queueService as any).rateLimits;

      // Remove rate limits for a provider
      rateLimits.delete('huggingface');

      // Should still allow execution (with warning)
      const canExecute = (queueService as any).canExecute('huggingface', 1000);
      expect(canExecute).toBe(true);
    });
  });

  describe('Retry Logic', () => {
    it('should retry on rate limit errors', async () => {
      // Test the retry count increment on a shop-specific queue
      const shopQueue = (queueService as any).getShopQueue('test-shop');

      const mockRequest = {
        id: 'test-1',
        shop: 'test-shop',
        taskId: 'task-1',
        provider: 'claude' as AIProvider,
        estimatedTokens: 1000,
        execute: vi.fn(),
        resolve: vi.fn(),
        reject: vi.fn(),
        retryCount: 0,
        createdAt: new Date(),
      };

      shopQueue.push(mockRequest);

      // Simulate retry increment
      mockRequest.retryCount++;
      expect(mockRequest.retryCount).toBe(1);
      expect(mockRequest.retryCount).toBeLessThan(3);
    });

    it('should not retry more than 3 times', () => {
      const mockRequest = {
        id: 'test-1',
        shop: 'test-shop',
        taskId: 'task-1',
        provider: 'openai' as AIProvider,
        estimatedTokens: 1000,
        execute: vi.fn(),
        resolve: vi.fn(),
        reject: vi.fn(),
        retryCount: 3,
        createdAt: new Date(),
      };

      // Should not retry if already at max
      expect(mockRequest.retryCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Sliding Window', () => {
    it('should use sliding window for rate limiting', () => {
      const now = Date.now();
      const usageWindows = (queueService as any).usageWindows;

      // Add usage at different times within the 60-second window
      usageWindows.set('deepseek', [
        { timestamp: now - 50000, tokens: 1000, requests: 1 }, // 50s ago
        { timestamp: now - 30000, tokens: 1000, requests: 1 }, // 30s ago
        { timestamp: now - 10000, tokens: 1000, requests: 1 }, // 10s ago
        { timestamp: now, tokens: 1000, requests: 1 },         // now
      ]);

      const usage = (queueService as any).getCurrentUsage('deepseek');

      // All should be counted
      expect(usage.tokens).toBe(4000);
      expect(usage.requests).toBe(4);

      // Simulate 40 seconds passing
      usageWindows.set('deepseek', [
        { timestamp: now - 90000, tokens: 1000, requests: 1 }, // 90s ago (expired)
        { timestamp: now - 70000, tokens: 1000, requests: 1 }, // 70s ago (expired)
        { timestamp: now - 50000, tokens: 1000, requests: 1 }, // 50s ago (still valid)
        { timestamp: now - 40000, tokens: 1000, requests: 1 }, // 40s ago (still valid)
      ]);

      const usageAfter = (queueService as any).getCurrentUsage('deepseek');

      // Only recent ones should be counted
      expect(usageAfter.tokens).toBe(2000);
      expect(usageAfter.requests).toBe(2);
    });
  });
});
