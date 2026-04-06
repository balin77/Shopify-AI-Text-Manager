/**
 * Unit Tests for webhook-registration.service.ts – registerProductWebhooks
 *
 * ✅ No real Shopify needed (admin is mocked)
 * ✅ No real database needed
 * ✅ Fast (<50ms per test)
 *
 * Covers:
 * - Happy path: all 3 product webhooks are created
 * - Idempotency: existing webhooks are updated, not re-created
 * - Resilience: failure on one webhook does NOT abort the others
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookRegistrationService } from '~/services/webhook-registration.service';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('~/utils/logger.server', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock admin client that returns configurable GraphQL responses. */
function buildMockAdmin(options: {
  existingWebhooks?: Array<{ id: string; topic: string; endpoint?: { __typename: string; callbackUrl?: string } }>;
  createShouldFail?: string; // topic that should return userErrors
  createShouldThrow?: string; // topic that should throw a network error
} = {}) {
  const { existingWebhooks = [], createShouldFail, createShouldThrow } = options;

  return {
    graphql: vi.fn().mockImplementation(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      // getWebhookSubscriptions (list query)
      if (query.includes('getWebhookSubscriptions')) {
        return {
          json: async () => ({
            data: {
              webhookSubscriptions: {
                edges: existingWebhooks.map((w) => ({ node: w })),
              },
            },
          }),
        };
      }

      // webhookSubscriptionCreate
      if (query.includes('webhookSubscriptionCreate')) {
        const topic = opts?.variables?.topic as string | undefined;

        if (topic && topic === createShouldThrow) {
          throw new Error(`Network error registering ${topic}`);
        }

        const userErrors =
          topic && topic === createShouldFail
            ? [{ message: `Failed to create ${topic}` }]
            : [];

        return {
          json: async () => ({
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: userErrors.length === 0 ? { id: `gid://shopify/WebhookSubscription/${Math.random()}`, topic } : null,
                userErrors,
              },
            },
          }),
        };
      }

      // webhookSubscriptionUpdate
      if (query.includes('webhookSubscriptionUpdate')) {
        return {
          json: async () => ({
            data: {
              webhookSubscriptionUpdate: {
                webhookSubscription: { id: opts?.variables?.id },
                userErrors: [],
              },
            },
          }),
        };
      }

      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    }),
  };
}

const APP_URL = 'https://app.example.com';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WebhookRegistrationService.registerProductWebhooks()', () => {
  const originalEnv = process.env.SHOPIFY_APP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_APP_URL = APP_URL;
  });

  afterEach(() => {
    process.env.SHOPIFY_APP_URL = originalEnv;
  });

  it('throws when SHOPIFY_APP_URL is not set', async () => {
    delete process.env.SHOPIFY_APP_URL;
    const admin = buildMockAdmin();
    const service = new WebhookRegistrationService(admin);

    await expect(service.registerProductWebhooks()).rejects.toThrow(
      'SHOPIFY_APP_URL environment variable not set'
    );
  });

  it('creates all 3 product webhooks when none exist yet', async () => {
    const admin = buildMockAdmin();
    const service = new WebhookRegistrationService(admin);

    await service.registerProductWebhooks();

    const createCalls = admin.graphql.mock.calls.filter(([q]: [string]) =>
      q.includes('webhookSubscriptionCreate')
    );

    expect(createCalls).toHaveLength(3);

    const topics = createCalls.map(([, opts]: [string, { variables?: Record<string, unknown> }]) => opts?.variables?.topic);
    expect(topics).toContain('PRODUCTS_CREATE');
    expect(topics).toContain('PRODUCTS_UPDATE');
    expect(topics).toContain('PRODUCTS_DELETE');
  });

  it('updates (not re-creates) an existing webhook', async () => {
    const existingWebhook = {
      id: 'gid://shopify/WebhookSubscription/existing-1',
      topic: 'PRODUCTS_CREATE',
      endpoint: { __typename: 'WebhookHttpEndpoint', callbackUrl: `${APP_URL}/webhooks/products` },
    };

    const admin = buildMockAdmin({ existingWebhooks: [existingWebhook] });
    const service = new WebhookRegistrationService(admin);

    await service.registerProductWebhooks();

    const updateCalls = admin.graphql.mock.calls.filter(([q]: [string]) =>
      q.includes('webhookSubscriptionUpdate')
    );
    const createCalls = admin.graphql.mock.calls.filter(([q]: [string]) =>
      q.includes('webhookSubscriptionCreate')
    );

    // PRODUCTS_CREATE should be updated, the other 2 should be created
    expect(updateCalls).toHaveLength(1);
    expect(createCalls).toHaveLength(2);
  });

  it('continues registering remaining webhooks when one create returns userErrors', async () => {
    const admin = buildMockAdmin({ createShouldFail: 'PRODUCTS_CREATE' });
    const service = new WebhookRegistrationService(admin);

    // Should NOT throw – the error is caught per-webhook
    await expect(service.registerProductWebhooks()).resolves.toBeUndefined();

    // PRODUCTS_UPDATE and PRODUCTS_DELETE should still be attempted
    const createCalls = admin.graphql.mock.calls.filter(([q]: [string]) =>
      q.includes('webhookSubscriptionCreate')
    );
    expect(createCalls).toHaveLength(3);
  });

  it('continues registering remaining webhooks when one graphql call throws', async () => {
    const admin = buildMockAdmin({ createShouldThrow: 'PRODUCTS_CREATE' });
    const service = new WebhookRegistrationService(admin);

    // Should NOT throw – the error is caught and logged per-webhook
    await expect(service.registerProductWebhooks()).resolves.toBeUndefined();

    // All 3 create calls are attempted – 1 throws, 2 succeed
    const createCalls = admin.graphql.mock.calls.filter(([q]: [string]) =>
      q.includes('webhookSubscriptionCreate')
    );
    expect(createCalls).toHaveLength(3);
  });

  it('does not call graphql at all when SHOPIFY_APP_URL is missing', async () => {
    delete process.env.SHOPIFY_APP_URL;
    const admin = buildMockAdmin();
    const service = new WebhookRegistrationService(admin);

    await expect(service.registerProductWebhooks()).rejects.toThrow();
    expect(admin.graphql).not.toHaveBeenCalled();
  });
});
