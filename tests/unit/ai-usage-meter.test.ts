/**
 * The AI meter — PLAN_MANAGED_AI_KEY Phase 0.
 *
 * What is pinned here is the DIRECTION OF ERROR in every rule, not the
 * arithmetic: an unknown model must not be cheap, an unreported usage object
 * must not be zero, a bookkeeping failure must not reach the caller, the two
 * writes must report independently, and the ledger key must keep the
 * dimensions the measurement is supposed to be sliced by.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUpsert, mockTaskUpdateMany, mockFindMany } = vi.hoisted(() => ({
  mockUpsert: vi.fn().mockResolvedValue({}),
  mockTaskUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  mockFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock('~/db.server', () => ({
  db: {
    aiUsageCounter: { upsert: mockUpsert, findMany: mockFindMany },
    task: { updateMany: mockTaskUpdateMany },
  },
}));

const { mockWarn, mockError } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { warn: mockWarn, error: mockError, info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

import { recordAiUsage, currentAiUsagePeriod, getAiUsage } from '~/services/ai/usage-meter.server';
import {
  priceCall,
  priceForModel,
  MODEL_PRICING,
  UNKNOWN_MODEL_PRICE,
  UNPRICED_PROVIDERS,
  clampMicros,
} from '~/config/ai-pricing';
import type { AIProvider } from '~/utils/api-key-validation';
import { CURATED_MODELS } from '~/config/ai-models.config';
import { DEFAULT_MODELS } from '~/config/ai-models.config';

const CALL = {
  shop: 'demo.myshopify.com',
  provider: 'openai' as const,
  model: 'gpt-5-nano',
  feature: 'bulkTranslation',
  inputTokens: 1500,
  outputTokens: 700,
  source: 'byo' as const,
  estimated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsert.mockResolvedValue({});
  mockTaskUpdateMany.mockResolvedValue({ count: 1 });
  mockFindMany.mockResolvedValue([]);
});

describe('price table', () => {
  it('prices an UNKNOWN model at a STATED ceiling, not at the table maximum', () => {
    const unknown = priceForModel('claude', 'claude-whatever-next');
    expect(unknown.atCeiling).toBe(true);
    expect(unknown.price).toEqual(UNKNOWN_MODEL_PRICE.claude);

    // The distinction is the fix: the dearest TABLE entry is cheaper than the
    // dearest model the provider sells, so deriving the ceiling from the table
    // under-priced an unknown model — by 3x on Claude, which is a model this
    // app's own picker offers.
    const dearestEntry = Object.values(MODEL_PRICING.claude).reduce((worst, p) =>
      p.inMicrosPerMToken > worst.inMicrosPerMToken ? p : worst,
    );
    expect(UNKNOWN_MODEL_PRICE.claude!.inMicrosPerMToken).toBeGreaterThanOrEqual(
      dearestEntry.inMicrosPerMToken,
    );
  });

  it('keeps the word "ceiling" true: no table entry exceeds its provider ceiling', () => {
    for (const [provider, models] of Object.entries(MODEL_PRICING) as [
      AIProvider,
      Record<string, { inMicrosPerMToken: number; outMicrosPerMToken: number }>,
    ][]) {
      const ceiling = UNKNOWN_MODEL_PRICE[provider];
      for (const [id, p] of Object.entries(models)) {
        expect(ceiling, `${provider} has priced models but no ceiling`).not.toBeNull();
        expect(p.inMicrosPerMToken, `${provider}/${id} input above ceiling`).toBeLessThanOrEqual(
          ceiling!.inMicrosPerMToken,
        );
        expect(p.outMicrosPerMToken, `${provider}/${id} output above ceiling`).toBeLessThanOrEqual(
          ceiling!.outMicrosPerMToken,
        );
      }
    }
  });

  it('prices every model the app OFFERS — a curated id is not an unknown one', () => {
    // The ceiling is a bound for a model nobody predicted. A model in our own
    // dropdown is predicted, and pricing it at a guess (3x low for Opus 4,
    // 15x high for grok-4-fast) corrupts the very average Phase 0 measures.
    for (const [provider, models] of Object.entries(CURATED_MODELS) as [
      AIProvider,
      { id: string }[],
    ][]) {
      if (UNPRICED_PROVIDERS.has(provider)) continue;
      for (const { id } of models) {
        expect(
          priceForModel(provider, id).atCeiling,
          `${provider}/${id} is offered by the app but missing from MODEL_PRICING`,
        ).toBe(false);
      }
    }
    // And the model a shop gets when it picks nothing at all.
    for (const [provider, id] of Object.entries(DEFAULT_MODELS) as [AIProvider, string][]) {
      if (UNPRICED_PROVIDERS.has(provider)) continue;
      expect(
        priceForModel(provider, id).atCeiling,
        `${provider}'s DEFAULT model ${id} is missing from MODEL_PRICING`,
      ).toBe(false);
    }
  });

  it('asks the unpriced set FIRST, so one price entry cannot silently re-price it', () => {
    for (const provider of UNPRICED_PROVIDERS) {
      expect(priceForModel(provider, 'anything').price).toBeNull();
      expect(priceCall(provider, 'anything', 5000, 5000).unpriced).toBe(true);
      expect(priceCall(provider, 'anything', 5000, 5000).costMicros).toBe(0);
    }
  });

  it('rounds a fractional cost UP, in both functions that round', () => {
    expect(priceCall('openai', 'gpt-5-nano', 1, 0).costMicros).toBe(1);
    // clampMicros used to round to NEAREST, which turned a billed 0.4 into 0.
    expect(clampMicros(0.4)).toBe(1);
    expect(clampMicros(-5)).toBe(0);
    expect(clampMicros(Number.NaN)).toBe(0);
  });
});

describe('recordAiUsage', () => {
  it('keys the row by every dimension the measurement is sliced by', async () => {
    await recordAiUsage(CALL);

    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.where.shop_period_source_provider_model_feature_estimated).toEqual({
      shop: 'demo.myshopify.com',
      period: expect.stringMatching(/^m:\d{4}-\d{2}$/),
      source: 'byo',
      provider: 'openai',
      model: 'gpt-5-nano',
      feature: 'bulkTranslation',
      estimated: false,
    });
  });

  it('INCREMENTS rather than writing a computed total, in BigInt for the volumes', async () => {
    await recordAiUsage(CALL);

    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.update.calls).toEqual({ increment: 1 });
    expect(arg.update.inputTokens).toEqual({ increment: BigInt(1500) });
    expect(typeof arg.update.costMicros.increment).toBe('bigint');
    expect(arg.update.costMicros.increment).toBeGreaterThan(BigInt(0));
  });

  it('separates an ESTIMATED call into its own row instead of blending it', async () => {
    await recordAiUsage({ ...CALL, estimated: true });
    const key = mockUpsert.mock.calls[0][0].where
      .shop_period_source_provider_model_feature_estimated;
    expect(key.estimated).toBe(true);
    // The tokens are recorded, never zeroed.
    expect(mockUpsert.mock.calls[0][0].create.inputTokens).toBe(BigInt(1500));
  });

  it('meters an UNPRICED provider: tokens counted, cost zero', async () => {
    const res = await recordAiUsage({
      ...CALL,
      provider: 'huggingface',
      model: 'some/model',
    });

    expect(res.costMicros).toBe(0);
    expect(mockUpsert.mock.calls[0][0].create.inputTokens).toBe(BigInt(1500));
  });

  it('bills what it costs unless told otherwise, and keeps the two apart when it is', async () => {
    const plain = await recordAiUsage({ ...CALL, source: 'managed', inputTokens: 1000, outputTokens: 1000 });
    expect(plain.billedMicros).toBe(plain.costMicros);

    mockUpsert.mockClear();
    const failover = await recordAiUsage({
      ...CALL,
      provider: 'claude',
      model: 'claude-haiku-4-5',
      source: 'managed',
      inputTokens: 1000,
      outputTokens: 1000,
      failover: true,
      billedMicros: plain.costMicros,
    });
    // The failover really is the expensive one, and the merchant is not charged
    // for it: that gap is the number §3a's failover pool is measured against.
    expect(failover.costMicros).toBeGreaterThan(failover.billedMicros);
    expect(failover.billedMicros).toBe(plain.costMicros);
    expect(mockUpsert.mock.calls[0][0].update.failoverCalls).toEqual({ increment: 1 });
  });

  it('warns ONCE per unknown model, not once per call', async () => {
    await recordAiUsage({ ...CALL, model: 'gpt-6-unreleased' });
    await recordAiUsage({ ...CALL, model: 'gpt-6-unreleased' });
    await recordAiUsage({ ...CALL, model: 'gpt-6-unreleased' });

    const hits = mockWarn.mock.calls.filter((c) => String(c[0]).includes('gpt-6-unreleased'));
    expect(hits).toHaveLength(1);
  });

  it('NEVER throws when the ledger write fails — the generation already succeeded', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('connection reset'));

    const res = await recordAiUsage(CALL);

    expect(res.ledgerWritten).toBe(false);
    expect(mockError).toHaveBeenCalled();
  });

  it('a failed TASK write does not report the ledger row as unwritten', async () => {
    // One try over both statements said "nothing was written" about a row that
    // had been incremented — the shape that makes a retry double-charge.
    mockTaskUpdateMany.mockRejectedValueOnce(new Error('integer out of range'));

    const res = await recordAiUsage({ ...CALL, taskId: 'task-1' });

    expect(res.ledgerWritten).toBe(true);
    expect(res.taskWritten).toBe(false);
  });

  it('adds a task run total with updateMany, so an expired task row cannot throw', async () => {
    const res = await recordAiUsage({ ...CALL, taskId: 'task-1' });

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: {
        inputTokens: { increment: 1500 },
        outputTokens: { increment: 700 },
        costMicros: { increment: expect.any(Number) },
      },
    });
    expect(res.taskWritten).toBe(true);
  });

  it('reports "no task" as null rather than as a failure', async () => {
    const res = await recordAiUsage(CALL);
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(res.taskWritten).toBeNull();
  });

  it('refuses garbage token counts instead of storing them', async () => {
    await recordAiUsage({ ...CALL, inputTokens: Number.NaN, outputTokens: -42 });
    const create = mockUpsert.mock.calls[0][0].create;
    expect(create.inputTokens).toBe(BigInt(0));
    expect(create.outputTokens).toBe(BigInt(0));
  });
});

describe('period key', () => {
  it('is the UTC month, so a shop east of Greenwich does not get two', () => {
    expect(currentAiUsagePeriod(new Date('2026-01-31T23:30:00Z'))).toBe('m:2026-01');
    expect(currentAiUsagePeriod(new Date('2026-02-01T00:30:00Z'))).toBe('m:2026-02');
  });

  it('names its SCHEME, so Phase 2 billing periods cannot be read as months', () => {
    expect(currentAiUsagePeriod()).toMatch(/^m:/);
  });
});

describe('getAiUsage', () => {
  it('hands back rows, not a blend, and converts BigInt at the boundary', async () => {
    mockFindMany.mockResolvedValueOnce([
      {
        source: 'byo',
        provider: 'openai',
        model: 'gpt-5-nano',
        feature: 'bulkTranslation',
        estimated: false,
        calls: 3,
        failoverCalls: 0,
        inputTokens: BigInt(4500),
        outputTokens: BigInt(2100),
        costMicros: BigInt(1200),
        billedMicros: BigInt(1200),
      },
      { source: 'nonsense', provider: 'x', model: 'y', feature: 'z', estimated: false, calls: 9, failoverCalls: 0, inputTokens: BigInt(1), outputTokens: BigInt(1), costMicros: BigInt(1), billedMicros: BigInt(1) },
    ]);

    const rows = await getAiUsage('demo.myshopify.com', 'm:2026-09');

    expect(rows).toHaveLength(1);
    expect(rows[0].feature).toBe('bulkTranslation');
    expect(typeof rows[0].inputTokens).toBe('number');
    expect(rows[0].inputTokens).toBe(4500);
    // No BigInt escapes: these values are JSON-serialised by every caller.
    expect(() => JSON.stringify(rows)).not.toThrow();
  });
});
