/**
 * priceCall cache/batch factors and the cache columns of the ledger
 * (PLAN_BULK_TRANSLATE_BATCHING §3.6). Unknown factor = 1.0 (over-count).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUpsert, mockTaskUpdateMany } = vi.hoisted(() => ({
  mockUpsert: vi.fn().mockResolvedValue({}),
  mockTaskUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
}));
vi.mock('~/db.server', () => ({
  db: { aiUsageCounter: { upsert: mockUpsert, findMany: vi.fn() }, task: { updateMany: mockTaskUpdateMany } },
}));
vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

import { recordAiUsage } from '~/services/ai/usage-meter.server';
import { priceCall, priceForModel, MODEL_PRICING, clampMicros } from '~/config/ai-pricing';
import type { AIProvider } from '~/utils/api-key-validation';

beforeEach(() => vi.clearAllMocks());

/** The historic implementation, verbatim, as the regression oracle. */
function legacy(provider: AIProvider, model: string, i: number, o: number) {
  const { price: p } = priceForModel(provider, model);
  if (!p) return 0;
  return clampMicros(
    Math.ceil((Math.max(0, i) * p.inMicrosPerMToken) / 1_000_000 + (Math.max(0, o) * p.outMicrosPerMToken) / 1_000_000),
  );
}

describe('priceCall with all factors 1.0', () => {
  it('is byte-identical to the historic formula over the whole table and unknown models', () => {
    const sizes = [0, 1, 7, 333, 4096, 123456, 9_999_999];
    for (const provider of Object.keys(MODEL_PRICING) as AIProvider[]) {
      for (const model of [...Object.keys(MODEL_PRICING[provider]), 'unknown-model-x']) {
        for (const i of sizes) for (const o of sizes) {
          expect(priceCall(provider, model, i, o).costMicros).toBe(legacy(provider, model, i, o));
          expect(priceCall(provider, model, i, o, {}).costMicros).toBe(legacy(provider, model, i, o));
          // Cache tokens with unknown (1.0) factors cost the same as plain input.
          expect(
            priceCall(provider, model, i, o, { cacheReadTokens: Math.floor(i / 2), cacheWriteTokens: Math.floor(i / 4) }).costMicros,
          ).toBe(legacy(provider, model, i, o));
          expect(priceCall(provider, model, i, o, { tier: 'batch' }).costMicros).toBe(legacy(provider, model, i, o));
        }
      }
    }
  });
});

describe('priceCall factors', () => {
  const base = () => priceCall('claude', 'claude-sonnet-5', 1_000_000, 1_000_000).costMicros;

  it('applies cache read/write multipliers to their parts only', () => {
    const { price: p } = priceForModel('claude', 'claude-sonnet-5');
    const c = priceCall('claude', 'claude-sonnet-5', 1_000_000, 0, {
      cacheReadTokens: 400_000, cacheWriteTokens: 100_000,
      factors: { cacheReadMult: 0.1, cacheWriteMult: 1.25 },
    }).costMicros;
    const expected = Math.ceil(p!.inMicrosPerMToken * (0.5 + 0.4 * 0.1 + 0.1 * 1.25));
    expect(c).toBe(expected);
  });

  it('batch factor hits only the non-cache components', () => {
    const { price: p } = priceForModel('claude', 'claude-sonnet-5');
    const c = priceCall('claude', 'claude-sonnet-5', 1_000_000, 1_000_000, {
      tier: 'batch', cacheReadTokens: 500_000, factors: { batchMult: 0.5, cacheReadMult: 0.1 },
    }).costMicros;
    const expected = Math.ceil(0.5 * (p!.inMicrosPerMToken * 0.5 + p!.outMicrosPerMToken) + p!.inMicrosPerMToken * 0.5 * 0.1);
    expect(c).toBe(expected);
    expect(c).toBeLessThan(base());
  });

  it('batchMult is ignored on the standard tier; garbage factors fall back to 1.0', () => {
    expect(priceCall('claude', 'claude-sonnet-5', 1000, 1000, { factors: { batchMult: 0.5 } }).costMicros).toBe(
      priceCall('claude', 'claude-sonnet-5', 1000, 1000).costMicros,
    );
    expect(
      priceCall('claude', 'claude-sonnet-5', 1000, 1000, { tier: 'batch', factors: { batchMult: NaN } }).costMicros,
    ).toBe(priceCall('claude', 'claude-sonnet-5', 1000, 1000).costMicros);
    expect(
      priceCall('claude', 'claude-sonnet-5', 1000, 1000, { tier: 'batch', factors: { batchMult: 0 } }).costMicros,
    ).toBe(priceCall('claude', 'claude-sonnet-5', 1000, 1000).costMicros);
  });

  it('cache parts above the input total are clamped, never priced twice', () => {
    const a = priceCall('claude', 'claude-sonnet-5', 1000, 0, { cacheReadTokens: 5000, cacheWriteTokens: 5000 });
    expect(a.costMicros).toBe(priceCall('claude', 'claude-sonnet-5', 1000, 0).costMicros);
  });
});

describe('recordAiUsage cache fields', () => {
  const baseInput = {
    shop: 's.myshopify.com', provider: 'claude' as const, model: 'claude-sonnet-5', feature: 'adhoc',
    source: 'byo' as const, estimated: false,
  };

  it('persists cache tokens in create and update; totals stay the sum', async () => {
    await recordAiUsage({ ...baseInput, inputTokens: 4600, outputTokens: 10, cacheReadTokens: 4000, cacheWriteTokens: 500, taskId: 't1' });
    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.create.inputTokens).toBe(4600n);
    expect(arg.create.cacheReadTokens).toBe(4000n);
    expect(arg.create.cacheWriteTokens).toBe(500n);
    expect(arg.update.cacheReadTokens).toEqual({ increment: 4000n });
    expect(arg.update.cacheWriteTokens).toEqual({ increment: 500n });
    expect(mockTaskUpdateMany.mock.calls[0][0].data.inputTokens).toEqual({ increment: 4600 });
  });

  it('defaults to 0 and clamps parts to the input total', async () => {
    await recordAiUsage({ ...baseInput, inputTokens: 100, outputTokens: 1 });
    expect(mockUpsert.mock.calls[0][0].create.cacheReadTokens).toBe(0n);
    await recordAiUsage({ ...baseInput, inputTokens: 100, outputTokens: 1, cacheReadTokens: 900, cacheWriteTokens: 900 });
    const c = mockUpsert.mock.calls[1][0].create;
    expect(c.cacheReadTokens).toBe(100n);
    expect(c.cacheWriteTokens).toBe(0n);
  });

  it('cost with no cache tokens equals the legacy cost', async () => {
    const r = await recordAiUsage({ ...baseInput, inputTokens: 12345, outputTokens: 678 });
    expect(r.costMicros).toBe(legacy('claude', 'claude-sonnet-5', 12345, 678));
  });
});

describe('priceCall: cache split never costs less than the historic formula at factor 1', () => {
  it('equals the legacy price for any cache split when every factor is 1', () => {
    for (const provider of Object.keys(MODEL_PRICING) as AIProvider[]) {
      for (const model of Object.keys(MODEL_PRICING[provider])) {
        for (const [i, o, r, w] of [
          [1, 1, 1, 0],
          [997, 13, 333, 333],
          [123_457, 9_876, 54_321, 1_234],
          [5, 0, 0, 5],
        ]) {
          expect(priceCall(provider, model, i, o, { cacheReadTokens: r, cacheWriteTokens: w }).costMicros).toBe(
            legacy(provider, model, i, o),
          );
        }
      }
    }
  });

  it('a NaN or negative cache value is treated as 0, never as a free call', () => {
    const provider = Object.keys(MODEL_PRICING)[0] as AIProvider;
    const model = Object.keys(MODEL_PRICING[provider])[0];
    const base = priceCall(provider, model, 10_000, 500).costMicros;
    expect(base).toBeGreaterThan(0);
    expect(priceCall(provider, model, 10_000, 500, { cacheReadTokens: Number.NaN }).costMicros).toBe(base);
    expect(priceCall(provider, model, 10_000, 500, { cacheWriteTokens: -5 }).costMicros).toBe(base);
    expect(priceCall(provider, model, Number.NaN, 500).costMicros).toBe(legacy(provider, model, 0, 500));
  });
});
