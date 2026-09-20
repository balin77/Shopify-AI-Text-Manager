/**
 * The failover's trigger matrix and its breaker — PLAN_MANAGED_AI_KEY §3a.
 *
 * The fallback is roughly 14x the price of the default, so the EXCLUSIONS are
 * where the money is: every error the second provider answers identically is
 * one we paid for twice. And the breaker exists because "N consecutive
 * failures" is not implementable here — dispatch is concurrent and calls
 * settle out of order, so a 50%-failing primary produces "consecutive" only by
 * luck.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('~/utils/logger.server', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

const { mockAggregate } = vi.hoisted(() => ({
  mockAggregate: vi.fn().mockResolvedValue({ _sum: { failoverCalls: 0 } }),
}));
vi.mock('~/db.server', () => ({
  db: { aiUsageCounter: { aggregate: mockAggregate } },
}));

import { classifyFailover, statusOf } from '~/services/ai/managed-failover.shared';
import {
  breakerAllows,
  recordBreakerOutcome,
  resetBreakers,
  breakerState,
  shopFailoverExhausted,
  shopFailoverCeiling,
} from '~/services/ai/managed-failover.server';

beforeEach(() => {
  resetBreakers();
  vi.clearAllMocks();
  mockAggregate.mockResolvedValue({ _sum: { failoverCalls: 0 } });
});

describe('what triggers a failover', () => {
  it.each([
    ['a 5xx', { status: 503, message: 'service unavailable' }, 'server'],
    ['a timeout', { status: 0, message: 'AI request timed out after 120000ms' }, 'timeout'],
    ['a connection error', { message: 'ECONNRESET' }, 'connection'],
    ['a retired model id', { status: 404, message: 'model not found: gpt-5-nano' }, 'modelNotFound'],
    ['a 401 on OUR key', { status: 401, message: 'invalid api key' }, 'ourAuth'],
  ])('%s fails over', (_label, signal, reason) => {
    const verdict = classifyFailover(signal as never);
    expect(verdict.failOver).toBe(true);
    expect(verdict.reason).toBe(reason);
  });
});

describe('what must NOT trigger one — this is where the money is', () => {
  it('input-too-long: the fallback context is SMALLER, so it fails too', () => {
    expect(
      classifyFailover({ status: 400, message: 'maximum context length is 128000 tokens' })
        .failOver,
    ).toBe(false);
  });

  it('a content refusal: both providers refuse the same content', () => {
    expect(
      classifyFailover({ status: 400, message: 'blocked by content policy' }).failOver,
    ).toBe(false);
  });

  it('a malformed 400: our payload is wrong, not their service', () => {
    expect(classifyFailover({ status: 400, message: 'invalid field "foo"' }).failOver).toBe(false);
  });

  it('a 429 BEFORE the queue has finished retrying — a rate limit is a wait', () => {
    // Paying 14x to skip a wait is the most expensive way to be impatient.
    const early = classifyFailover({
      status: 429,
      message: 'rate limit',
      rateLimitRetriesExhausted: false,
    });
    expect(early.failOver).toBe(false);
    expect(early.reason).toBe('rateLimitedRetryFirst');

    const late = classifyFailover({
      status: 429,
      message: 'rate limit',
      rateLimitRetriesExhausted: true,
    });
    expect(late.failOver).toBe(true);
  });

  it('anything UNRECOGNISED does not fail over', () => {
    // The default has to be the cheap one: an unknown error the fallback would
    // also refuse costs double every time, and an error nobody has classified
    // is the most likely kind to repeat.
    expect(classifyFailover({ message: 'something nobody has seen' }).failOver).toBe(false);
  });

  it('model-not-found is checked BEFORE the 400 exclusion', () => {
    // Some providers report a retired model as a 400, and that is the one 400
    // where the other provider really can answer.
    expect(
      classifyFailover({ status: 400, message: 'The model `x` does not exist' }).failOver,
    ).toBe(true);
  });
});

describe('statusOf reads what the SDKs actually throw', () => {
  it.each([
    [{ status: 500 }, 500],
    [{ statusCode: 502 }, 502],
    [{ response: { status: 503 } }, 503],
    [new Error('plain'), undefined],
  ])('%o', (error, expected) => {
    expect(statusOf(error)).toBe(expected);
  });
});

describe('the breaker is a RATE over a window', () => {
  it('does not open on a couple of failures', () => {
    for (let i = 0; i < 3; i++) recordBreakerOutcome('openai', false);
    expect(breakerAllows('openai').allow).toBe(true);
  });

  it('opens once half the calls in the window failed', () => {
    for (let i = 0; i < 5; i++) recordBreakerOutcome('openai', false);
    expect(breakerAllows('openai').allow).toBe(false);
    expect(breakerState('openai').open).toBe(true);
  });

  it('stays closed while the failure rate is below half', () => {
    for (let i = 0; i < 8; i++) recordBreakerOutcome('openai', true);
    for (let i = 0; i < 3; i++) recordBreakerOutcome('openai', false);
    expect(breakerAllows('openai').allow).toBe(true);
  });

  it('half-opens after its window, and lets exactly ONE probe through', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) recordBreakerOutcome('openai', false, t0);
    expect(breakerAllows('openai', t0).allow).toBe(false);

    const later = t0 + 61_000;
    const first = breakerAllows('openai', later);
    expect(first).toEqual({ allow: true, probe: true });
    // Everyone else holds the fallback while the probe is out.
    expect(breakerAllows('openai', later)).toEqual({ allow: false, probe: false });
  });

  it('a successful probe CLOSES it', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) recordBreakerOutcome('openai', false, t0);
    breakerAllows('openai', t0 + 61_000);
    recordBreakerOutcome('openai', true, t0 + 61_000);

    expect(breakerState('openai').open).toBe(false);
    expect(breakerAllows('openai', t0 + 62_000).allow).toBe(true);
  });

  it('a failed probe re-opens it for LONGER', () => {
    // A primary failing 30% of the time would otherwise open, probe, close and
    // re-open forever — and every cycle is billed at 1x while costing 14x.
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) recordBreakerOutcome('openai', false, t0);
    breakerAllows('openai', t0 + 61_000);
    recordBreakerOutcome('openai', false, t0 + 61_000);

    expect(breakerState('openai').trips).toBe(2);
    // The first window was 60s; the second is longer, so the same offset is
    // still closed.
    expect(breakerAllows('openai', t0 + 61_000 + 61_000).allow).toBe(false);
  });

  it('is per PROVIDER — a dead default does not hold the fallback shut', () => {
    for (let i = 0; i < 5; i++) recordBreakerOutcome('openai', false);
    expect(breakerAllows('openai').allow).toBe(false);
    expect(breakerAllows('claude').allow).toBe(true);
  });
});

describe('the per-shop failover ceiling', () => {
  it('stops a shop that has had its allowance', async () => {
    // Without it, rule 1 is an exploit: the triggers include timeouts and
    // post-retry 429s, both of which a shop can produce on purpose, and the
    // breaker is global — so one shop could flip everybody onto the 14x model
    // and keep paying nano prices.
    mockAggregate.mockResolvedValueOnce({ _sum: { failoverCalls: shopFailoverCeiling() } });
    expect(await shopFailoverExhausted('demo.myshopify.com', 'b:2026-10-14')).toBe(true);
  });

  it('allows a shop below it', async () => {
    mockAggregate.mockResolvedValueOnce({ _sum: { failoverCalls: 1 } });
    expect(await shopFailoverExhausted('demo.myshopify.com', 'b:2026-10-14')).toBe(false);
  });

  it('REFUSES the failover when it cannot read the evidence', async () => {
    // The expensive direction here is 14x on an unread number.
    mockAggregate.mockRejectedValueOnce(new Error('db down'));
    expect(await shopFailoverExhausted('demo.myshopify.com', 'b:2026-10-14')).toBe(true);
  });
});
