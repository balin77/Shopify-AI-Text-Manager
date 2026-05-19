/**
 * Unit Tests for billing.server.ts – checkAndSyncSubscription
 *
 * ✅ No real Shopify needed (admin is mocked)
 * ✅ No real database needed (prisma is mocked)
 * ✅ Fast (<50ms per test)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkAndSyncSubscription,
  getPlanFromSubscription,
  getCurrentSubscription,
  createSubscription,
  getTrialInfo,
} from '~/services/billing.server';
import { BILLING_PLANS } from '~/config/billing';
import type { Session } from '@shopify/shopify-api';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Use vi.hoisted so these refs are available inside vi.mock factories (which are hoisted)
const { mockAISettingsUpsert, mockAISettingsFindUnique, mockAISettingsUpdateMany } = vi.hoisted(() => ({
  mockAISettingsUpsert: vi.fn().mockResolvedValue({}),
  mockAISettingsFindUnique: vi.fn().mockResolvedValue({
    shop: 'test.myshopify.com',
    subscriptionPlan: 'free',
    trialConsumedAt: null,
  }),
  mockAISettingsUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
}));

vi.mock('~/db.server', () => ({
  db: {
    aISettings: {
      findUnique: mockAISettingsFindUnique,
      upsert: mockAISettingsUpsert,
      updateMany: mockAISettingsUpdateMany,
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
    mockAISettingsFindUnique.mockResolvedValue({ shop, subscriptionPlan: 'free', trialConsumedAt: null });
    mockAISettingsUpsert.mockResolvedValue({});
    mockAISettingsUpdateMany.mockResolvedValue({ count: 1 });
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

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: shop has never consumed a trial.
    mockAISettingsFindUnique.mockResolvedValue({
      shop: session.shop,
      subscriptionPlan: 'free',
      trialConsumedAt: null,
    });
  });

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

  it('sends trialDays=0 for a re-subscribe after cancel when trialConsumedAt is set', async () => {
    // free → basic[trial] → cancel → pro: no active sub now (hasExistingSubscription
    // = false), but the persistent marker blocks a second trial.
    mockAISettingsFindUnique.mockResolvedValue({
      shop: session.shop,
      subscriptionPlan: 'free',
      trialConsumedAt: new Date('2026-05-01T00:00:00Z'),
    });
    const admin = makeBillingAdmin();

    await createSubscription(admin, session, 'pro', returnUrl);

    const vars = lastMutationVariables(admin);
    expect(vars?.trialDays).toBe(0);
    expect(vars?.replacementBehavior).toBeNull();
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

// ── trial-consumption marking (verified point) ───────────────────────────────

describe('checkAndSyncSubscription() – trialConsumedAt marking', () => {
  const shop = 'test.myshopify.com';

  const trialingProSubscription = {
    id: 'gid://shopify/AppSubscription/7',
    name: 'Pro Plan',
    status: 'ACTIVE',
    test: false,
    currentPeriodEnd: '2026-05-23T00:00:00Z',
    trialDays: 7,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAISettingsFindUnique.mockResolvedValue({ shop, subscriptionPlan: 'free', trialConsumedAt: null });
    mockAISettingsUpsert.mockResolvedValue({});
    mockAISettingsUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('marks the trial consumed when an ACTIVE trial subscription is verified', async () => {
    const admin = makeMockAdmin([trialingProSubscription]);

    await checkAndSyncSubscription(admin, shop);

    // Idempotent + never-reset: filtered on trialConsumedAt:null, sets a Date.
    expect(mockAISettingsUpdateMany).toHaveBeenCalledWith({
      where: { shop, trialConsumedAt: null },
      data: { trialConsumedAt: expect.any(Date) },
    });
  });

  it('does NOT mark when the active subscription has no trial (trialDays=0)', async () => {
    const admin = makeMockAdmin([activeProSubscription]); // trialDays: 0

    await checkAndSyncSubscription(admin, shop);

    // R4-DI4: updateMany is now also used for the atomic plan-transition CAS,
    // so assert specifically that the TRIAL-marking updateMany never ran
    // (rather than "updateMany never called at all").
    expect(mockAISettingsUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trialConsumedAt: expect.any(Date) }),
      })
    );
  });

  it('does NOT touch the marker on cancel/downgrade (no active subscription)', async () => {
    const admin = makeMockAdmin([]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('free');
    // Marker is never reset on the free/cancel path.
    expect(mockAISettingsUpdateMany).not.toHaveBeenCalled();
  });
});

// ── dev-plan-override short-circuit (custom-app build) ───────────────────────

describe('checkAndSyncSubscription() – dev override short-circuit', () => {
  const shop = 'test.myshopify.com';
  const DEV_APP_CLIENT_ID = '433cf493223c0c6b95bdb91b0de5961a';
  let savedKey: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedKey = process.env.SHOPIFY_API_KEY;
    savedEnv = process.env.APP_ENV;
    delete process.env.APP_ENV;
    mockAISettingsUpsert.mockResolvedValue({});
    mockAISettingsUpdateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.SHOPIFY_API_KEY;
    else process.env.SHOPIFY_API_KEY = savedKey;
    if (savedEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = savedEnv;
  });

  it('returns the forced plan without ever calling Shopify (admin.graphql)', async () => {
    process.env.SHOPIFY_API_KEY = DEV_APP_CLIENT_ID;
    mockAISettingsFindUnique.mockResolvedValue({
      shop,
      subscriptionPlan: 'free',
      trialConsumedAt: null,
      devForcedPlan: 'max',
    });
    const admin = makeMockAdmin([activeProSubscription]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('max');
    expect(admin.graphql).not.toHaveBeenCalled();
    expect(mockAISettingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { subscriptionPlan: 'max' } }),
    );
  });

  it('does NOT short-circuit when client_id is not the dev app id', async () => {
    process.env.SHOPIFY_API_KEY = '9e5abc8c0e9e03ed24d4a2a2b1174c88'; // public app
    mockAISettingsFindUnique.mockResolvedValue({
      shop,
      subscriptionPlan: 'free',
      trialConsumedAt: null,
      devForcedPlan: 'max',
    });
    const admin = makeMockAdmin([activeProSubscription]);

    const plan = await checkAndSyncSubscription(admin, shop);

    expect(plan).toBe('pro'); // resolved from the real Shopify subscription
    expect(admin.graphql).toHaveBeenCalled();
  });
});

// ── getTrialInfo ─────────────────────────────────────────────────────────────

describe('getTrialInfo()', () => {
  const now = new Date('2026-05-16T00:00:00Z');
  const daysFromNow = (n: number) =>
    new Date(now.getTime() + n * 86_400_000).toISOString();

  it('detects an active trial (currentPeriodEnd within trialDays)', () => {
    expect(
      getTrialInfo({
        subscriptionStatus: 'ACTIVE',
        trialDays: 7,
        currentPeriodEnd: daysFromNow(3),
        now,
      })
    ).toEqual({ inTrial: true, remainingDays: 3 });
  });

  it('returns false after the trial ended (currentPeriodEnd > trialDays away)', () => {
    expect(
      getTrialInfo({
        subscriptionStatus: 'ACTIVE',
        trialDays: 7,
        currentPeriodEnd: daysFromNow(30),
        now,
      })
    ).toEqual({ inTrial: false, remainingDays: 0 });
  });

  it('returns false when there is no subscription', () => {
    expect(
      getTrialInfo({
        subscriptionStatus: null,
        trialDays: 0,
        currentPeriodEnd: null,
        now,
      })
    ).toEqual({ inTrial: false, remainingDays: 0 });
  });

  it('returns false when status is not ACTIVE', () => {
    expect(
      getTrialInfo({
        subscriptionStatus: 'PENDING',
        trialDays: 7,
        currentPeriodEnd: daysFromNow(3),
        now,
      })
    ).toEqual({ inTrial: false, remainingDays: 0 });
  });

  it('returns false when currentPeriodEnd is in the past', () => {
    expect(
      getTrialInfo({
        subscriptionStatus: 'ACTIVE',
        trialDays: 7,
        currentPeriodEnd: daysFromNow(-1),
        now,
      })
    ).toEqual({ inTrial: false, remainingDays: 0 });
  });
});
