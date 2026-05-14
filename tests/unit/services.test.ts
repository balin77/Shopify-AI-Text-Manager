/**
 * Unit Tests — Service Classes (Task 50 coverage increase)
 *
 * Covers:
 * - shopify-api-gateway.service.ts (ShopifyApiGateway — queue management + basic graphql call)
 * - webhook-registration.service.ts (WebhookRegistrationService — constructor + listWebhooks)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShopifyApiGateway } from '~/services/shopify-api-gateway.service';
import { WebhookRegistrationService } from '~/services/webhook-registration.service';

// ============================================================
// ShopifyApiGateway
// ============================================================

function makeAdmin(responseData: unknown = {}) {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: () => Promise.resolve(responseData),
    }),
  };
}

describe('ShopifyApiGateway', () => {
  it('initializes with empty queue', () => {
    const gateway = new ShopifyApiGateway(makeAdmin(), 'test-shop.myshopify.com');
    const status = gateway.getQueueStatus();
    expect(status.queueLength).toBe(0);
    expect(status.isProcessing).toBe(false);
    expect(status.requestCount).toBe(0);
  });

  it('clearQueue removes all pending requests and rejects them', () => {
    const admin = makeAdmin({ data: {} });
    // Make graphql hang so the first request stays "in flight"
    // and subsequent requests remain in the queue.
    admin.graphql = vi.fn().mockReturnValue(new Promise(() => {}));
    const gateway = new ShopifyApiGateway(admin, 'test-shop.myshopify.com');

    // First request gets shifted out of the queue and becomes in-flight.
    gateway.graphql('{ shop { name } }');
    // Second request stays queued — this is what clearQueue rejects.
    const queued = gateway.graphql('{ shop { name } }');

    gateway.clearQueue();

    return expect(queued).rejects.toThrow('Queue cleared');
  });

  it('resolves a successful graphql call', async () => {
    const admin = makeAdmin({ data: { shop: { name: 'My Shop' } } });
    const gateway = new ShopifyApiGateway(admin, 'test-shop.myshopify.com');

    const result = await gateway.graphql('{ shop { name } }');
    const data = await result.json();
    expect(data.data.shop.name).toBe('My Shop');
  });

  it('returns queue status after a request', async () => {
    const admin = makeAdmin({ data: {} });
    const gateway = new ShopifyApiGateway(admin, 'test-shop.myshopify.com');
    await gateway.graphql('{ shop { name } }');
    const status = gateway.getQueueStatus();
    // After processing, queue should be empty
    expect(status.queueLength).toBe(0);
  });

  it('handles GraphQL error in response without throwing', async () => {
    const admin = makeAdmin({ errors: [{ message: 'Not found', extensions: { code: 'NOT_FOUND' } }] });
    const gateway = new ShopifyApiGateway(admin, 'test-shop.myshopify.com');
    // Should resolve (gateway logs error but doesn't throw for non-throttle errors)
    const result = await gateway.graphql('{ shop { name } }');
    expect(result).toBeDefined();
  });

  it('handles throttle error and retries', async () => {
    let callCount = 0;
    const admin = {
      graphql: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.resolve({ json: () => Promise.resolve({ errors: [{ extensions: { code: 'THROTTLED' }, message: 'Throttled' }] }) });
        }
        return Promise.resolve({ json: () => Promise.resolve({ data: { ok: true } }) });
      }),
    };

    const gateway = new ShopifyApiGateway(admin, 'test-shop.myshopify.com');
    // Use fake timers so retry doesn't actually wait 1s
    vi.useFakeTimers();
    const promise = gateway.graphql('{ shop { name } }');
    // Advance past the retry delay
    await vi.runAllTimersAsync();
    const result = await promise;
    const data = await result.json();
    expect(data.data.ok).toBe(true);
    vi.useRealTimers();
  }, 15000);
});

// ============================================================
// WebhookRegistrationService
// ============================================================

describe('WebhookRegistrationService', () => {
  const makeWebhookAdmin = (responseData: unknown) => ({
    graphql: vi.fn().mockResolvedValue({
      json: () => Promise.resolve(responseData),
    }),
  });

  describe('listWebhooks', () => {
    it('returns empty array when no webhooks exist', async () => {
      const admin = makeWebhookAdmin({
        data: { webhookSubscriptions: { edges: [] } },
      });
      const service = new WebhookRegistrationService(admin);
      const result = await service.listWebhooks();
      expect(result).toEqual([]);
    });

    it('returns webhook nodes from response', async () => {
      const admin = makeWebhookAdmin({
        data: {
          webhookSubscriptions: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/WebhookSubscription/1',
                  topic: 'PRODUCTS_CREATE',
                  endpoint: { __typename: 'WebhookHttpEndpoint', callbackUrl: 'https://example.com/webhooks' },
                },
              },
            ],
          },
        },
      });
      const service = new WebhookRegistrationService(admin);
      const result = await service.listWebhooks();
      expect(result).toHaveLength(1);
      expect(result[0].topic).toBe('PRODUCTS_CREATE');
    });
  });

  describe('registerProductWebhooks', () => {
    it('throws when SHOPIFY_APP_URL is not set', async () => {
      const originalUrl = process.env.SHOPIFY_APP_URL;
      delete process.env.SHOPIFY_APP_URL;

      const admin = makeWebhookAdmin({ data: {} });
      const service = new WebhookRegistrationService(admin);

      await expect(service.registerProductWebhooks()).rejects.toThrow('SHOPIFY_APP_URL');

      process.env.SHOPIFY_APP_URL = originalUrl;
    });

    it('registers webhooks when SHOPIFY_APP_URL is set', async () => {
      process.env.SHOPIFY_APP_URL = 'https://test-app.example.com';

      // Mock: getExistingWebhook (returns null = no existing webhook)
      const admin = {
        graphql: vi.fn()
          // First call: check existing webhooks for PRODUCTS_CREATE
          .mockResolvedValueOnce({ json: () => Promise.resolve({ data: { webhookSubscriptions: { edges: [] } } }) })
          // Second call: create PRODUCTS_CREATE webhook
          .mockResolvedValueOnce({ json: () => Promise.resolve({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: '1', topic: 'PRODUCTS_CREATE' }, userErrors: [] } } }) })
          // Third call: check existing for PRODUCTS_UPDATE
          .mockResolvedValueOnce({ json: () => Promise.resolve({ data: { webhookSubscriptions: { edges: [] } } }) })
          // Fourth call: create PRODUCTS_UPDATE
          .mockResolvedValueOnce({ json: () => Promise.resolve({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: '2', topic: 'PRODUCTS_UPDATE' }, userErrors: [] } } }) })
          // Fifth call: check existing for PRODUCTS_DELETE
          .mockResolvedValueOnce({ json: () => Promise.resolve({ data: { webhookSubscriptions: { edges: [] } } }) })
          // Sixth call: create PRODUCTS_DELETE
          .mockResolvedValueOnce({ json: () => Promise.resolve({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: '3', topic: 'PRODUCTS_DELETE' }, userErrors: [] } } }) }),
      };

      const service = new WebhookRegistrationService(admin);
      await expect(service.registerProductWebhooks()).resolves.not.toThrow();
      expect(admin.graphql).toHaveBeenCalledTimes(6);

      process.env.SHOPIFY_APP_URL = undefined;
    });
  });
});
