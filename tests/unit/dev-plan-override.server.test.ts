/**
 * Unit Tests for dev-plan-override.server.ts
 *
 * Fixes the compliance-critical guarantee: the 'override' mode is provably
 * dead in the public App-Store build (unknown/public client_id ⇒ null, even
 * with the allowlist set and a devForcedPlan row present).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveDevPlanMode,
  getDevForcedPlan,
  setDevForcedPlan,
} from '~/services/dev-plan-override.server';

const DEV_APP_CLIENT_ID = '433cf493223c0c6b95bdb91b0de5961a';
const PUBLIC_APP_CLIENT_ID = '9e5abc8c0e9e03ed24d4a2a2b1174c88';
const SHOP = 'shop.myshopify.com';

const { mockFindUnique, mockUpsert } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpsert: vi.fn().mockResolvedValue({}),
}));

vi.mock('~/db.server', () => ({
  db: { aISettings: { findUnique: mockFindUnique, upsert: mockUpsert } },
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ENV_KEYS = ['SHOPIFY_API_KEY', 'APP_ENV', 'DEV_PLAN_OVERRIDE_SHOPS'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveDevPlanMode()', () => {
  it("returns 'override' for the dev client_id when APP_ENV != production", () => {
    process.env.SHOPIFY_API_KEY = DEV_APP_CLIENT_ID;
    expect(resolveDevPlanMode(SHOP)).toBe('override');
  });

  it("dev client_id but APP_ENV=production ⇒ NOT override (second lock)", () => {
    process.env.SHOPIFY_API_KEY = DEV_APP_CLIENT_ID;
    process.env.APP_ENV = 'production';
    expect(resolveDevPlanMode(SHOP)).toBeNull();
  });

  it("public client_id ⇒ never override, even with allowlist set", () => {
    process.env.SHOPIFY_API_KEY = PUBLIC_APP_CLIENT_ID;
    process.env.DEV_PLAN_OVERRIDE_SHOPS = SHOP;
    expect(resolveDevPlanMode(SHOP)).toBe('test-billing');
  });

  it("public client_id + shop NOT allow-listed ⇒ null (normal merchant)", () => {
    process.env.SHOPIFY_API_KEY = PUBLIC_APP_CLIENT_ID;
    process.env.DEV_PLAN_OVERRIDE_SHOPS = 'someone-else.myshopify.com';
    expect(resolveDevPlanMode(SHOP)).toBeNull();
  });

  it("test-billing allowlist is case/space-insensitive", () => {
    process.env.SHOPIFY_API_KEY = PUBLIC_APP_CLIENT_ID;
    process.env.DEV_PLAN_OVERRIDE_SHOPS = ' OTHER.myshopify.com , SHOP.myshopify.com ';
    expect(resolveDevPlanMode(SHOP)).toBe('test-billing');
  });

  it("no env at all ⇒ null", () => {
    expect(resolveDevPlanMode(SHOP)).toBeNull();
  });
});

describe('getDevForcedPlan()', () => {
  it('returns the validated plan in override mode', async () => {
    process.env.SHOPIFY_API_KEY = DEV_APP_CLIENT_ID;
    mockFindUnique.mockResolvedValue({ devForcedPlan: 'pro' });
    expect(await getDevForcedPlan(SHOP)).toBe('pro');
  });

  it('returns null for an invalid stored value', async () => {
    process.env.SHOPIFY_API_KEY = DEV_APP_CLIENT_ID;
    mockFindUnique.mockResolvedValue({ devForcedPlan: 'enterprise' });
    expect(await getDevForcedPlan(SHOP)).toBeNull();
  });

  it('COMPLIANCE: public build never reads the column even if a value exists', async () => {
    process.env.SHOPIFY_API_KEY = PUBLIC_APP_CLIENT_ID;
    process.env.DEV_PLAN_OVERRIDE_SHOPS = SHOP;
    mockFindUnique.mockResolvedValue({ devForcedPlan: 'max' });
    expect(await getDevForcedPlan(SHOP)).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});

describe('setDevForcedPlan()', () => {
  it('persists via upsert in override mode', async () => {
    process.env.SHOPIFY_API_KEY = DEV_APP_CLIENT_ID;
    await setDevForcedPlan(SHOP, 'basic');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shop: SHOP },
        update: { devForcedPlan: 'basic' },
        create: { shop: SHOP, devForcedPlan: 'basic' },
      }),
    );
  });

  it('refuses (throws) outside override mode — never writes in public build', async () => {
    process.env.SHOPIFY_API_KEY = PUBLIC_APP_CLIENT_ID;
    await expect(setDevForcedPlan(SHOP, 'pro')).rejects.toThrow(/refused/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
