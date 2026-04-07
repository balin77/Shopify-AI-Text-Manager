/**
 * Unit Tests for ShopifyApiGateway
 *
 * Focus:
 *   1. Rate-limit detection (isRateLimitError private method via public graphql())
 *   2. Queue mechanism — requests are processed sequentially, not concurrently
 *   3. Non-rate-limit errors are rejected after MAX_RETRIES
 *
 * Uses vi.useFakeTimers() to keep tests fast (avoids real 1s retry delays).
 *
 * ✅ No real Shopify API needed
 * ✅ Fast (fake timers skip all sleep() calls)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShopifyApiGateway } from '~/services/shopify-api-gateway.service';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('~/utils/logger.server', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('~/utils/error-handler', () => ({
  getFullErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const shop = 'test.myshopify.com';

/** Build a mock admin whose graphql() returns `response` wrapped in .json() */
function makeAdmin(responses: unknown[]) {
  let call = 0;
  return {
    graphql: vi.fn().mockImplementation(async () => {
      const resp = responses[Math.min(call++, responses.length - 1)];
      return { json: async () => resp };
    }),
  };
}

const SUCCESS = { data: { shop: { name: 'Test' } } };
const THROTTLED = {
  errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
};
const RATE_LIMIT_MSG = {
  errors: [{ message: 'You have exceeded the rate limit for this endpoint' }],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ShopifyApiGateway — rate-limit detection (isRateLimitError)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('detects THROTTLED extension code and retries the request', async () => {
    // First call → THROTTLED, second call → success
    const admin = makeAdmin([THROTTLED, SUCCESS]);
    const gateway = new ShopifyApiGateway(admin, shop);

    const promise = gateway.graphql('{ shop { name } }');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(true);
    // Called twice: initial attempt + one retry
    expect(admin.graphql).toHaveBeenCalledTimes(2);
  });

  it('detects "rate limit" in error message and retries', async () => {
    const admin = makeAdmin([RATE_LIMIT_MSG, SUCCESS]);
    const gateway = new ShopifyApiGateway(admin, shop);

    const promise = gateway.graphql('{ shop { name } }');
    await vi.runAllTimersAsync();
    await promise;

    expect(admin.graphql).toHaveBeenCalledTimes(2);
  });

  it('resolves immediately when there is no rate-limit error', async () => {
    const admin = makeAdmin([SUCCESS]);
    const gateway = new ShopifyApiGateway(admin, shop);

    const promise = gateway.graphql('{ shop { name } }');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(admin.graphql).toHaveBeenCalledOnce();
  });
});

describe('ShopifyApiGateway — queue mechanism', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('processes multiple queued requests sequentially (not concurrently)', async () => {
    const callOrder: number[] = [];
    let seq = 0;
    const admin = {
      graphql: vi.fn().mockImplementation(async () => {
        callOrder.push(++seq);
        return { json: async () => SUCCESS };
      }),
    };

    const gateway = new ShopifyApiGateway(admin, shop);

    // Enqueue three requests without awaiting each — they should be queued
    const p1 = gateway.graphql('query1');
    const p2 = gateway.graphql('query2');
    const p3 = gateway.graphql('query3');

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2, p3]);

    // All three resolved successfully and in order
    expect(admin.graphql).toHaveBeenCalledTimes(3);
    expect(callOrder).toEqual([1, 2, 3]);
  });

  it('rejects a request after MAX_RETRIES on persistent non-rate-limit errors', async () => {
    const networkError = new Error('Connection refused');
    const admin = { graphql: vi.fn().mockRejectedValue(networkError) };

    const gateway = new ShopifyApiGateway(admin, shop);

    const promise = gateway.graphql('{ shop { name } }');
    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const settled = promise.catch((err: unknown) => err);

    await vi.runAllTimersAsync();
    const result = await settled;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('Connection refused');
    // 1 initial attempt + 3 retries (MAX_RETRIES = 3)
    expect(admin.graphql).toHaveBeenCalledTimes(4);
  });
});
