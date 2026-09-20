/**
 * The AI meter — PLAN_MANAGED_AI_KEY Phase 0.
 *
 * What is pinned here is the DIRECTION OF ERROR in every rule, not the
 * arithmetic: an unknown model must not be free, an unreported usage object
 * must not be zero, a bookkeeping failure must not reach the caller, and the
 * counter must be incremented rather than read-modify-written.
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
  loggers: {
    ai: vi.fn(),
  },
}));

import { recordAiUsage, currentAiUsagePeriod, getAiUsage } from '~/services/ai/usage-meter.server';
import { priceCall, priceForModel, MODEL_PRICING, clampMicros } from '~/config/ai-pricing';

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsert.mockResolvedValue({});
  mockTaskUpdateMany.mockResolvedValue({ count: 1 });
  mockFindMany.mockResolvedValue([]);
});

describe('price table', () => {
  it('prices an UNKNOWN model at its provider ceiling, never at zero', () => {
    const known = priceCall('openai', 'gpt-5-nano', 1_000_000, 1_000_000);
    const unknown = priceCall('openai', 'gpt-9-does-not-exist-yet', 1_000_000, 1_000_000);

    expect(unknown.pricedAtCeiling).toBe(true);
    expect(unknown.costMicros).toBeGreaterThan(known.costMicros);

    // And it really is the most expensive entry, not merely "some" entry.
    const ceiling = Object.values(MODEL_PRICING.openai).reduce((worst, p) =>
      p.inMicrosPerMToken + p.outMicrosPerMToken >
      worst.inMicrosPerMToken + worst.outMicrosPerMToken
        ? p
        : worst,
    );
    expect(priceForModel('openai', 'gpt-9-does-not-exist-yet').price).toEqual(ceiling);
  });

  it('rounds a fractional cost UP — the direction that cannot understate a bill', () => {
    // One input token of the cheapest model is a small fraction of a micro-EUR.
    const tiny = priceCall('openai', 'gpt-5-nano', 1, 0);
    expect(tiny.costMicros).toBe(1);
  });

  it('counts an unpriced provider rather than inventing a euro figure', () => {
    const hf = priceCall('huggingface', 'anything', 5000, 5000);
    expect(hf.unpriced).toBe(true);
    expect(hf.costMicros).toBe(0);
    // ...but the tokens still reach the ledger — see the recording test below.
  });

  it('clamps at the Int32 ceiling instead of wrapping', () => {
    expect(clampMicros(Number.MAX_SAFE_INTEGER)).toBe(2_147_483_647);
    expect(clampMicros(-5)).toBe(0);
    expect(clampMicros(Number.NaN)).toBe(0);
  });
});

describe('recordAiUsage', () => {
  it('INCREMENTS the counter rather than writing a computed total', async () => {
    await recordAiUsage({
      shop: 'demo.myshopify.com',
      provider: 'openai',
      model: 'gpt-5-nano',
      inputTokens: 1500,
      outputTokens: 700,
      source: 'byo',
      estimated: false,
    });

    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.update.calls).toEqual({ increment: 1 });
    expect(arg.update.inputTokens).toEqual({ increment: 1500 });
    expect(arg.update.costMicros.increment).toBeGreaterThan(0);
    // No read-modify-write anywhere in the path.
    expect(arg.update.calls).not.toEqual(1);
  });

  it('records an ESTIMATED call as estimated, and never as zero tokens', async () => {
    await recordAiUsage({
      shop: 'demo.myshopify.com',
      provider: 'claude',
      model: 'claude-haiku-4-5',
      inputTokens: 900,
      outputTokens: 300,
      source: 'byo',
      estimated: true,
    });

    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.create.estimatedCalls).toBe(1);
    expect(arg.update.estimatedCalls).toEqual({ increment: 1 });
    expect(arg.create.inputTokens).toBe(900);
  });

  it('meters an UNPRICED provider: tokens counted, cost zero', async () => {
    const res = await recordAiUsage({
      shop: 'demo.myshopify.com',
      provider: 'huggingface',
      model: 'some/model',
      inputTokens: 1200,
      outputTokens: 400,
      source: 'byo',
      estimated: false,
    });

    expect(res.costMicros).toBe(0);
    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.create.calls).toBe(1);
    expect(arg.create.inputTokens).toBe(1200);
  });

  it('bills what it costs unless told otherwise, and keeps the two apart when it is', async () => {
    const plain = await recordAiUsage({
      shop: 'demo.myshopify.com',
      provider: 'openai',
      model: 'gpt-5-nano',
      inputTokens: 1000,
      outputTokens: 1000,
      source: 'managed',
      estimated: false,
    });
    expect(plain.billedMicros).toBe(plain.costMicros);

    mockUpsert.mockClear();
    const failover = await recordAiUsage({
      shop: 'demo.myshopify.com',
      provider: 'claude',
      model: 'claude-haiku-4-5',
      inputTokens: 1000,
      outputTokens: 1000,
      source: 'managed',
      estimated: false,
      failover: true,
      billedMicros: plain.costMicros,
    });
    // The failover really is the expensive one, and the merchant is not charged
    // for it: that difference is the number §3a's failover budget is measured
    // against, and a single column could not express it.
    expect(failover.costMicros).toBeGreaterThan(failover.billedMicros);
    expect(failover.billedMicros).toBe(plain.costMicros);
    expect(mockUpsert.mock.calls[0][0].update.failoverCalls).toEqual({ increment: 1 });
  });

  it('warns about an unknown model so the table gets updated', async () => {
    await recordAiUsage({
      shop: 'demo.myshopify.com',
      provider: 'openai',
      model: 'gpt-6-unreleased',
      inputTokens: 10,
      outputTokens: 10,
      source: 'byo',
      estimated: false,
    });
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('gpt-6-unreleased'));
  });

  it('NEVER throws when the write fails — the generation already succeeded', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('integer out of range'));

    const res = await recordAiUsage({
      shop: 'demo.myshopify.com',
      provider: 'openai',
      model: 'gpt-5-nano',
      inputTokens: 10,
      outputTokens: 10,
      source: 'byo',
      estimated: false,
    });

    expect(res.recorded).toBe(false);
    expect(mockError).toHaveBeenCalled();
  });

  it('adds a task run total with updateMany, so an expired task row cannot throw', async () => {
    await recordAiUsage({
      shop: 'demo.myshopify.com',
      provider: 'openai',
      model: 'gpt-5-nano',
      inputTokens: 100,
      outputTokens: 50,
      source: 'byo',
      estimated: false,
      taskId: 'task-1',
    });

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: {
        inputTokens: { increment: 100 },
        outputTokens: { increment: 50 },
        costMicros: { increment: expect.any(Number) },
      },
    });
  });

  it('touches no task when there is none', async () => {
    await recordAiUsage({
      shop: 'demo.myshopify.com',
      provider: 'openai',
      model: 'gpt-5-nano',
      inputTokens: 100,
      outputTokens: 50,
      source: 'byo',
      estimated: false,
    });
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses garbage token counts instead of storing them', async () => {
    await recordAiUsage({
      shop: 'demo.myshopify.com',
      provider: 'openai',
      model: 'gpt-5-nano',
      inputTokens: Number.NaN,
      outputTokens: -42,
      source: 'byo',
      estimated: true,
    });
    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.create.inputTokens).toBe(0);
    expect(arg.create.outputTokens).toBe(0);
  });
});

describe('period key', () => {
  it('is the UTC month, so a shop east of Greenwich does not get two', () => {
    expect(currentAiUsagePeriod(new Date('2026-01-31T23:30:00Z'))).toBe('2026-01');
    expect(currentAiUsagePeriod(new Date('2026-02-01T00:30:00Z'))).toBe('2026-02');
  });
});

describe('getAiUsage', () => {
  it('answers with both sources, zero-filled, and ignores an unknown one', async () => {
    mockFindMany.mockResolvedValueOnce([
      { source: 'byo', calls: 3, estimatedCalls: 1, costMicros: 120, billedMicros: 120 },
      { source: 'nonsense', calls: 9, estimatedCalls: 9, costMicros: 9, billedMicros: 9 },
    ]);
    const usage = await getAiUsage('demo.myshopify.com', '2026-09');
    expect(usage.byo.calls).toBe(3);
    expect(usage.managed.calls).toBe(0);
  });
});
