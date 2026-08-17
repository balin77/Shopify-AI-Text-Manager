/**
 * Guards handlePolledAuthError: a Shopify auth Response thrown inside a polled
 * loader must be RE-THROWN unchanged (so App Bridge can refresh the token),
 * never re-wrapped as a 3xx json (which crashes with "Redirects must have a
 * Location header"). 429 degrades to a graceful 200; non-Response → 500.
 *
 * The graceful cases now come back as React Router `data()` results rather than
 * `Response`s, so status/headers/body are read off the wrapper's init instead
 * of off a Response. The guarantees asserted here are unchanged.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handlePolledAuthError } from '~/utils/polled-auth-error.server';
import { readDataPayload, readDataStatus } from '~/utils/data-response';
import type { DataResponse } from '~/types/data-response';

/** Init headers may be a plain object literal; normalise for lookup. */
function headersOf(result: DataResponse): Headers {
  if (result instanceof Response) return result.headers;
  return new Headers(result.init?.headers);
}

describe('handlePolledAuthError', () => {
  it('re-throws a 302 redirect Response UNCHANGED (does not re-wrap as 3xx json)', () => {
    const redirect = new Response(null, { status: 302, headers: { Location: '/auth' } });
    let thrown: unknown;
    try {
      handlePolledAuthError(redirect, { count: 0 });
    } catch (e) {
      thrown = e;
    }
    // Same object → its Location/status survive for the framework/App Bridge.
    expect(thrown).toBe(redirect);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get('Location')).toBe('/auth');
  });

  it('re-throws a 401/403 retry-header Response unchanged', () => {
    const retry = new Response(null, { status: 401, headers: { 'X-Shopify-Retry-Invalid-Session-Request': '1' } });
    expect(() => handlePolledAuthError(retry, { tasks: [] })).toThrow();
    try {
      handlePolledAuthError(retry, { tasks: [] });
    } catch (e) {
      expect((e as Response).headers.get('X-Shopify-Retry-Invalid-Session-Request')).toBe('1');
    }
  });

  it('degrades a 429 rate-limit Response to a graceful 200 with the fallback body', async () => {
    const rateLimited = new Response(null, { status: 429 });
    const res = handlePolledAuthError(rateLimited, { count: 0 });
    expect(readDataStatus(res)).toBe(200);
    expect(headersOf(res).get('Retry-After')).toBe('60');
    const body = await readDataPayload(res);
    expect(body).toMatchObject({ count: 0, warning: 'Rate limited' });
  });

  it('returns 500 (not a 3xx) for a non-Response error', async () => {
    const res = handlePolledAuthError(new Error('boom'), { tasks: [] });
    expect(readDataStatus(res)).toBe(500);
    const body = await readDataPayload(res);
    expect(body).toMatchObject({ tasks: [], error: 'Authentication failed' });
  });
});
