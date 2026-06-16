/**
 * Webhook Retry Service
 *
 * Provides exponential backoff retry logic for failed webhook processing.
 * Prevents data loss from transient errors by automatically retrying failed webhooks.
 *
 * Features:
 * - Exponential backoff (1s → 2s → 4s → 8s → 16s → 60s max)
 * - Configurable maximum retry attempts
 * - Automatic cleanup of successful/expired retries
 * - Per-webhook topic handling
 * - Detailed error logging
 *
 * Usage:
 * ```typescript
 * import { webhookRetryService } from '~/services/webhook-retry.service';
 *
 * try {
 *   await processWebhook(payload);
 * } catch (error) {
 *   await webhookRetryService.scheduleRetry(shop, topic, payload);
 * }
 * ```
 */

import type { WebhookRetry } from "@prisma/client";
import { db } from "../db.server";
import { logger } from "../utils/logger.server";
import { WEBHOOK_CONFIG } from "../config/constants";

// R4-H3: was `new PrismaClient()` — a SECOND client with its own connection
// pool that was never $disconnect()-ed (pool leak; doubled DB connections,
// and the pool stayed open through shutdown). Reuse the single shared client
// (also $disconnect()-ed exactly once by server.js gracefulShutdown).

export interface WebhookRetryJob {
  id: string;
  shop: string;
  topic: string;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  nextRetry: Date;
  lastError?: string;
}

export type WebhookHandler = (payload: Record<string, unknown>, shop: string) => Promise<void>;

class WebhookRetryService {
  private handlers: Map<string, WebhookHandler> = new Map();
  private processingInterval: NodeJS.Timeout | null = null;
  private readonly PROCESSING_INTERVAL_MS = 5000; // Check every 5 seconds

  constructor() {
    // R4-H3: start-on-construct is intentional — the singleton must process
    // retries wherever this module is imported (e.g. webhooks.products needs
    // it live to actually drain scheduled retries). startProcessing() is
    // idempotent (guarded by this.processingInterval) and the loop is torn
    // down on SIGTERM/SIGINT, so this is not a leak.
    this.startProcessing();
  }

  /**
   * Register a webhook handler for a specific topic
   */
  registerHandler(topic: string, handler: WebhookHandler): void {
    this.handlers.set(topic, handler);
    logger.info('Webhook handler registered', {
      context: 'WebhookRetry',
      topic,
    });
  }

  /**
   * Schedule a webhook for retry
   */
  async scheduleRetry(
    shop: string,
    topic: string,
    payload: Record<string, unknown>,
    error?: Error
  ): Promise<void> {
    try {
      const payloadString = JSON.stringify(payload);
      const errorMessage = error?.message || 'Unknown error';

      // Don't enqueue retries we already know will fail. A 401 means the
      // offline token is dead; retrying with the same dead token can't work,
      // and a session refresh only happens when the merchant opens the app.
      // The inline webhook that just failed will be picked up again by the
      // next products/update event after the token is refreshed.
      if (/\b401\b|Unauthorized|Invalid API key or access token/i.test(errorMessage)) {
        logger.warn('Skipping webhook retry — auth error not recoverable by retry', {
          context: 'WebhookRetry',
          shop,
          topic,
          error: errorMessage,
        });
        return;
      }

      const retry = await db.webhookRetry.create({
        data: {
          shop,
          topic,
          payload: payloadString,
          attempt: 0,
          maxAttempts: WEBHOOK_CONFIG.MAX_RETRY_ATTEMPTS,
          nextRetry: new Date(Date.now() + WEBHOOK_CONFIG.RETRY_DELAYS[0]),
          lastError: errorMessage,
        },
      });

      logger.warn('Webhook scheduled for retry', {
        context: 'WebhookRetry',
        retryId: retry.id,
        shop,
        topic,
        nextRetry: retry.nextRetry,
        error: errorMessage,
      });
    } catch (err) {
      logger.error('Failed to schedule webhook retry', {
        context: 'WebhookRetry',
        shop,
        topic,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Start the retry processing loop
   */
  private startProcessing(): void {
    if (this.processingInterval) {
      return; // Already running
    }

    logger.info('Starting webhook retry processor', {
      context: 'WebhookRetry',
      intervalMs: this.PROCESSING_INTERVAL_MS,
    });

    this.processingInterval = setInterval(() => {
      this.processQueue().catch((error) => {
        logger.error('Error in webhook retry processor', {
          context: 'WebhookRetry',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.PROCESSING_INTERVAL_MS);
  }

  /**
   * Stop the retry processing loop
   */
  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
      logger.info('Webhook retry processor stopped', {
        context: 'WebhookRetry',
      });
    }
  }

  /**
   * Process all pending retries
   */
  private async processQueue(): Promise<void> {
    try {
      // Find all retries that are due for processing
      const dueRetries = await db.webhookRetry.findMany({
        where: {
          nextRetry: { lte: new Date() },
          attempt: { lt: WEBHOOK_CONFIG.MAX_RETRY_ATTEMPTS },
        },
        orderBy: { nextRetry: 'asc' },
        take: 10, // Process max 10 at a time
      });

      if (dueRetries.length === 0) {
        return;
      }

      logger.debug('Processing webhook retries', {
        context: 'WebhookRetry',
        count: dueRetries.length,
      });

      for (const retry of dueRetries) {
        await this.processRetry(retry);
      }
    } catch (error) {
      logger.error('Error processing webhook retry queue', {
        context: 'WebhookRetry',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process a single retry attempt
   */
  /**
   * Built-in dispatch for the webhook topics the app emits. Without this,
   * scheduled retries were always dropped (no handler was ever registered via
   * registerHandler), so the products retry path was effectively dead and
   * collections had no retry path at all (N-H7). Resyncing the resource is
   * idempotent, which is exactly what a retry needs.
   */
  private defaultHandler(topic: string): WebhookHandler | undefined {
    if (topic === 'PRODUCTS_CREATE' || topic === 'PRODUCTS_UPDATE' || topic === 'PRODUCTS_DELETE') {
      return async (payload, shop) => {
        const productId = String(payload.productId);
        if (!productId) throw new Error('Retry payload missing productId');
        const { createAdminClientFromShop } = await import('../utils/admin-client.server');
        const { ProductSyncService } = await import('../services/product-sync.service');
        const admin = await createAdminClientFromShop(shop);
        const sync = new ProductSyncService(admin, shop);
        if (topic === 'PRODUCTS_DELETE') await sync.deleteProduct(productId);
        else await sync.syncProduct(productId);
      };
    }
    if (topic === 'COLLECTIONS_CREATE' || topic === 'COLLECTIONS_UPDATE' || topic === 'COLLECTIONS_DELETE') {
      return async (payload, shop) => {
        const collectionId = String(payload.collectionId);
        if (!collectionId) throw new Error('Retry payload missing collectionId');
        const { createAdminClientFromShop } = await import('../utils/admin-client.server');
        const { ContentSyncService } = await import('../services/content-sync.service');
        const admin = await createAdminClientFromShop(shop);
        const sync = new ContentSyncService(admin, shop);
        if (topic === 'COLLECTIONS_DELETE') await sync.deleteCollection(collectionId);
        else await sync.syncCollection(collectionId);
      };
    }
    return undefined;
  }

  private async processRetry(retry: WebhookRetry): Promise<void> {
    const handler = this.handlers.get(retry.topic) ?? this.defaultHandler(retry.topic);

    if (!handler) {
      logger.warn('No handler found for webhook topic', {
        context: 'WebhookRetry',
        retryId: retry.id,
        topic: retry.topic,
      });

      // Delete retry if no handler exists
      await db.webhookRetry.delete({ where: { id: retry.id } });
      return;
    }

    try {
      const payload = JSON.parse(retry.payload);

      logger.info('Attempting webhook retry', {
        context: 'WebhookRetry',
        retryId: retry.id,
        shop: retry.shop,
        topic: retry.topic,
        attempt: retry.attempt + 1,
        maxAttempts: retry.maxAttempts,
      });

      // Execute webhook handler
      await handler(payload, retry.shop);

      // Success - delete retry
      await db.webhookRetry.delete({ where: { id: retry.id } });

      logger.info('Webhook retry succeeded', {
        context: 'WebhookRetry',
        retryId: retry.id,
        shop: retry.shop,
        topic: retry.topic,
        attempt: retry.attempt + 1,
      });
    } catch (error) {
      const newAttempt = retry.attempt + 1;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Webhook retry failed', {
        context: 'WebhookRetry',
        retryId: retry.id,
        shop: retry.shop,
        topic: retry.topic,
        attempt: newAttempt,
        maxAttempts: retry.maxAttempts,
        error: errorMessage,
      });

      // A 401 from Shopify means the offline access token stored for this shop
      // is invalid — usually the merchant uninstalled/reinstalled or Shopify
      // rotated the token. Retrying with the same dead token can't succeed, so
      // keep looping just spams logs and burns DB writes until maxAttempts.
      // Drop the whole shop's queue in one shot: the next authenticated
      // request will refresh the session, and ProductSync is idempotent — so
      // the next inline webhook (or a user-triggered open of the app) will
      // resync the latest state anyway.
      const isAuthError = /\b401\b|Unauthorized|Invalid API key or access token/i.test(errorMessage);
      if (isAuthError) {
        const purged = await db.webhookRetry.deleteMany({ where: { shop: retry.shop } });
        logger.warn('Webhook retry aborted — auth error, dropping all retries for shop', {
          context: 'WebhookRetry',
          retryId: retry.id,
          shop: retry.shop,
          topic: retry.topic,
          purgedCount: purged.count,
          hint: 'Offline access token is dead. The merchant needs to re-open the app to refresh the session.',
        });
        return;
      }

      if (newAttempt >= retry.maxAttempts) {
        // Max attempts reached - log final failure and delete
        logger.error('Webhook retry max attempts reached - giving up', {
          context: 'WebhookRetry',
          retryId: retry.id,
          shop: retry.shop,
          topic: retry.topic,
          attempts: newAttempt,
          lastError: errorMessage,
        });

        await db.webhookRetry.delete({ where: { id: retry.id } });
      } else {
        // Schedule next retry with exponential backoff
        const delayIndex = Math.min(newAttempt, WEBHOOK_CONFIG.RETRY_DELAYS.length - 1);
        const delay = WEBHOOK_CONFIG.RETRY_DELAYS[delayIndex];
        const nextRetry = new Date(Date.now() + delay);

        await db.webhookRetry.update({
          where: { id: retry.id },
          data: {
            attempt: newAttempt,
            nextRetry,
            lastError: errorMessage,
          },
        });

        logger.info('Webhook retry rescheduled', {
          context: 'WebhookRetry',
          retryId: retry.id,
          nextRetry,
          delayMs: delay,
        });
      }
    }
  }

  /**
   * Get retry statistics for monitoring
   */
  async getStats(shop?: string): Promise<{
    total: number;
    byTopic: Record<string, number>;
    byAttempt: Record<number, number>;
  }> {
    const where = shop ? { shop } : {};

    const retries = await db.webhookRetry.findMany({
      where,
      select: { topic: true, attempt: true },
    });

    const byTopic: Record<string, number> = {};
    const byAttempt: Record<number, number> = {};

    for (const retry of retries) {
      byTopic[retry.topic] = (byTopic[retry.topic] || 0) + 1;
      byAttempt[retry.attempt] = (byAttempt[retry.attempt] || 0) + 1;
    }

    return {
      total: retries.length,
      byTopic,
      byAttempt,
    };
  }

  /**
   * Clean up old successful retries (older than 7 days)
   */
  async cleanup(): Promise<number> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const result = await db.webhookRetry.deleteMany({
      where: {
        OR: [
          { createdAt: { lt: sevenDaysAgo } },
          { attempt: { gte: WEBHOOK_CONFIG.MAX_RETRY_ATTEMPTS } },
        ],
      },
    });

    if (result.count > 0) {
      logger.info('Cleaned up old webhook retries', {
        context: 'WebhookRetry',
        deletedCount: result.count,
      });
    }

    return result.count;
  }
}

// Singleton instance
export const webhookRetryService = new WebhookRetryService();

// Graceful shutdown
if (typeof process !== 'undefined') {
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received - stopping webhook retry service', {
      context: 'WebhookRetry',
    });
    webhookRetryService.stop();
  });

  process.on('SIGINT', () => {
    logger.info('SIGINT received - stopping webhook retry service', {
      context: 'WebhookRetry',
    });
    webhookRetryService.stop();
  });
}
