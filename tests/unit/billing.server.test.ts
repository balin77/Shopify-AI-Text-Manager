/**
 * Unit Tests for billing.server.ts – checkAndSyncSubscription
 *
 * ✅ No real Shopify needed (admin is mocked)
 * ✅ No real database needed (prisma is mocked)
 * ✅ Fast (<50ms per test)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkAndSyncSubscription,
  getPlanFromSubscription,
  getCurrentSubscription,
  createSubscription,
} from '~/services/billing.server';
import { BILLING_PLANS } from '~/config/billing';
import type { Session } from '@shopify/shopify-api';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Use vi.hoisted so these refs are available inside vi.mock factories (which are hoisted)
const { mockAISettingsUpsert, mockAISettingsFindUnique } = vi.hoisted(() => ({
  mockAISettingsUpsert: vi.fn().mockResolvedValue({}),
  mockAISettingsFindUnique: vi.fn().mockResolvedValue({ shop: 'test.myshopify.com', subscriptionPlan: 'free' }),
}));

vi.mock('~/db.server', () => ({
  db: {
    aISettings: {
      findUnique: mockAISettingsFindUnique,
      upsert: mockAISettingsUpsert,
    },
  },
}));

vi.mock('~/utils/logger.server', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockAdmin(activeSubscriptions: unknown[] = []) {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: {
          currentAppInstallation: {
            activeSubscriptions,
          },
        },
      }),
    }),
  };
}

const activeProSubscription = {
  id: 'gid://shopify/AppSubscription/1',
  name: 'Pro Plan',
  status: 'ACTIVE',
  test: false,
  currentPeriodEnd: '2026-05-06T00:00:00Z',
  trialDays: 0,
};

const activeMaxSubscription = {
  id: 'gid://shopify/AppSubscription/2',
  name: 'Max Plan',
  status: 'ACTIVE',
  test: false,
  currentPeriodEnd: '2026-05-06T00:00:00Z',
  trialDays: 0,
};

const pendingSubscription = {
  id: 'gid://shopify/AppSubscription/3',
  name: 'Pro Plan',
  status: 'PENDING',
  test: false,
};

// ── getPlanFromSubscription ──────────────────────────────────────────────────

describe('getPlanFromSubscription()', () => {
  it('returns "free" for null subscription', () => {
    expect(getPlanFromSubscription(null)).toBe('free');
  });

  it('returns "pro" for a Pro subscription', () => {
    expect(getPlanFromSubscription(activeProSubscription)).toBe('pro');
  });

  it('returns "max" for a Max subscription', () => {
    expect(getPlanFromSubscription(activeMaxSubscription)).toBe('max');
  });

  it('returns "basic" for a Basic subscription', () => {
    expect(getPlanFromSubscription({ ...activeProSubscription, name: 'Basic Plan' })).toBe('basic');
  });

  it('returns "free" for unrecognised subscription name', () => {
    expect(getPlanFromSubscription({ ...activeProSubscription, name: 'Unknown Plan' })).toBe('free');
  });
});

// ── getCurrentSubscription ───────────────────────────────────────────────────

describe('getCurrentSubscription()', () => {
  it('returns the first active subscription when present', async () => {
    const admin = makeMockAdmin([activeProSubscription]);
    const result = await getCurrentSubscription(admin);
    expect(result).toEqual(activeProSubscription);
  });

  it('returns null when there are no active subscriptions', async () => {
    const admin = makeMockAdmin([]);
    const result = await getCurrentSubscription(admin);
    expect(result).toBeNull();
  });

  it('calls admin.graphql exactly once', async () => {
    const admin = makeMockAdmin([activeProSubscription]);
    await getCurrentSubscription(admin);
    expect(admin.graphql).toHaveBeenCalledOnce();
  });
});

// ── checkAndSyncSubscription ─────────────────────────────────────────────────

describe('checkAndSyncSubscription()', () => {
  const shop = 'test.myshopify.com';

  beforeEach(() => {
    vi.clearAllMocks();
    mockAISettingsFindUnique.mockResolvedValue({ shop, subscriptionPlan: 'free' });
    mockAISettingsUpsert.mockResolvedValue({});
  });

  it('returns and syncs "pro" when an active Pro subscription exists', async () => {
    const admin = makeMockAdmin([activeProSubscription]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('pro');
    expect(mockAISettingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shop },
        update: { subscriptionPlan: 'pro' },
        create: { shop, subscriptionPlan: 'pro' },
      })
    );
  });

  it('returns and syncs "max" when an active Max subscription exists', async () => {
    const admin = makeMockAdmin([activeMaxSubscription]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('max');
    expect(mockAISettingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { subscriptionPlan: 'max' } })
    );
  });

  it('downgrades to "free" when there is no subscription', async () => {
    const admin = makeMockAdmin([]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('free');
    expect(mockAISettingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { subscriptionPlan: 'free' } })
    );
  });

  it('downgrades to "free" when subscription status is PENDING (not ACTIVE)', async () => {
    const admin = makeMockAdmin([pendingSubscription]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('free');
  });

  it('defaults to "free" and syncs on admin.graphql error', async () => {
    const admin = {
      graphql: vi.fn().mockRejectedValue(new Error('Network error')),
    };

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('free');
    // Should still attempt to sync 'free' to DB even on error
    expect(mockAISettingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { subscriptionPlan: 'free' } })
    );
  });

  it('upserts even when shop has no aISettings record (covers reinstall edge case)', async () => {
    mockAISettingsFindUnique.mockResolvedValue(null);
    const admin = makeMockAdmin([activeProSubscription]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('pro');
    // upsert is called with both update and create so reinstalled shops
    // without an existing AISettings row are handled correctly.
    expect(mockAISettingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shop },
        update: { subscriptionPlan: 'pro' },
        create: { shop, subscriptionPlan: 'pro' },
      })
    );
  });
});

// ── createSubscription ───────────────────────────────────────────────────────

describe('createSubscription()', () => {
  const session = { shop: 'test.myshopify.com' } as Session;
  const returnUrl = 'https://example.com/app/billing/callback';

  /**
   * Mock admin that routes by query content:
   * - the isDevStore() shop.plan query → non-dev store
   * - the appSubscriptionCreate mutation → valid payload
   * Captures the variables passed to the mutation for assertions.
   */
  function makeBillingAdmin(userErrors: Array<{ field?: string; message: string }> = []) {
    const graphql = vi.fn(async (query: string, options?: { variables?: Record<string, unknown> }) => {
      if (query.includes('partnerDevelopment')) {
        return { json: async () => ({ data: { shop: { plan: { partnerDevelopment: false } } } }) };
      }
      if (query.includes('appSubscriptionCreate')) {
        return {
          json: async () => ({
            data: {
              appSubscriptionCreate: {
                appSubscription: {
                  id: 'gid://shopify/AppSubscription/99',
                  name: options?.variables?.name,
                  test: false,
                  status: 'PENDING',
                  currentPeriodEnd: null,
                  trialDays: options?.variables?.trialDays,
                },
                confirmationUrl: 'https://shopify.example/confirm',
                userErrors,
              },
            },
          }),
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 40)}`);
    });
    return { graphql };
  }

  function lastMutationVariables(admin: { graphql: ReturnType<typeof vi.fn> }) {
    const call = admin.graphql.mock.calls.find(([q]) => String(q).includes('appSubscriptionCreate'));
    return (call?.[1] as { variables?: Record<string, unknown> } | undefined)?.variables;
  }

  it('sends trialDays from the plan config for a new subscription', async () => {
    const admin = makeBillingAdmin();

    const result = await createSubscription(admin, session, 'pro', returnUrl);

    const vars = lastMutationVariables(admin);
    expect(vars?.trialDays).toBe(BILLING_PLANS.pro.trialDays);
    expect(vars?.trialDays).toBe(7);
    expect(vars?.replacementBehavior).toBeNull();
    expect(result.confirmationUrl).toBe('https://shopify.example/confirm');
    expect(result.subscription.trialDays).toBe(7);
  });

  it('sends trialDays=0 and APPLY_IMMEDIATELY on a paid→paid switch', async () => {
    const admin = makeBillingAdmin();

    await createSubscription(admin, session, 'max', returnUrl, true);

    const vars = lastMutationVariables(admin);
    expect(vars?.trialDays).toBe(0);
    expect(vars?.replacementBehavior).toBe('APPLY_IMMEDIATELY');
  });

  it('throws when the mutation returns userErrors', async () => {
    const admin = makeBillingAdmin([{ field: 'lineItems', message: 'Invalid price' }]);

    await expect(createSubscription(admin, session, 'basic', returnUrl)).rejects.toThrow(
      /Failed to create subscription: Invalid price/
    );
  });
});
