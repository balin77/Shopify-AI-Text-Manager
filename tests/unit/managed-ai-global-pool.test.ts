/**
 * The GLOBAL cap on managed AI spend — PLAN_MANAGED_AI_KEY §9.3.
 *
 * Per-shop budgets bound what one merchant can cost us. They do not bound what
 * a BUG can — a meter that under-counts, a model priced at a guessed ceiling,
 * a webhook storm across every shop at once — and this is the outer ring whose
 * job is to make the worst case one configured month instead of an unbounded
 * invoice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFindUnique, mockUpsert } = vi.hoisted(() => ({
  mockFindUnique: vi.fn().mockResolvedValue(null),
  mockUpsert: vi.fn().mockResolvedValue({}),
}));

vi.mock('~/db.server', () => ({
  db: { managedAiGlobalCounter: { findUnique: mockFindUnique, upsert: mockUpsert } },
}));

const { mockError } = vi.hoisted(() => ({ mockError: vi.fn() }));
vi.mock('~/utils/logger.server', () => ({
  logger: { error: mockError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

import {
  globalPoolStatus,
  addGlobalPoolSpend,
  poolLimitMicros,
  alertIfPoolLow,
} from '~/services/ai/managed-global-pool.server';

const ENV = ['MANAGED_AI_POOL_MICROS', 'MANAGED_AI_TASTER_POOL_MICROS'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue(null);
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('an unconfigured pool is UNLIMITED, not blocked', () => {
  it('allows when no cap is set', async () => {
    // An operator who has not configured a pool has not asked for a cap, and a
    // cap nobody set must not silently stop a paying merchant's work.
    const status = await globalPoolStatus('paid', 'm:2026-09');
    expect(status.limitMicros).toBeNull();
    expect(status.allowed).toBe(true);
  });

  it('refuses a nonsense value rather than treating it as a cap', () => {
    process.env.MANAGED_AI_POOL_MICROS = 'lots';
    expect(poolLimitMicros('paid')).toBeNull();
    process.env.MANAGED_AI_POOL_MICROS = '-5';
    expect(poolLimitMicros('paid')).toBeNull();
  });
});

describe('the two pools are separate', () => {
  it('a spent TASTER pool does not stop a paying merchant', async () => {
    // With one pool, a listing spike of free installs spending their tasters
    // trips the cap on the 18th and 503s every paying merchant for the rest of
    // the month.
    process.env.MANAGED_AI_POOL_MICROS = '100000000';
    process.env.MANAGED_AI_TASTER_POOL_MICROS = '1000000';

    mockFindUnique.mockImplementation(async ({ where }) =>
      where.period_pool.pool === 'taster' ? { costMicros: BigInt(1_000_000) } : { costMicros: BigInt(10) },
    );

    expect((await globalPoolStatus('taster', 'm:2026-09')).allowed).toBe(false);
    expect((await globalPoolStatus('paid', 'm:2026-09')).allowed).toBe(true);
  });

  it('reads each pool under its own key', async () => {
    process.env.MANAGED_AI_TASTER_POOL_MICROS = '5';
    await globalPoolStatus('taster', 'm:2026-09');
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { period_pool: { period: 'm:2026-09', pool: 'taster' } },
      }),
    );
  });
});

describe('a failed read ALLOWS — the opposite of the per-shop rule', () => {
  it('does not stop every managed shop because one query timed out', async () => {
    // The per-shop budget refuses on unread evidence, which protects our money
    // against ONE shop. This refusing would stop every managed shop in the app,
    // while the per-shop budgets are still enforcing underneath.
    process.env.MANAGED_AI_POOL_MICROS = '1000000';
    mockFindUnique.mockRejectedValueOnce(new Error('timeout'));

    const status = await globalPoolStatus('paid', 'm:2026-09');
    expect(status.allowed).toBe(true);
    expect(mockError).toHaveBeenCalled();
  });
});

describe('recording spend', () => {
  it('increments in BigInt, and keeps the absorbed failover apart', async () => {
    // The gap between what the provider charged and what the merchant was
    // billed is what §3a rule 4's failover budget is measured against; folded
    // into the total, "what did the outage cost us" is unanswerable.
    await addGlobalPoolSpend('paid', 'm:2026-09', 1200, 900);

    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.update.costMicros).toEqual({ increment: BigInt(1200) });
    expect(arg.update.failoverMicros).toEqual({ increment: BigInt(900) });
  });

  it('writes nothing for a zero-cost call', async () => {
    await addGlobalPoolSpend('paid', 'm:2026-09', 0, 0);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('never throws — the call has already been made and paid for', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('db down'));
    await expect(addGlobalPoolSpend('paid', 'm:2026-09', 10)).resolves.toBeUndefined();
  });
});

describe('the alert fires before the wall, and once', () => {
  it('warns at half and not before', () => {
    alertIfPoolLow({ pool: 'paid', period: 'p1', spentMicros: 40, limitMicros: 100, allowed: true });
    expect(mockError).not.toHaveBeenCalled();

    alertIfPoolLow({ pool: 'paid', period: 'p1', spentMicros: 60, limitMicros: 100, allowed: true });
    expect(mockError).toHaveBeenCalledTimes(1);

    // Once per process per pool+period: a pool crossing 50% would otherwise
    // log on every AI call for the rest of the month.
    alertIfPoolLow({ pool: 'paid', period: 'p1', spentMicros: 90, limitMicros: 100, allowed: true });
    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it('says nothing about an unlimited pool', () => {
    alertIfPoolLow({ pool: 'paid', period: 'p2', spentMicros: 1e9, limitMicros: null, allowed: true });
    expect(mockError).not.toHaveBeenCalled();
  });
});
