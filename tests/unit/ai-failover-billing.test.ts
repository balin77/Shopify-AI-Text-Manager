/**
 * A failover must not shrink what the merchant bought — §3a rules 1 and 3.
 *
 * The fallback is roughly 14x the default's price. If the merchant's budget
 * were debited at what actually ran, an outage they did not cause and cannot
 * see would make their volume evaporate at 14x speed. So the ledger keeps TWO
 * numbers: `costMicros` is what we paid, `billedMicros` is what the merchant
 * was charged, and the gap — summed — is what the outage cost US, which is the
 * figure the global failover budget is measured against.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUpsert, mockPoolSpend } = vi.hoisted(() => ({
  mockUpsert: vi.fn().mockResolvedValue({}),
  mockPoolSpend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/db.server', () => ({
  db: {
    aiUsageCounter: { upsert: mockUpsert, findMany: vi.fn().mockResolvedValue([]) },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}));

vi.mock('~/services/ai/managed-global-pool.server', () => ({
  addGlobalPoolSpend: mockPoolSpend,
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

import { recordAiUsage } from '~/services/ai/usage-meter.server';
import { priceCall } from '~/config/ai-pricing';

const CALL = {
  shop: 'demo.myshopify.com',
  feature: 'bulkTranslation',
  inputTokens: 1500,
  outputTokens: 700,
  source: 'managed' as const,
  estimated: false,
  period: 'b:2026-10-14',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsert.mockResolvedValue({});
});

describe('a failover bills the DEFAULT model and costs the fallback', () => {
  it('debits the merchant at the default price, not the one that ran', async () => {
    const result = await recordAiUsage({
      ...CALL,
      provider: 'claude',
      model: 'claude-haiku-4-5',
      failover: true,
      billedProvider: 'openai',
      billedModel: 'gpt-5-nano',
    });

    const expectedCost = priceCall('claude', 'claude-haiku-4-5', 1500, 700).costMicros;
    const expectedBilled = priceCall('openai', 'gpt-5-nano', 1500, 700).costMicros;

    expect(result.costMicros).toBe(expectedCost);
    expect(result.billedMicros).toBe(expectedBilled);
    // The 14x is real, and it is ours.
    expect(result.costMicros).toBeGreaterThan(result.billedMicros * 5);
  });

  it('records the ABSORBED part against the global pool', async () => {
    await recordAiUsage({
      ...CALL,
      provider: 'claude',
      model: 'claude-haiku-4-5',
      failover: true,
      billedProvider: 'openai',
      billedModel: 'gpt-5-nano',
      pool: 'paid',
    });

    const [, , cost, absorbed] = mockPoolSpend.mock.calls[0];
    expect(absorbed).toBeGreaterThan(0);
    expect(absorbed).toBe(cost - priceCall('openai', 'gpt-5-nano', 1500, 700).costMicros);
  });

  it('counts the call as a failover, which is what the ceiling reads', async () => {
    await recordAiUsage({
      ...CALL,
      provider: 'claude',
      model: 'claude-haiku-4-5',
      failover: true,
      billedProvider: 'openai',
      billedModel: 'gpt-5-nano',
    });
    expect(mockUpsert.mock.calls[0][0].update.failoverCalls).toEqual({ increment: 1 });
  });

  it('an ordinary call bills exactly what it cost, and absorbs nothing', async () => {
    const result = await recordAiUsage({
      ...CALL,
      provider: 'openai',
      model: 'gpt-5-nano',
    });
    expect(result.billedMicros).toBe(result.costMicros);
    expect(mockPoolSpend.mock.calls[0][3]).toBe(0);
  });

  it('an explicit billedMicros still wins — one override, not two', async () => {
    const result = await recordAiUsage({
      ...CALL,
      provider: 'claude',
      model: 'claude-haiku-4-5',
      billedMicros: 42,
      billedModel: 'gpt-5-nano',
    });
    expect(result.billedMicros).toBe(42);
  });

  it('a "failover" onto the SAME model bills what it cost', async () => {
    const result = await recordAiUsage({
      ...CALL,
      provider: 'openai',
      model: 'gpt-5-nano',
      billedModel: 'gpt-5-nano',
    });
    expect(result.billedMicros).toBe(result.costMicros);
  });
});
