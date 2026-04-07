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
} from '~/services/billing.server';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Use vi.hoisted so these refs are available inside vi.mock factories (which are hoisted)
const { mockAISettingsUpdate, mockAISettingsFindUnique } = vi.hoisted(() => ({
  mockAISettingsUpdate: vi.fn().mockResolvedValue({}),
  mockAISettingsFindUnique: vi.fn().mockResolvedValue({ shop: 'test.myshopify.com', subscriptionPlan: 'free' }),
}));

vi.mock('~/db.server', () => ({
  db: {
    aISettings: {
      findUnique: mockAISettingsFindUnique,
      update: mockAISettingsUpdate,
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
    mockAISettingsUpdate.mockResolvedValue({});
  });

  it('returns and syncs "pro" when an active Pro subscription exists', async () => {
    const admin = makeMockAdmin([activeProSubscription]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('pro');
    expect(mockAISettingsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shop },
        data: { subscriptionPlan: 'pro' },
      })
    );
  });

  it('returns and syncs "max" when an active Max subscription exists', async () => {
    const admin = makeMockAdmin([activeMaxSubscription]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('max');
    expect(mockAISettingsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { subscriptionPlan: 'max' } })
    );
  });

  it('downgrades to "free" when there is no subscription', async () => {
    const admin = makeMockAdmin([]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('free');
    expect(mockAISettingsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { subscriptionPlan: 'free' } })
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
    expect(mockAISettingsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { subscriptionPlan: 'free' } })
    );
  });

  it('does not update DB when shop has no aISettings record', async () => {
    mockAISettingsFindUnique.mockResolvedValue(null);
    const admin = makeMockAdmin([activeProSubscription]);

    const plan = await checkAndSyncSubscription(admin, shop);

    // Plan is still determined correctly
    expect(plan).toBe('pro');
    // But update is not called since findUnique returned null
    expect(mockAISettingsUpdate).not.toHaveBeenCalled();
  });
});
