/**
 * The managed RUNTIME path — what `AIService` does with a managed credential
 * once it has one. PLAN_MANAGED_AI_KEY §3a, §6, §6a.
 *
 * `ai-failover.test.ts` covers the trigger list and the breaker as pure
 * state; `ai-credentials-runtime.test.ts` covers the config the resolver
 * builds. This covers the service in between, where review found the rules
 * being lost after they had been decided correctly:
 *
 * - the failover REPLACED the instance's config, so every later call on a
 *   bulk run skipped the preflight (budget, consent, kill switch, pool) and
 *   stayed on the 14x model for good;
 * - a hung primary lost its worst-case charge at the switch, and a hung
 *   fallback ran outside the timeout race altogether;
 * - every primary failure — a 400, an early 429 — counted against the GLOBAL
 *   breaker, and a fallback probe that ended on one was never handed back;
 * - the meter wrote under the period computed at construction while the
 *   budget was read under the one the preflight had just derived;
 * - the OpenAI branch sent `max_tokens`, which the gpt-5 family refuses with a
 *   400 that never fails over — i.e. managed mode on its planned default was
 *   down, not degraded.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { openaiCreate, anthropicCreate, mockRecordAiUsage, mockAggregate, mockFailoverBudget } =
  vi.hoisted(() => ({
    openaiCreate: vi.fn(),
    anthropicCreate: vi.fn(),
    mockRecordAiUsage: vi.fn().mockResolvedValue({}),
    mockAggregate: vi.fn().mockResolvedValue({ _sum: { failoverCalls: 0 } }),
    mockFailoverBudget: vi.fn().mockResolvedValue(false),
  }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn(), queue: vi.fn() },
}));

vi.mock('../../src/services/ai-queue.service', () => ({
  AIQueueService: {
    getInstance: vi.fn().mockReturnValue({
      enqueue: vi.fn(async (...args: unknown[]) => (args[4] as (a: number) => unknown)(0)),
    }),
  },
  MAX_RATE_LIMIT_RETRIES: 3,
  rateLimitBucket: (source: string, provider: string) => `${source}:${provider}`,
}));

vi.mock('~/db.server', () => ({
  db: {
    aiUsageCounter: { aggregate: mockAggregate },
    task: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
  },
}));

vi.mock('~/services/ai/usage-meter.server', () => ({ recordAiUsage: mockRecordAiUsage }));

vi.mock('~/services/ai/managed-global-pool.server', () => ({
  failoverBudgetExhausted: mockFailoverBudget,
}));

import {
  AIService,
  ManagedAiRefusedError,
  isManagedRefusal,
  managedDirectSlotState,
  openAiChatParams,
  type AIServiceConfig,
} from '../../src/services/ai.service';
import {
  breakerAllows,
  breakerState,
  recordBreakerOutcome,
  resetBreakers,
  shopFailoverCeiling,
} from '~/services/ai/managed-failover.server';

const SHOP = 'demo.myshopify.com';

const nanoAnswer = (content = 'nano') => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const haikuAnswer = (text = 'haiku') => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
});
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

type Preflight = NonNullable<AIServiceConfig['preflight']>;

function managedService(
  opts: {
    preflight?: Preflight;
    fallback?: boolean;
    taskId?: string;
    model?: string;
  } = {},
) {
  const preflight =
    opts.preflight ?? vi.fn<Preflight>(async () => ({ ok: true, period: 'b:2026-10-14', pool: 'paid' }));
  const switchToFailover = vi.fn(async () =>
    opts.fallback === false
      ? null
      : {
          provider: 'claude' as const,
          config: {
            claudeApiKey: 'sk-fallback',
            selectedModel: 'claude-haiku-4-5',
            credentialSource: 'managed' as const,
            usagePeriod: 'b:2026-10-14',
            usagePool: 'paid' as const,
            defaultModelForBilling: 'gpt-5-nano',
            defaultProviderForBilling: 'openai' as const,
          },
        },
  );
  const config: AIServiceConfig = {
    openaiApiKey: 'sk-operator',
    selectedModel: opts.model ?? 'gpt-5-nano',
    credentialSource: 'managed',
    usagePeriod: 'b:2026-10-14',
    usagePool: 'paid',
    preflight,
    switchToFailover,
  };
  const service = new AIService('openai', config, SHOP, opts.taskId);
  return { service, preflight, switchToFailover };
}

type Internals = {
  replayRequest: (p: string) => Promise<string>;
  executeAIRequest: (p: string, i?: string[], attempt?: number) => Promise<string>;
  askAI: (p: string) => Promise<string>;
  provider: string;
  config: AIServiceConfig;
};
const internals = (s: AIService) => s as unknown as Internals;

beforeEach(() => {
  vi.clearAllMocks();
  resetBreakers();
  mockAggregate.mockResolvedValue({ _sum: { failoverCalls: 0 } });
  mockFailoverBudget.mockResolvedValue(false);
  openaiCreate.mockReset();
  anthropicCreate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OpenAI parameters follow the MODEL family', () => {
  it.each([
    ['gpt-5-nano', { max_completion_tokens: 8192, reasoning_effort: 'minimal' }],
    ['gpt-5-mini', { max_completion_tokens: 8192, reasoning_effort: 'minimal' }],
    ['gpt-5', { max_completion_tokens: 8192, reasoning_effort: 'minimal' }],
    ['gpt-5-nano-2025-08-07', { max_completion_tokens: 8192, reasoning_effort: 'minimal' }],
    // Not a reasoning model — the effort parameter is not its to take.
    ['gpt-5-chat-latest', { max_completion_tokens: 8192 }],
    // Later releases changed the accepted efforts; their own default stands.
    ['gpt-5.1', { max_completion_tokens: 8192 }],
    ['o3-mini', { max_completion_tokens: 8192 }],
    ['o1', { max_completion_tokens: 8192 }],
    ['o4-mini', { max_completion_tokens: 8192 }],
    // Everything else is byte-identical to before.
    ['gpt-4o-mini', { max_tokens: 8192 }],
    ['gpt-4-turbo', { max_tokens: 8192 }],
  ])('%s', (model, expected) => {
    expect(openAiChatParams(model, 8192)).toEqual(expected);
  });

  it('the OpenAI branch sends them — and no max_tokens or temperature to gpt-5', async () => {
    openaiCreate.mockResolvedValue(nanoAnswer());
    const { service } = managedService();
    await internals(service).replayRequest('p');

    const body = openaiCreate.mock.calls[0][0];
    expect(body.max_completion_tokens).toBe(8192);
    expect(body.reasoning_effort).toBe('minimal');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('…on the VISION call too', async () => {
    openaiCreate.mockResolvedValue(nanoAnswer());
    const { service } = managedService();
    await internals(service).executeAIRequest('p', ['https://cdn.shopify.com/a.jpg']);
    const body = openaiCreate.mock.calls[0][0];
    expect(body.max_completion_tokens).toBe(8192);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('a BYO gpt-4o-mini call keeps max_tokens', async () => {
    openaiCreate.mockResolvedValue(nanoAnswer());
    const service = new AIService('openai', { openaiApiKey: 'k', selectedModel: 'gpt-4o-mini' });
    await internals(service).replayRequest('p');
    expect(openaiCreate.mock.calls[0][0].max_tokens).toBe(8192);
    expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty('max_completion_tokens');
  });
});

describe('the failover is PER REQUEST — the instance never becomes the fallback', () => {
  it('the next call goes back to the primary AND through the preflight', async () => {
    openaiCreate
      .mockRejectedValueOnce(httpError(503, 'service unavailable'))
      .mockResolvedValueOnce(nanoAnswer('nano again'));
    anthropicCreate.mockResolvedValue(haikuAnswer());
    const { service, preflight } = managedService();

    expect(await internals(service).replayRequest('p')).toBe('haiku');
    expect(await internals(service).replayRequest('p')).toBe('nano again');

    // Both calls were gated; the first cut's swapped config had no preflight,
    // so the second one would have skipped budget, consent and the pool.
    // Three answers: call 1, the re-check before its failover, call 2.
    expect(preflight).toHaveBeenCalledTimes(3);
    expect(openaiCreate).toHaveBeenCalledTimes(2);
    expect(internals(service).provider).toBe('openai');
    expect(internals(service).config.failoverServed).toBeUndefined();
    expect(typeof internals(service).config.preflight).toBe('function');
  });

  it('a refused preflight stops the call even after a failover', async () => {
    openaiCreate.mockRejectedValueOnce(httpError(503, 'service unavailable'));
    anthropicCreate.mockResolvedValue(haikuAnswer());
    const preflight = vi
      .fn<Preflight>()
      .mockResolvedValueOnce({ ok: true, period: 'b:2026-10-14', pool: 'paid' })
      .mockResolvedValueOnce({ ok: true, period: 'b:2026-10-14', pool: 'paid' })
      .mockResolvedValueOnce({ ok: false, reason: 'budgetExceeded' });
    const { service } = managedService({ preflight });

    await internals(service).replayRequest('p');
    const error = await internals(service).replayRequest('p').catch((e) => e);
    expect(isManagedRefusal(error)).toBe(true);
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('the fallback re-asks the budget: a primary charged past it does not start the 14x call', async () => {
    // The primary failed AFTER its preflight — e.g. a timeout charged its
    // worst case — and the budget is now spent. The fallback must not start,
    // and the answer is a REFUSAL (never the primary's plain error, which a
    // repair would read as "the AI could not deliver" and delete on).
    openaiCreate.mockRejectedValueOnce(httpError(503, 'service unavailable'));
    anthropicCreate.mockResolvedValue(haikuAnswer());
    const preflight = vi
      .fn<Preflight>()
      .mockResolvedValueOnce({ ok: true, period: 'b:2026-10-14', pool: 'paid' })
      .mockResolvedValueOnce({ ok: false, reason: 'budgetExceeded' });
    const { service } = managedService({ preflight });

    const error = await internals(service).replayRequest('p').catch((e) => e);
    expect(isManagedRefusal(error)).toBe(true);
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('bills the fallback at the DEFAULT model and marks it a failover', async () => {
    openaiCreate.mockRejectedValueOnce(httpError(503, 'service unavailable'));
    anthropicCreate.mockResolvedValue(haikuAnswer());
    const { service } = managedService();
    await internals(service).replayRequest('p');

    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({
      provider: 'claude',
      model: 'claude-haiku-4-5',
      failover: true,
      billedModel: 'gpt-5-nano',
      billedProvider: 'openai',
      source: 'managed',
    });
  });

  it('asks the per-shop CEILING on every failover-served call, not once', async () => {
    openaiCreate.mockRejectedValue(httpError(503, 'service unavailable'));
    anthropicCreate.mockResolvedValue(haikuAnswer());
    mockAggregate
      .mockResolvedValueOnce({ _sum: { failoverCalls: 0 } })
      .mockResolvedValueOnce({ _sum: { failoverCalls: shopFailoverCeiling() } });
    const { service } = managedService();

    expect(await internals(service).replayRequest('p')).toBe('haiku');
    // The shop has had its allowance now: the primary's own error stands.
    await expect(internals(service).replayRequest('p')).rejects.toThrow('service unavailable');
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('asks the GLOBAL failover budget on every failover-served call too', async () => {
    openaiCreate.mockRejectedValue(httpError(503, 'service unavailable'));
    anthropicCreate.mockResolvedValue(haikuAnswer());
    mockFailoverBudget.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { service } = managedService();

    expect(await internals(service).replayRequest('p')).toBe('haiku');
    await expect(internals(service).replayRequest('p')).rejects.toThrow('service unavailable');
  });
});

describe('the meter writes under the ledger the PREFLIGHT checked', () => {
  it('a period that moved since construction is the one written', async () => {
    openaiCreate.mockResolvedValue(nanoAnswer());
    const preflight = vi.fn<Preflight>(async () => ({ ok: true, period: 'taster', pool: 'taster' }));
    const { service } = managedService({ preflight });
    await internals(service).replayRequest('p');

    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ period: 'taster', pool: 'taster' });
  });

  it('…on the failover call, and the ceiling reads that same period', async () => {
    openaiCreate.mockRejectedValueOnce(httpError(503, 'service unavailable'));
    anthropicCreate.mockResolvedValue(haikuAnswer());
    const preflight = vi.fn<Preflight>(async () => ({ ok: true, period: 'b:2026-11-14', pool: 'paid' }));
    const { service } = managedService({ preflight });
    await internals(service).replayRequest('p');

    expect(mockRecordAiUsage.mock.calls[0][0].period).toBe('b:2026-11-14');
    // The ceiling sums the open periods the budget sums — the call's own key
    // is always one of them.
    const where = mockAggregate.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ period: 'b:2026-11-14' });
  });

  it('a call with no preflight keeps the construction-time period', async () => {
    openaiCreate.mockResolvedValue(nanoAnswer());
    const service = new AIService(
      'openai',
      { openaiApiKey: 'k', credentialSource: 'managed', usagePeriod: 'b:2026-10-14', usagePool: 'paid' },
      SHOP,
    );
    await internals(service).replayRequest('p');
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ period: 'b:2026-10-14', pool: 'paid' });
  });
});

describe('an unanswered dispatch is charged at its worst case EXACTLY once', () => {
  it('a hung primary with the switch refused is still charged', async () => {
    vi.useFakeTimers();
    openaiCreate.mockReturnValue(new Promise(() => {}));
    const { service } = managedService({ fallback: false });

    const rejected = expect(internals(service).replayRequest('p')).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(121_000);
    await rejected;

    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({
      provider: 'openai',
      estimated: true,
      outputTokens: 8192,
    });
  });

  it('a hung primary that WAS failed over is charged, and so is the fallback', async () => {
    vi.useFakeTimers();
    openaiCreate.mockReturnValue(new Promise(() => {}));
    anthropicCreate.mockResolvedValue(haikuAnswer());
    const { service } = managedService();

    const answered = internals(service).replayRequest('p');
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await answered).toBe('haiku');

    expect(mockRecordAiUsage).toHaveBeenCalledTimes(2);
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({
      provider: 'openai',
      estimated: true,
      outputTokens: 8192,
      failover: false,
    });
    expect(mockRecordAiUsage.mock.calls[1][0]).toMatchObject({ provider: 'claude', failover: true });
  });

  it('a hung FALLBACK is raced against the timeout and charged too', async () => {
    vi.useFakeTimers();
    openaiCreate.mockRejectedValue(httpError(503, 'service unavailable'));
    anthropicCreate.mockReturnValue(new Promise(() => {}));
    const { service } = managedService();

    const rejected = expect(internals(service).replayRequest('p')).rejects.toThrow(
      'service unavailable',
    );
    await vi.advanceTimersByTimeAsync(121_000);
    await rejected;

    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({
      provider: 'claude',
      estimated: true,
      outputTokens: 8192,
      failover: true,
    });
  });
});

describe('only PROVIDER-HEALTH failures count against the breaker', () => {
  it('ten malformed-request 400s leave it closed', async () => {
    openaiCreate.mockRejectedValue(httpError(400, 'invalid field "foo"'));
    const { service } = managedService();
    for (let i = 0; i < 10; i++) await internals(service).replayRequest('p').catch(() => {});
    expect(breakerState('openai').open).toBe(false);
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('an early 429 the queue will retry does not count; an exhausted one does', async () => {
    openaiCreate.mockRejectedValue(httpError(429, 'rate limit'));
    const { service } = managedService({ fallback: false });
    for (let i = 0; i < 10; i++) {
      await internals(service).executeAIRequest('p', undefined, 0).catch(() => {});
    }
    expect(breakerState('openai').open).toBe(false);

    for (let i = 0; i < 5; i++) {
      await internals(service).executeAIRequest('p', undefined, 3).catch(() => {});
    }
    expect(breakerState('openai').open).toBe(true);
  });

  it('five 5xx do open it', async () => {
    openaiCreate.mockRejectedValue(httpError(503, 'service unavailable'));
    const { service } = managedService({ fallback: false });
    for (let i = 0; i < 5; i++) await internals(service).replayRequest('p').catch(() => {});
    expect(breakerState('openai').open).toBe(true);
  });
});

describe('a half-open probe is always settled or handed back', () => {
  const halfOpen = (provider: string) => {
    const past = Date.now() - 120_000;
    for (let i = 0; i < 5; i++) recordBreakerOutcome(provider, false, past);
  };

  it('a FALLBACK probe that ends on a 400 is released, not leaked', async () => {
    halfOpen('claude');
    openaiCreate.mockRejectedValue(httpError(503, 'service unavailable'));
    anthropicCreate.mockRejectedValue(httpError(400, 'invalid field "foo"'));
    const { service } = managedService();

    await internals(service).replayRequest('p').catch(() => {});
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    // Leaked, this answered "a probe is out" until a restart.
    expect(breakerAllows('claude').allow).toBe(true);
  });

  it('a FALLBACK probe that succeeds closes the fallback circuit', async () => {
    halfOpen('claude');
    openaiCreate.mockRejectedValue(httpError(503, 'service unavailable'));
    anthropicCreate.mockResolvedValue(haikuAnswer());
    const { service } = managedService();

    expect(await internals(service).replayRequest('p')).toBe('haiku');
    expect(breakerState('claude').open).toBe(false);
  });

  it('a FALLBACK probe that fails on its health re-opens it', async () => {
    halfOpen('claude');
    openaiCreate.mockRejectedValue(httpError(503, 'service unavailable'));
    anthropicCreate.mockRejectedValue(httpError(502, 'bad gateway'));
    const { service } = managedService();

    await internals(service).replayRequest('p').catch(() => {});
    expect(breakerState('claude').trips).toBe(2);
  });

  it('a PRIMARY probe that ends on a 400 is released too', async () => {
    halfOpen('openai');
    openaiCreate.mockRejectedValue(httpError(400, 'invalid field "foo"'));
    const { service } = managedService();

    await internals(service).replayRequest('p').catch(() => {});
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(breakerAllows('openai')).toEqual({ allow: true, probe: true });
  });

  it('a call that does NOT hold the probe cannot close the circuit', () => {
    halfOpen('openai');
    expect(breakerAllows('openai').probe).toBe(true);
    recordBreakerOutcome('openai', true, Date.now(), { probe: false });
    expect(breakerState('openai').open).toBe(true);
  });
});

describe('managed calls that skip the queue are capped per shop', () => {
  it('holds a fifth call until one of the first four settles, then cleans up', async () => {
    const pending: Array<(v: unknown) => void> = [];
    openaiCreate.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const { service } = managedService();

    const calls = Array.from({ length: 6 }, () => internals(service).askAI('p'));
    await vi.waitFor(() => expect(openaiCreate).toHaveBeenCalledTimes(4));
    expect(managedDirectSlotState(SHOP)).toEqual({ active: 4, waiting: 2 });

    pending.shift()!(nanoAnswer());
    await vi.waitFor(() => expect(openaiCreate).toHaveBeenCalledTimes(5));

    while (pending.length || openaiCreate.mock.calls.length < 6) {
      if (pending.length) pending.shift()!(nanoAnswer());
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(calls);
    expect(openaiCreate).toHaveBeenCalledTimes(6);
    // Bounded memory: nothing is left behind for a shop with nothing in flight.
    expect(managedDirectSlotState(SHOP)).toBeNull();
  });

  it('a failing call releases its slot', async () => {
    openaiCreate.mockRejectedValue(httpError(400, 'invalid field "foo"'));
    const { service } = managedService();
    await Promise.all(
      Array.from({ length: 6 }, () => internals(service).askAI('p').catch(() => {})),
    );
    expect(managedDirectSlotState(SHOP)).toBeNull();
  });

  it('BYO is untouched', async () => {
    const pending: Array<(v: unknown) => void> = [];
    openaiCreate.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const service = new AIService('openai', { openaiApiKey: 'k', selectedModel: 'gpt-4o-mini' }, SHOP);

    const calls = Array.from({ length: 6 }, () => internals(service).askAI('p'));
    await vi.waitFor(() => expect(openaiCreate).toHaveBeenCalledTimes(6));
    expect(managedDirectSlotState(SHOP)).toBeNull();
    pending.forEach((resolve) => resolve(nanoAnswer()));
    await Promise.all(calls);
  });
});

describe('a refusal is never swallowed into "the AI could not deliver"', () => {
  it('a bare 403 on the OPERATOR key becomes a managed refusal', async () => {
    openaiCreate.mockRejectedValue(httpError(403, 'forbidden'));
    const { service } = managedService({ fallback: false });
    const error = await internals(service).askAI('p').catch((e) => e);
    expect(isManagedRefusal(error)).toBe(true);
    expect((error as ManagedAiRefusedError).reason).toBe('managedUnavailable');
  });

  it('…while a bare 403 on a MERCHANT key stays what it was', async () => {
    openaiCreate.mockRejectedValue(httpError(403, 'forbidden'));
    const service = new AIService('openai', { openaiApiKey: 'k' }, SHOP);
    const error = await internals(service).askAI('p').catch((e) => e);
    expect(isManagedRefusal(error)).toBe(false);
    expect((error as Error).message).toBe('forbidden');
  });

  it('the per-locale value retry re-throws a refusal instead of skipping the locale', async () => {
    const service = new AIService('openai', { openaiApiKey: 'k' });
    const spy = service as unknown as {
      askAI: (p: string) => Promise<string>;
      translateBatchValues: (...a: unknown[]) => Promise<string[]>;
    };
    spy.askAI = vi.fn().mockResolvedValue('this is not json');
    spy.translateBatchValues = vi
      .fn()
      .mockRejectedValue(new ManagedAiRefusedError('budgetExceeded'));

    const error = await service
      .translateBatchValuesToLocales(['a', 'b'], 'de', ['en', 'fr'])
      .catch((e) => e);
    expect(isManagedRefusal(error)).toBe(true);
  });
});
