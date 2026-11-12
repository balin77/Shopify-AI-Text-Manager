/**
 * Batch reservations (PLAN_BULK_TRANSLATE_BATCHING 19.5): a hold written at
 * submit in BOTH counters, turned into a charge or removed when the batch
 * settles -- idempotent per batch row, never below zero, filed under the
 * period and pool PINNED AT SUBMIT -- and counted by exactly the readers that
 * should count it:
 *
 *   (a) managedBudgetStatus  -- sums billedMicros of the open period: counts it
 *   (b) globalPoolStatus     -- reads the pool counter's costMicros:  counts it
 *   (c) cost reports / settings card / getAiUsage -- never as cost or as calls
 *
 * The db is an in-memory fake that implements the statements the module uses
 * (including the clamped raw UPDATEs), with transaction rollback, so the test
 * exercises the real writes and the real readers rather than a call log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type UsageRow = {
  shop: string; period: string; source: string; provider: string; model: string; feature: string; estimated: boolean;
  calls: number; failoverCalls: number; inputTokens: bigint; outputTokens: bigint; cacheReadTokens: bigint; cacheWriteTokens: bigint;
  costMicros: bigint; billedMicros: bigint;
};
type PoolRow = { period: string; pool: string; costMicros: bigint; failoverMicros: bigint };

const h = vi.hoisted(() => ({
  batches: new Map<string, any>(),
  usage: new Map<string, any>(),
  pool: new Map<string, any>(),
  failPoolUpsert: false,
}));

const usageKey = (k: any) => [k.shop, k.period, k.source, k.provider, k.model, k.feature, k.estimated].join('|');
const poolKey = (period: string, pool: string) => `${period}|${pool}`;

function clone<T>(m: Map<string, T>): Map<string, T> {
  return new Map([...m].map(([k, v]) => [k, { ...(v as object) } as T]));
}

/** `{ period }` / `{ period: { startsWith, gt } }` -- the shapes usedPeriodsFilter emits. */
function periodMatches(row: UsageRow, cond: any): boolean {
  if (typeof cond === 'string') return row.period === cond;
  if (cond && typeof cond === 'object') {
    if (cond.startsWith && !row.period.startsWith(cond.startsWith)) return false;
    if (cond.gt && !(row.period > cond.gt)) return false;
    return true;
  }
  return true;
}
function usageMatches(row: UsageRow, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return (cond as any[]).some((w) => usageMatches(row, w));
    if (key === 'NOT') return !usageMatches(row, cond);
    if (key === 'period') return periodMatches(row, cond);
    if (key === 'feature' && cond?.endsWith) return row.feature.endsWith(cond.endsWith);
    return (row as any)[key] === cond;
  });
}

vi.mock('~/db.server', () => {
  const db: any = {
    bulkTranslateBatch: {
      findUnique: async ({ where }: any) => {
        const r = h.batches.get(where.id);
        return r ? { ...r } : null;
      },
      findMany: async ({ where, take }: any) =>
        [...h.batches.values()]
          .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
          .slice(0, take ?? 1000)
          .map((r) => ({ ...r })),
      updateMany: async ({ where, data }: any) => {
        const r = h.batches.get(where.id);
        if (!r || !Object.entries(where).every(([k, v]) => r[k] === v)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    aiUsageCounter: {
      upsert: async ({ where, create, update }: any) => {
        const k = where.shop_period_source_provider_model_feature_estimated;
        const key = usageKey(k);
        const existing = h.usage.get(key);
        if (!existing) {
          h.usage.set(key, {
            calls: 0, failoverCalls: 0, inputTokens: 0n, outputTokens: 0n, cacheReadTokens: 0n, cacheWriteTokens: 0n,
            costMicros: 0n, billedMicros: 0n, ...create,
          });
        } else {
          for (const [f, v] of Object.entries(update) as [string, any][]) {
            existing[f] = v && typeof v === 'object' && 'increment' in v ? existing[f] + v.increment : v;
          }
        }
        return {};
      },
      aggregate: async ({ where }: any) => {
        const rows = [...h.usage.values()].filter((r) => usageMatches(r, where));
        return { _sum: { billedMicros: rows.reduce((n, r) => n + r.billedMicros, 0n) } };
      },
      findMany: async ({ where }: any) => [...h.usage.values()].filter((r) => usageMatches(r, where ?? {})),
    },
    managedAiGlobalCounter: {
      upsert: async ({ where, create, update }: any) => {
        if (h.failPoolUpsert) throw new Error('pool down');
        const key = poolKey(where.period_pool.period, where.period_pool.pool);
        const existing = h.pool.get(key);
        if (!existing) h.pool.set(key, { ...create });
        else for (const [f, v] of Object.entries(update) as [string, any][]) existing[f] = existing[f] + v.increment;
        return {};
      },
      findUnique: async ({ where }: any) => {
        const r = h.pool.get(poolKey(where.period_pool.period, where.period_pool.pool));
        return r ? { costMicros: r.costMicros } : null;
      },
    },
    // The clamped raw UPDATEs: GREATEST(x - amount, 0) on the one row they name.
    $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join('?');
      expect(sql).toContain('GREATEST(');
      if (sql.includes('"AiUsageCounter"')) {
        const [amount, shop, period, source, provider, model, feature] = values;
        const row = h.usage.get(usageKey({ shop, period, source, provider, model, feature, estimated: true }));
        if (!row) return 0;
        row.billedMicros = row.billedMicros - amount > 0n ? row.billedMicros - amount : 0n;
        return 1;
      }
      const [amount, period, pool] = values;
      const row = h.pool.get(poolKey(period, pool));
      if (!row) return 0;
      row.costMicros = row.costMicros - amount > 0n ? row.costMicros - amount : 0n;
      return 1;
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const snap = { b: clone(h.batches), u: clone(h.usage), p: clone(h.pool) };
      try {
        return await fn(db);
      } catch (error) {
        h.batches = snap.b;
        h.usage = snap.u;
        h.pool = snap.p;
        throw error;
      }
    },
  };
  return { db };
});

vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

import {
  reserveBudget,
  releaseBudget,
  convertReservation,
  releaseSettledReservations,
  settleBatchUsage,
  getAiUsage,
  isReservedFeature,
  reservedFeature,
  BATCH_RESERVATION_FEATURE,
} from '~/services/ai/usage-meter.server';
import { managedBudgetStatus } from '~/services/ai/managed-budget.server';
import { globalPoolStatus, globalPoolPeriod } from '~/services/ai/managed-global-pool.server';
import { managedBudgetMicros } from '~/config/managed-ai-budget';

const SHOP = 'demo.myshopify.com';
const PERIOD_END = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
const BILLING_PERIOD = `b:${PERIOD_END.toISOString().slice(0, 10)}`;

const batchRow = (over: Record<string, unknown> = {}) => ({
  id: 'batch-1',
  taskId: 'task-1',
  shop: SHOP,
  state: 'waiting',
  provider: 'claude',
  model: 'claude-haiku-4-5',
  source: 'managed',
  role: 'default',
  period: BILLING_PERIOD,
  pool: 'paid',
  poolPeriod: globalPoolPeriod(),
  reservedMicros: 0,
  reservedPoolMicros: 0,
  reservationState: 'none',
  ...over,
});

const reservedUsageKey = (over: Record<string, unknown> = {}) =>
  usageKey({
    shop: SHOP, period: BILLING_PERIOD, source: 'managed', provider: 'claude', model: 'claude-haiku-4-5',
    feature: reservedFeature(BATCH_RESERVATION_FEATURE), estimated: true, ...over,
  });
const chargeUsageKey = () => reservedUsageKey({ feature: BATCH_RESERVATION_FEATURE });
const poolRow = () => h.pool.get(poolKey(globalPoolPeriod(), 'paid'));

const settings = () =>
  ({
    managedAiActive: true,
    managedAiPeriodEnd: PERIOD_END,
    subscriptionIsTest: false,
    partnerDevelopment: false,
    trialConsumedAt: null,
  }) as never;

const ENV = ['MANAGED_AI_POOL_MICROS', 'MANAGED_AI_TASTER_POOL_MICROS', 'SHOPIFY_API_KEY', 'APP_ENV', 'MANAGED_AI_ALLOW_DEV_BUILD'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  h.batches = new Map();
  h.usage = new Map();
  h.pool = new Map();
  h.failPoolUpsert = false;
  h.batches.set('batch-1', batchRow());
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('reserveBudget writes BOTH counters, billedMicros only', () => {
  it('holds the amount on the :reserved usage row (no cost, no calls) and on the pool counter, under the keys pinned at submit', async () => {
    expect(await reserveBudget('batch-1', { billedMicros: 5_000_000 })).toEqual({ applied: true, micros: 5_000_000 });

    const reserved = h.usage.get(reservedUsageKey());
    expect(reserved.billedMicros).toBe(5_000_000n);
    expect(reserved.costMicros).toBe(0n); // a hold is not an expense
    expect(reserved.calls).toBe(0); // and not a call
    expect(reserved.estimated).toBe(true);
    expect(poolRow().costMicros).toBe(5_000_000n);
    expect(h.batches.get('batch-1')).toMatchObject({ reservationState: 'held', reservedMicros: 5_000_000, reservedPoolMicros: 5_000_000 });
  });

  it('files the hold under the PINNED period and pool, not under whatever is current now', async () => {
    h.batches.set('batch-1', batchRow({ period: 'b:2031-03-14', pool: 'taster', poolPeriod: 'm:2031-03' }));
    await reserveBudget('batch-1', { billedMicros: 1_000 });
    expect(h.usage.get(reservedUsageKey({ period: 'b:2031-03-14' })).billedMicros).toBe(1_000n);
    expect(h.pool.get(poolKey('m:2031-03', 'taster')).costMicros).toBe(1_000n);
    expect(poolRow()).toBeUndefined(); // nothing under the current month
  });

  it('is idempotent per batch row: a second reserve changes nothing', async () => {
    await reserveBudget('batch-1', { billedMicros: 5_000_000 });
    expect(await reserveBudget('batch-1', { billedMicros: 5_000_000 })).toEqual({ applied: false, reason: 'already' });
    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(5_000_000n);
    expect(poolRow().costMicros).toBe(5_000_000n);
  });

  it('an own-key (byo) run reserves nothing; nonsense amounts and unknown batches are values, not throws', async () => {
    h.batches.set('byo', batchRow({ id: 'byo', source: 'byo' }));
    expect(await reserveBudget('byo', { billedMicros: 1000 })).toEqual({ applied: false, reason: 'byo' });
    expect(await reserveBudget('batch-1', { billedMicros: -5 })).toEqual({ applied: false, reason: 'zero' });
    expect(await reserveBudget('batch-1', { billedMicros: Number.NaN })).toEqual({ applied: false, reason: 'zero' });
    expect(await reserveBudget('nope', { billedMicros: 1000 })).toEqual({ applied: false, reason: 'noBatch' });
    expect(h.usage.size).toBe(0);
    expect(h.pool.size).toBe(0);
  });

  it('a failure in the second counter rolls the whole reservation back (state included)', async () => {
    h.failPoolUpsert = true;
    expect(await reserveBudget('batch-1', { billedMicros: 5_000_000 })).toEqual({ applied: false, reason: 'failed' });
    expect(h.batches.get('batch-1').reservationState).toBe('none');
    expect(h.usage.size).toBe(0);
    // ... and the next attempt can still reserve
    h.failPoolUpsert = false;
    expect((await reserveBudget('batch-1', { billedMicros: 5_000_000 })).applied).toBe(true);
  });
});

describe('reserveBudget refuses a row whose keys are not pinned (M3)', () => {
  it.each([
    ['an empty period', { period: '' }],
    ['an empty poolPeriod', { poolPeriod: '' }],
    ['an empty pool', { pool: '' }],
    ['a pool that is neither paid nor taster', { pool: 'something' }],
  ])('%s: nothing is written anywhere, the row stays "none"', async (_label, over) => {
    h.batches.set('batch-1', batchRow(over));
    const out = await reserveBudget('batch-1', { billedMicros: 500 });
    expect(out).toEqual({ applied: false, reason: 'unpinned' });
    expect(h.usage.size).toBe(0);
    expect(h.pool.size).toBe(0);
    expect(h.batches.get('batch-1').reservationState).toBe('none');
  });

  it('a taster row with all keys pinned still reserves', async () => {
    h.batches.set('batch-1', batchRow({ pool: 'taster' }));
    expect(await reserveBudget('batch-1', { billedMicros: 500 })).toEqual({ applied: true, micros: 500 });
  });
});

describe('the three readers', () => {
  it('(a) managedBudgetStatus counts the hold as used budget -- under the billing period the submit pinned', async () => {
    const limit = managedBudgetMicros('max');
    const hold = Math.floor(limit / 4);
    expect(hold).toBeGreaterThan(0);
    const before = await managedBudgetStatus(SHOP, settings(), 'max');
    expect(before.period).toBe(BILLING_PERIOD);
    expect(before.usedMicros).toBe(0);

    await reserveBudget('batch-1', { billedMicros: hold });
    const held = await managedBudgetStatus(SHOP, settings(), 'max');
    expect(held.usedMicros).toBe(hold);
    expect(held.remainingMicros).toBe(limit - hold);
    expect(held.allowed).toBe(true);

    // a hold that takes what is left makes the shop refuse the next call
    h.batches.set('big', batchRow({ id: 'big', taskId: 'task-big', model: 'claude-sonnet-4-5' }));
    await reserveBudget('big', { billedMicros: limit });
    expect((await managedBudgetStatus(SHOP, settings(), 'max')).allowed).toBe(false);
  });

  it('(a) the hold is released back to the shop when the batch settles without a charge', async () => {
    await reserveBudget('batch-1', { billedMicros: 5_000_000 });
    await releaseBudget('batch-1');
    expect((await managedBudgetStatus(SHOP, settings(), 'max')).usedMicros).toBe(0);
  });

  it('(b) globalPoolStatus counts the hold against the pool of the month pinned at submit', async () => {
    process.env.MANAGED_AI_POOL_MICROS = '10000000';
    expect((await globalPoolStatus('paid')).spentMicros).toBe(0);
    await reserveBudget('batch-1', { billedMicros: 6_000_000 });
    const held = await globalPoolStatus('paid');
    expect(held.spentMicros).toBe(6_000_000);
    expect(held.allowed).toBe(true);

    h.batches.set('b2', batchRow({ id: 'b2', taskId: 'task-2' }));
    await reserveBudget('b2', { billedMicros: 4_000_000 });
    expect((await globalPoolStatus('paid')).allowed).toBe(false); // cap reached by holds alone

    await releaseBudget('b2');
    expect((await globalPoolStatus('paid')).allowed).toBe(true);
  });

  it('(c) getAiUsage flags the hold; it carries no cost and no calls, so no cost total can include it', async () => {
    await reserveBudget('batch-1', { billedMicros: 5_000_000 });
    const rows = await getAiUsage(SHOP, BILLING_PERIOD);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reserved: true, feature: 'bulkEditorTranslate:reserved', costMicros: 0, calls: 0, billedMicros: 5_000_000 });
    expect(isReservedFeature(rows[0].feature)).toBe(true);
    expect(isReservedFeature('bulkEditorTranslate')).toBe(false);
    // the cost a shop-overview style SUM sees is zero
    const cost = [...h.usage.values()].reduce((n, r) => n + r.costMicros, 0n);
    expect(cost).toBe(0n);
  });

  it('(c) the settings card computes its estimated share over calls with the hold excluded, and the report script splits it out', () => {
    const settingsRoute = readFileSync(join(__dirname, '..', '..', 'app/routes/app.settings.tsx'), 'utf8');
    expect(settingsRoute).toMatch(/NOT: \{ feature: \{ endsWith: ":reserved" \} \}/);
    const script = readFileSync(join(__dirname, '..', '..', 'scripts/ai-usage-report.mjs'), 'utf8');
    expect(script).toContain('endsWith(":reserved")');
    expect(script).toContain('reserved (held for waiting batches, not spent)');
  });
});

describe('releaseBudget', () => {
  it('removes the hold from both counters and is idempotent', async () => {
    await reserveBudget('batch-1', { billedMicros: 5_000_000 });
    expect(await releaseBudget('batch-1')).toEqual({ applied: true, micros: 5_000_000 });
    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(0n);
    expect(poolRow().costMicros).toBe(0n);
    expect(h.batches.get('batch-1').reservationState).toBe('released');

    expect(await releaseBudget('batch-1')).toEqual({ applied: false, reason: 'notHeld' });
    expect(await convertReservation('batch-1')).toEqual({ applied: false, reason: 'notHeld' });
    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(0n);
  });

  it('never goes below zero, however the counters came to disagree', async () => {
    await reserveBudget('batch-1', { billedMicros: 5_000_000 });
    // another path already shrank both counters below the hold
    h.usage.get(reservedUsageKey()).billedMicros = 1_000n;
    poolRow().costMicros = 2_000n;
    await releaseBudget('batch-1');
    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(0n);
    expect(poolRow().costMicros).toBe(0n);
  });

  it('a never-reserved batch has nothing to release', async () => {
    expect(await releaseBudget('batch-1')).toEqual({ applied: false, reason: 'notHeld' });
    expect(h.usage.size).toBe(0);
  });

  it("only takes back ITS hold: another batch's reservation stays", async () => {
    h.batches.set('b2', batchRow({ id: 'b2', taskId: 'task-2' }));
    await reserveBudget('batch-1', { billedMicros: 5_000_000 });
    await reserveBudget('b2', { billedMicros: 3_000_000 });
    await releaseBudget('batch-1');
    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(3_000_000n);
    expect(poolRow().costMicros).toBe(3_000_000n);
  });
});

describe('convertReservation books the hold AS the charge (consent withdrawn, PLAN 16)', () => {
  it('moves it from the :reserved row to the real feature row as billed AND cost; the pool already carries it', async () => {
    await reserveBudget('batch-1', { billedMicros: 5_000_000 });
    expect(await convertReservation('batch-1')).toEqual({ applied: true, micros: 5_000_000 });

    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(0n);
    const charge = h.usage.get(chargeUsageKey());
    expect(charge).toMatchObject({ billedMicros: 5_000_000n, costMicros: 5_000_000n, estimated: true, calls: 0 });
    // pool untouched by the conversion: the reservation WAS counted as cost there
    expect(poolRow().costMicros).toBe(5_000_000n);
    expect(h.batches.get('batch-1').reservationState).toBe('converted');

    // the shop's used budget did not move through the conversion
    expect((await managedBudgetStatus(SHOP, settings(), 'max')).usedMicros).toBe(5_000_000);
  });

  it('is idempotent: converting twice, or releasing after converting, books nothing more', async () => {
    await reserveBudget('batch-1', { billedMicros: 5_000_000 });
    await convertReservation('batch-1');
    expect(await convertReservation('batch-1')).toEqual({ applied: false, reason: 'notHeld' });
    expect(await releaseBudget('batch-1')).toEqual({ applied: false, reason: 'notHeld' });
    expect(h.usage.get(chargeUsageKey()).billedMicros).toBe(5_000_000n);
    expect(poolRow().costMicros).toBe(5_000_000n);
  });

  it('a conversion adds to a charge row that already exists (calls booked earlier are kept)', async () => {
    h.usage.set(chargeUsageKey(), {
      shop: SHOP, period: BILLING_PERIOD, source: 'managed', provider: 'claude', model: 'claude-haiku-4-5',
      feature: BATCH_RESERVATION_FEATURE, estimated: true, calls: 7, failoverCalls: 0, inputTokens: 1n, outputTokens: 1n,
      cacheReadTokens: 0n, cacheWriteTokens: 0n, costMicros: 100n, billedMicros: 100n,
    });
    await reserveBudget('batch-1', { billedMicros: 1_000 });
    await convertReservation('batch-1');
    expect(h.usage.get(chargeUsageKey())).toMatchObject({ calls: 7, billedMicros: 1_100n, costMicros: 1_100n });
  });
});

describe('convertReservation with bookMicros books PRO RATA and gives the rest back (PLAN 16 guiding rule)', () => {
  it('books the given share as billed AND cost, the pool keeps the same share, the rest of both holds goes back', async () => {
    await reserveBudget('batch-1', { billedMicros: 10_000_000 });
    expect(await convertReservation('batch-1', { bookMicros: 4_000_000 })).toEqual({ applied: true, micros: 4_000_000 });
    expect(h.usage.get(chargeUsageKey())).toMatchObject({ billedMicros: 4_000_000n, costMicros: 4_000_000n });
    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(0n);
    expect(poolRow().costMicros).toBe(4_000_000n);
    expect(h.batches.get('batch-1').reservationState).toBe('converted');
  });

  it('never books more than the hold; 0 is a release', async () => {
    await reserveBudget('batch-1', { billedMicros: 1_000 });
    expect(await convertReservation('batch-1', { bookMicros: 9_999_999 })).toEqual({ applied: true, micros: 1_000 });
    h.batches.set('b2', batchRow({ id: 'b2', taskId: 't2' }));
    await reserveBudget('b2', { billedMicros: 1_000 });
    expect(await convertReservation('b2', { bookMicros: 0 })).toEqual({ applied: true, micros: 1_000 }); // all of it goes back
    expect(h.batches.get('b2').reservationState).toBe('released');
  });
});

describe('releaseSettledReservations (the sweep) follows the guiding rule, it does not simply release', () => {
  it('a done row that never named a batch is released (both tables); a waiting row is left alone', async () => {
    h.batches.set('done-row', batchRow({ id: 'done-row', taskId: 'task-d', state: 'waiting', batchIds: [] }));
    await reserveBudget('batch-1', { billedMicros: 5_000_000 }); // stays waiting
    await reserveBudget('done-row', { billedMicros: 2_000_000 });
    h.batches.get('done-row').state = 'done';

    expect(await releaseSettledReservations()).toEqual({ released: 1, converted: 0, failed: 0 });
    expect(h.batches.get('done-row').reservationState).toBe('released');
    expect(h.batches.get('batch-1').reservationState).toBe('held');
    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(5_000_000n);
    expect(poolRow().costMicros).toBe(5_000_000n);

    // a second sweep finds nothing
    expect(await releaseSettledReservations()).toEqual({ released: 0, converted: 0, failed: 0 });
  });

  it('a done row that NAMES a batch may have run: its hold becomes the charge (the upper bound), never a release', async () => {
    h.batches.set('ran', batchRow({ id: 'ran', taskId: 'task-r', batchIds: ['msgbatch_1'] }));
    await reserveBudget('ran', { billedMicros: 2_000_000 });
    h.batches.get('ran').state = 'done';
    expect(await releaseSettledReservations()).toEqual({ released: 0, converted: 1, failed: 0 });
    expect(h.batches.get('ran').reservationState).toBe('converted');
    expect(h.usage.get(chargeUsageKey())).toMatchObject({ billedMicros: 2_000_000n, costMicros: 2_000_000n });
    expect(poolRow().costMicros).toBe(2_000_000n);
  });
});

describe('settleBatchUsage books the ACTUAL usage and settles the hold in one idempotent step', () => {
  const ITEMS = [
    { provider: 'claude' as const, model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 500_000, estimated: false },
    { provider: 'claude' as const, model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 500_000, estimated: false },
  ];
  // haiku-4-5: 1.0 / 5.0 USD per M tokens, batch factor 0.5 on both -> a known, nonzero charge
  const charge = () => h.usage.get(chargeUsageKey().replace('|true', '|false'));

  it('moves the hold to the real feature row at the BATCH tier (billed = cost) and swaps the pool hold for the spend', async () => {
    await reserveBudget('batch-1', { billedMicros: 10_000_000 });
    const out = await settleBatchUsage('batch-1', ITEMS);
    expect(out.applied).toBe(true);
    if (!out.applied) return;
    // 2 requests x (1M in + 0.5M out) at half price: 2 x 0.5 x (1.0 + 2.5) USD = 3.5 USD
    expect(out.calls).toBe(2);
    expect(out.costMicros).toBeGreaterThan(3_000_000);
    expect(out.costMicros).toBeLessThan(3_500_000);
    expect(out.billedMicros).toBe(out.costMicros);
    expect(charge()).toMatchObject({ calls: 2, inputTokens: 2_000_000n, outputTokens: 1_000_000n, costMicros: BigInt(out.costMicros), billedMicros: BigInt(out.costMicros) });
    // the hold is gone from the :reserved row, the pool carries the spend instead of the hold
    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(0n);
    expect(poolRow().costMicros).toBe(BigInt(out.costMicros));
    expect(h.batches.get('batch-1').reservationState).toBe('released');
  });

  it('is idempotent: a second booking of the same batch writes nothing', async () => {
    await reserveBudget('batch-1', { billedMicros: 10_000_000 });
    await settleBatchUsage('batch-1', ITEMS);
    const before = JSON.stringify([...h.usage], (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(await settleBatchUsage('batch-1', ITEMS)).toEqual({ applied: false, reason: 'alreadySettled' });
    expect(JSON.stringify([...h.usage], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(before);
  });

  it('L3: the batch discount only applies to results the provider says ran in the batch tier; anything else is priced standard', async () => {
    await reserveBudget('batch-1', { billedMicros: 10_000_000 });
    const out = await settleBatchUsage('batch-1', [
      { ...ITEMS[0], tier: 'batch' },
      { ...ITEMS[1], tier: 'standard' },
    ]);
    expect(out.applied).toBe(true);
    if (!out.applied) return;
    // dearer than two batch-tier requests (< 3.5 USD), cheaper than two standard ones (7 USD)
    expect(out.costMicros).toBeGreaterThan(4_000_000);
    expect(out.costMicros).toBeLessThan(5_500_000);
    expect(h.usage.size).toBeGreaterThanOrEqual(2); // reserved row + the charge row(s)
  });

  it('a hold that was converted (consent withdrawn) is never booked again', async () => {
    await reserveBudget('batch-1', { billedMicros: 10_000_000 });
    await convertReservation('batch-1');
    expect(await settleBatchUsage('batch-1', ITEMS)).toEqual({ applied: false, reason: 'alreadySettled' });
  });

  it('a managed row without a hold is not booked (it never reserved: nothing to settle against)', async () => {
    expect(await settleBatchUsage('batch-1', ITEMS)).toEqual({ applied: false, reason: 'alreadySettled' });
    expect(h.usage.size).toBe(0);
  });

  it('a lost lease rolls the whole booking back (state included)', async () => {
    await reserveBudget('batch-1', { billedMicros: 10_000_000 });
    h.batches.get('batch-1').leaseToken = 'holder-A';
    expect(await settleBatchUsage('batch-1', ITEMS, { leaseToken: 'holder-B' })).toEqual({ applied: false, reason: 'leaseLost' });
    expect(h.batches.get('batch-1').reservationState).toBe('held');
    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(10_000_000n);
    // the rightful holder can still book
    expect((await settleBatchUsage('batch-1', ITEMS, { leaseToken: 'holder-A' })).applied).toBe(true);
  });

  it('an own-key run books under the byo source, touches no pool and settles by the same marker', async () => {
    h.batches.set('byo', batchRow({ id: 'byo', source: 'byo', period: '', pool: '', poolPeriod: '' }));
    const out = await settleBatchUsage('byo', ITEMS);
    expect(out.applied).toBe(true);
    expect(h.pool.size).toBe(0);
    const rows = [...h.usage.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'byo', feature: BATCH_RESERVATION_FEATURE, calls: 2 });
    expect(await settleBatchUsage('byo', ITEMS)).toEqual({ applied: false, reason: 'alreadySettled' });
  });

  it('measured and estimated usage are keyed apart; an unknown batch is a value', async () => {
    await reserveBudget('batch-1', { billedMicros: 10_000_000 });
    await settleBatchUsage('batch-1', [ITEMS[0], { ...ITEMS[1], estimated: true }]);
    expect([...h.usage.values()].filter((r) => r.feature === BATCH_RESERVATION_FEATURE).map((r) => r.estimated).sort()).toEqual([false, true]);
    expect(await settleBatchUsage('nope', ITEMS)).toEqual({ applied: false, reason: 'noBatch' });
  });

  it('the hold may be smaller than the spend: the pool never goes below zero', async () => {
    await reserveBudget('batch-1', { billedMicros: 1_000 });
    const out = await settleBatchUsage('batch-1', ITEMS);
    expect(out.applied).toBe(true);
    expect(poolRow().costMicros >= 0n).toBe(true);
    expect(h.usage.get(reservedUsageKey()).billedMicros).toBe(0n);
  });
});

