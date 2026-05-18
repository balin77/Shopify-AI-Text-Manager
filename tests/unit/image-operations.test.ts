/**
 * Unit Tests — monthly image-operation quota (Befund 3) + WebP-concurrency
 * single-source-of-truth drift guard (Befund 4).
 *
 *  - planUtils helpers: getMonthlyImageOperationsLimit, currentImageOpPeriod,
 *    isWithinImageOperationQuota (pure).
 *  - consumeImageOperations: atomic reserve with whole-batch semantics,
 *    period rollover, limit===0 always blocked (DB mocked, in-memory counter).
 *  - PLAN_CONFIG.maxConcurrentWebpConversions === PLAN_WEBP_CONCURRENCY for
 *    every plan (the hardcoded mirror in webp-processor.service.js was removed;
 *    both now read app/config/webp-concurrency.js).
 *
 * DB is fully mocked (plan-cache-cleanup.test.ts / billing.server.test.ts convention).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory counter store keyed by `${shop}|${period}`.
const { store, db } = vi.hoisted(() => {
  const store = new Map<string, { shop: string; period: string; count: number }>();
  const key = (shop: string, period: string) => `${shop}|${period}`;
  const counter = {
    upsert: vi.fn(async ({ where, create }: any) => {
      const { shop, period } = where.shop_period;
      const k = key(shop, period);
      if (!store.has(k)) store.set(k, { shop, period, count: create.count ?? 0 });
      return { ...store.get(k)! };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const { shop, period } = where.shop_period;
      const row = store.get(key(shop, period))!;
      row.count += data.count.increment;
      return { ...row };
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const { shop, period } = where.shop_period;
      return store.get(key(shop, period)) ?? null;
    }),
  };
  const dbObj = {
    imageOperationCounter: counter,
    $transaction: vi.fn(async (cb: any) => cb(dbObj)),
  };
  return { store, db: dbObj };
});

vi.mock('../../app/db.server', () => ({ db }));
vi.mock('../../app/utils/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getMonthlyImageOperationsLimit,
  currentImageOpPeriod,
  isWithinImageOperationQuota,
} from '~/utils/planUtils';
import { consumeImageOperations, getImageOperationUsage } from '~/utils/imageOperations.server';
import { PLAN_CONFIG, type Plan } from '~/config/plans';
import { PLAN_WEBP_CONCURRENCY } from '~/config/webp-concurrency.js';

const ALL_PLANS: Plan[] = ['free', 'basic', 'pro', 'max'];

describe('image-operation quota — pure helpers', () => {
  it('Conservative per-tier caps: free/basic 0, pro 2000, max 10000', () => {
    expect(getMonthlyImageOperationsLimit('free')).toBe(0);
    expect(getMonthlyImageOperationsLimit('basic')).toBe(0);
    expect(getMonthlyImageOperationsLimit('pro')).toBe(2000);
    expect(getMonthlyImageOperationsLimit('max')).toBe(10000);
  });

  it('currentImageOpPeriod is UTC "YYYY-MM"', () => {
    expect(currentImageOpPeriod(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01');
    expect(currentImageOpPeriod(new Date(Date.UTC(2026, 11, 31, 23)))).toBe('2026-12');
  });

  it('isWithinImageOperationQuota: limit 0 (free/basic) always false', () => {
    expect(isWithinImageOperationQuota('free', 0, 1)).toBe(false);
    expect(isWithinImageOperationQuota('basic', 0, 1)).toBe(false);
  });

  it('isWithinImageOperationQuota: respects remaining headroom', () => {
    expect(isWithinImageOperationQuota('pro', 1999, 1)).toBe(true);
    expect(isWithinImageOperationQuota('pro', 2000, 1)).toBe(false);
    expect(isWithinImageOperationQuota('pro', 1999, 2)).toBe(false);
    expect(isWithinImageOperationQuota('max', 9000, 1000)).toBe(true);
  });
});

describe('consumeImageOperations — atomic reserve', () => {
  beforeEach(() => store.clear());

  it('free/basic (limit 0) is always blocked, no counter row created', async () => {
    const r = await consumeImageOperations('s1.myshopify.com', 'free', 1);
    expect(r).toEqual({ allowed: false, used: 0, limit: 0, remaining: 0 });
    expect(store.size).toBe(0);
  });

  it('pro: consumes within limit and accumulates', async () => {
    const a = await consumeImageOperations('s.myshopify.com', 'pro', 500);
    expect(a.allowed).toBe(true);
    expect(a.used).toBe(500);
    expect(a.remaining).toBe(1500);
    const b = await consumeImageOperations('s.myshopify.com', 'pro', 100);
    expect(b.allowed).toBe(true);
    expect(b.used).toBe(600);
  });

  it('whole-batch semantics: an over-limit batch is rejected and NOT partially charged', async () => {
    await consumeImageOperations('s.myshopify.com', 'pro', 1990);
    const over = await consumeImageOperations('s.myshopify.com', 'pro', 20); // 1990+20 > 2000
    expect(over.allowed).toBe(false);
    expect(over.used).toBe(1990); // unchanged
    expect(over.remaining).toBe(10);
    // exact remaining still fits
    const fit = await consumeImageOperations('s.myshopify.com', 'pro', 10);
    expect(fit.allowed).toBe(true);
    expect(fit.used).toBe(2000);
  });

  it('separate (shop, period) rows are independent', async () => {
    await consumeImageOperations('a.myshopify.com', 'pro', 2000);
    const other = await consumeImageOperations('b.myshopify.com', 'pro', 1);
    expect(other.allowed).toBe(true);
    expect(other.used).toBe(1);
  });

  it('getImageOperationUsage reflects consumed count for the current period', async () => {
    await consumeImageOperations('u.myshopify.com', 'max', 42);
    const usage = await getImageOperationUsage('u.myshopify.com');
    expect(usage.count).toBe(42);
    expect(usage.period).toBe(currentImageOpPeriod());
  });
});

describe('WebP-concurrency single source of truth (drift guard)', () => {
  it('PLAN_CONFIG.maxConcurrentWebpConversions matches PLAN_WEBP_CONCURRENCY for every plan', () => {
    for (const p of ALL_PLANS) {
      expect(PLAN_CONFIG[p].maxConcurrentWebpConversions).toBe(PLAN_WEBP_CONCURRENCY[p]);
    }
  });

  it('Pro→Max WebP concurrency is a real differentiator (max > pro)', () => {
    expect(PLAN_WEBP_CONCURRENCY.max).toBeGreaterThan(PLAN_WEBP_CONCURRENCY.pro);
    expect(PLAN_WEBP_CONCURRENCY.max).toBe(6);
  });
});
