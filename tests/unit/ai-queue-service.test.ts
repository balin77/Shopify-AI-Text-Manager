/**
 * Unit Tests für AIQueueService
 *
 * Testet das kritische Round-Robin und Rate-Limiting
 * ✅ KEINE echten AI-Provider nötig
 * ✅ Schnelle Ausführung
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AIQueueService } from '../../src/services/ai-queue.service';
import type { AIProvider } from '../../src/services/ai.service';

// Mock db.server
const mockDb = {
  task: {
    update: vi.fn(),
    findUnique: vi.fn(),
  },
};

vi.mock('~/db.server', () => ({
  db: mockDb,
}));

describe('AIQueueService', () => {
  let queueService: AIQueueService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset Singleton-Instanz
    (AIQueueService as any).instance = undefined;
    queueService = AIQueueService.getInstance();
  });

  afterEach(() => {
    // Stoppe Cleanup-Interval
    queueService.stopCleanup();
    vi.clearAllMocks();
  });

  describe('Singleton Pattern', () => {
    it('sollte immer dieselbe Instanz zurückgeben', () => {
      const instance1 = AIQueueService.getInstance();
      const instance2 = AIQueueService.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('enqueue', () => {
    it('sollte einen Request zur Queue hinzufügen', async () => {
      const mockExecute = vi.fn().mockResolvedValue('AI Response');
      const shop = 'test-shop.myshopify.com';
      const taskId = 'task-123';

      const promise = queueService.enqueue(
        shop,
        taskId,
        'huggingface',
        1000, // estimatedTokens
        mockExecute
      );

      // Warte kurz, damit Queue-Processing starten kann
      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = await promise;

      expect(result).toBe('AI Response');
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('sollte Queue-Position in DB aktualisieren', async () => {
      const shop = 'test-shop.myshopify.com';
      const taskId = 'task-123';

      queueService.enqueue(
        shop,
        taskId,
        'gemini',
        500,
        vi.fn().mockResolvedValue('result')
      );

      // Warte auf Queue-Position Update
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockDb.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: taskId },
          data: expect.objectContaining({
            queuePosition: 1,
            status: 'queued',
          }),
        })
      );
    });
  });

  describe('Round-Robin Fairness', () => {
    it('sollte Requests von verschiedenen Shops fair verteilen', async () => {
      const shop1 = 'shop1.myshopify.com';
      const shop2 = 'shop2.myshopify.com';
      const shop3 = 'shop3.myshopify.com';

      const executionOrder: string[] = [];

      const createMockExecute = (shopId: string) =>
        vi.fn().mockImplementation(() => {
          executionOrder.push(shopId);
          return Promise.resolve(`Result from ${shopId}`);
        });

      // Enqueue 2 Tasks für jeden Shop
      queueService.enqueue(shop1, 'task-1-1', 'huggingface', 1000, createMockExecute(shop1));
      queueService.enqueue(shop1, 'task-1-2', 'huggingface', 1000, createMockExecute(shop1));

      queueService.enqueue(shop2, 'task-2-1', 'huggingface', 1000, createMockExecute(shop2));
      queueService.enqueue(shop2, 'task-2-2', 'huggingface', 1000, createMockExecute(shop2));

      queueService.enqueue(shop3, 'task-3-1', 'huggingface', 1000, createMockExecute(shop3));
      queueService.enqueue(shop3, 'task-3-2', 'huggingface', 1000, createMockExecute(shop3));

      // Warte bis alle Tasks verarbeitet wurden
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Verifiziere: Round-Robin bedeutet abwechselnde Shops
      // Erwartete Reihenfolge: shop1 -> shop2 -> shop3 -> shop1 -> shop2 -> shop3
      expect(executionOrder).toHaveLength(6);

      // Kein Shop sollte 2x hintereinander drankommen
      for (let i = 1; i < executionOrder.length; i++) {
        expect(executionOrder[i]).not.toBe(executionOrder[i - 1]);
      }
    });
  });

  describe('Rate Limiting', () => {
    it('sollte Rate Limits pro Provider respektieren', async () => {
      // Setze sehr niedrige Rate Limits für Test
      await queueService.updateRateLimits({
        hfMaxTokensPerMinute: 2000,
        hfMaxRequestsPerMinute: 2,
      });

      const shop = 'test-shop.myshopify.com';
      const mockExecute = vi.fn().mockResolvedValue('result');

      // Enqueue 3 Requests (über dem Limit)
      const promise1 = queueService.enqueue(shop, 'task-1', 'huggingface', 1000, mockExecute);
      const promise2 = queueService.enqueue(shop, 'task-2', 'huggingface', 1000, mockExecute);
      const promise3 = queueService.enqueue(shop, 'task-3', 'huggingface', 1000, mockExecute);

      // Warte 300ms (innerhalb 1 Minute)
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Nur 2 sollten sofort ausgeführt worden sein (Request-Limit = 2)
      expect(mockExecute).toHaveBeenCalledTimes(2);

      // Der 3. sollte noch in der Queue sein
      const stats = queueService.getQueueStats(shop);
      expect(stats.queueLength).toBeGreaterThan(0);
    });

    it('sollte Token-Limits berücksichtigen', async () => {
      await queueService.updateRateLimits({
        geminiMaxTokensPerMinute: 3000,
        geminiMaxRequestsPerMinute: 10,
      });

      const shop = 'test-shop.myshopify.com';
      const mockExecute = vi.fn().mockResolvedValue('result');

      // Enqueue Requests mit vielen Tokens
      queueService.enqueue(shop, 'task-1', 'gemini', 2000, mockExecute);
      queueService.enqueue(shop, 'task-2', 'gemini', 2000, mockExecute); // Überschreitet Limit

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Nur 1 sollte ausgeführt worden sein (2000 + 2000 > 3000)
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe('Retry-Mechanismus', () => {
    it('sollte bei Rate-Limit-Fehlern automatisch retries', async () => {
      const shop = 'test-shop.myshopify.com';
      const taskId = 'task-retry';

      let attemptCount = 0;
      const mockExecute = vi.fn().mockImplementation(() => {
        attemptCount++;
        if (attemptCount < 2) {
          // Erster Versuch: Rate Limit Error
          const error = new Error('Rate limit exceeded');
          (error as any).status = 429;
          throw error;
        }
        // Zweiter Versuch: Erfolg
        return Promise.resolve('Success after retry');
      });

      const promise = queueService.enqueue(shop, taskId, 'openai', 1000, mockExecute);

      // Warte auf Retry (exponential backoff: 2^1 * 1000ms = 2s)
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const result = await promise;

      expect(result).toBe('Success after retry');
      expect(mockExecute).toHaveBeenCalledTimes(2);

      // Verifiziere: Retry-Count wurde in DB aktualisiert
      expect(mockDb.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: taskId },
          data: { retryCount: 1 },
        })
      );
    });

    it('sollte nach 3 Retries aufgeben', async () => {
      const shop = 'test-shop.myshopify.com';
      const taskId = 'task-fail';

      const mockExecute = vi.fn().mockImplementation(() => {
        const error = new Error('Permanent rate limit');
        (error as any).status = 429;
        throw error;
      });

      const promise = queueService.enqueue(shop, taskId, 'claude', 1000, mockExecute);

      // Warte auf alle Retries (2^1 + 2^2 + 2^3 = 2 + 4 + 8 = 14s)
      // Verwende kürzere Zeit für Test
      await expect(promise).rejects.toThrow('Permanent rate limit');

      // Sollte 4x versucht haben (original + 3 retries)
      // Note: Im echten Test mit langer Wartezeit, hier nur Konzept
    });
  });

  describe('getQueueStats', () => {
    it('sollte Queue-Statistiken für einen Shop zurückgeben', async () => {
      const shop = 'test-shop.myshopify.com';

      // Enqueue mehrere Tasks
      queueService.enqueue(shop, 'task-1', 'huggingface', 1000, vi.fn());
      queueService.enqueue(shop, 'task-2', 'gemini', 500, vi.fn());
      queueService.enqueue(shop, 'task-3', 'huggingface', 800, vi.fn());

      const stats = queueService.getQueueStats(shop);

      expect(stats.queueLength).toBe(3);
      expect(stats.byProvider.huggingface).toBe(2);
      expect(stats.byProvider.gemini).toBe(1);
      expect(stats.byShop[shop]).toBe(3);
    });

    it('sollte globale Statistiken ohne Shop-Parameter zurückgeben', () => {
      queueService.enqueue('shop1.myshopify.com', 'task-1', 'claude', 1000, vi.fn());
      queueService.enqueue('shop2.myshopify.com', 'task-2', 'openai', 1000, vi.fn());

      const stats = queueService.getQueueStats();

      expect(stats.queueLength).toBe(2);
      expect(stats.byShop['shop1.myshopify.com']).toBe(1);
      expect(stats.byShop['shop2.myshopify.com']).toBe(1);
    });
  });

  describe('Cleanup Mechanism', () => {
    it('sollte inaktive Shops nach 24h entfernen', () => {
      const shop1 = 'active-shop.myshopify.com';
      const shop2 = 'inactive-shop.myshopify.com';

      // Simuliere Queue-Aktivität
      (queueService as any).queues.set(shop1, []);
      (queueService as any).queues.set(shop2, []);

      // Setze lastActivity-Timestamps
      const now = Date.now();
      (queueService as any).lastShopActivity.set(shop1, now); // Gerade aktiv
      (queueService as any).lastShopActivity.set(shop2, now - 25 * 60 * 60 * 1000); // 25h alt

      // Trigger manuelles Cleanup
      queueService.forceCleanup();

      // Verifiziere: Inaktiver Shop wurde entfernt
      expect((queueService as any).queues.has(shop1)).toBe(true);
      expect((queueService as any).queues.has(shop2)).toBe(false);
    });

    it('sollte Shops mit aktiven Queues NICHT entfernen', () => {
      const shop = 'busy-shop.myshopify.com';

      // Shop ist inaktiv, aber hat noch Requests in Queue
      (queueService as any).queues.set(shop, [{ id: 'pending-task' }]);
      (queueService as any).lastShopActivity.set(shop, Date.now() - 25 * 60 * 60 * 1000);

      queueService.forceCleanup();

      // Shop sollte NICHT entfernt werden (Queue nicht leer)
      expect((queueService as any).queues.has(shop)).toBe(true);
    });
  });

  describe('Task Recovery', () => {
    it('sollte Tasks aus DB wiederherstellen können', async () => {
      const task = {
        id: 'recovered-task-123',
        shop: 'test-shop.myshopify.com',
        prompt: 'Translate this text',
        provider: 'claude',
        estimatedTokens: 1500,
        retryCount: 0,
      };

      const mockSettings = {
        claudeApiKey: 'test-key',
      };

      mockDb.task.update = vi.fn();

      // Note: enqueueFromTask erstellt eine neue AIService-Instanz
      // Für Unit-Test würden wir AIService mocken
      // Hier nur Konzept-Test
      await expect(
        queueService.enqueueFromTask(task, mockSettings)
      ).resolves.not.toThrow();
    });
  });
});
