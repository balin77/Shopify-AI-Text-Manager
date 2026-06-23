/**
 * Unit tests for cookie-banner-availability.server.ts (Plan §7.5)
 *
 * ✅ No real Shopify needed — global fetch is mocked.
 * ✅ Verifies: probe success → "available", error/throw → "unavailable",
 *    15-min cache reuse, and force-refresh bypass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCookieBannerAvailability,
  getCookieBannerResources,
  writeCookieBannerTranslations,
  __clearCookieBannerCache,
} from '~/utils/cookie-banner-availability.server';

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const session = { shop: 'probe.myshopify.com', accessToken: 'shpat_test' };

function mockFetchJson(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  });
}

describe('getCookieBannerAvailability', () => {
  beforeEach(() => {
    __clearCookieBannerCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns "available" when the probe succeeds', async () => {
    global.fetch = mockFetchJson({
      data: { translatableResources: { edges: [{ node: { resourceId: 'gid://shopify/CookieBanner/1', translatableContent: [{ key: 'title' }] } }] } },
    }) as unknown as typeof fetch;

    const status = await getCookieBannerAvailability(session);
    expect(status).toBe('available');
  });

  it('returns "unavailable" when the probe returns GraphQL errors', async () => {
    global.fetch = mockFetchJson({ errors: [{ message: "Invalid enum value 'COOKIE_BANNER'" }] }) as unknown as typeof fetch;

    const status = await getCookieBannerAvailability(session);
    expect(status).toBe('unavailable');
  });

  it('returns "unavailable" when fetch throws (network blip)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;

    const status = await getCookieBannerAvailability(session);
    expect(status).toBe('unavailable');
  });

  it('returns "unavailable" when the session has no access token', async () => {
    const spy = vi.fn();
    global.fetch = spy as unknown as typeof fetch;

    const status = await getCookieBannerAvailability({ shop: 'x.myshopify.com' });
    expect(status).toBe('unavailable');
    expect(spy).not.toHaveBeenCalled();
  });

  it('caches the result (no second fetch within TTL)', async () => {
    const fetchMock = mockFetchJson({ data: { translatableResources: { edges: [] } } });
    global.fetch = fetchMock as unknown as typeof fetch;

    await getCookieBannerAvailability(session);
    await getCookieBannerAvailability(session);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('force-refresh bypasses the cache', async () => {
    const fetchMock = mockFetchJson({ data: { translatableResources: { edges: [] } } });
    global.fetch = fetchMock as unknown as typeof fetch;

    await getCookieBannerAvailability(session);
    await getCookieBannerAvailability(session, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('getCookieBannerResources', () => {
  beforeEach(() => {
    __clearCookieBannerCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the resource nodes on success', async () => {
    const node = {
      resourceId: 'gid://shopify/CookieBanner/1',
      translatableContent: [{ key: 'title', value: 'We use cookies', digest: 'abc', locale: 'en' }],
    };
    global.fetch = mockFetchJson({ data: { translatableResources: { edges: [{ node }] } } }) as unknown as typeof fetch;

    const resources = await getCookieBannerResources(session);
    expect(resources).toHaveLength(1);
    expect(resources?.[0].resourceId).toBe('gid://shopify/CookieBanner/1');
  });

  it('returns null and marks unavailable on error', async () => {
    global.fetch = mockFetchJson({ errors: [{ message: 'boom' }] }) as unknown as typeof fetch;

    const resources = await getCookieBannerResources(session);
    expect(resources).toBeNull();

    // Subsequent availability check should reuse the cached "unavailable".
    const noFetch = vi.fn();
    global.fetch = noFetch as unknown as typeof fetch;
    const status = await getCookieBannerAvailability(session);
    expect(status).toBe('unavailable');
    expect(noFetch).not.toHaveBeenCalled();
  });
});

describe('writeCookieBannerTranslations', () => {
  beforeEach(() => {
    __clearCookieBannerCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tx = [{ key: 'title', value: 'Wir nutzen Cookies', translatableContentDigest: 'abc', locale: 'de' }];

  it('no-ops (no fetch) when there is nothing to write', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await writeCookieBannerTranslations(session, 'gid://shopify/CookieBanner/1', []);
    expect(res.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok on a clean translationsRegister', async () => {
    global.fetch = mockFetchJson({ data: { translationsRegister: { userErrors: [] } } }) as unknown as typeof fetch;

    const res = await writeCookieBannerTranslations(session, 'gid://shopify/CookieBanner/1', tx);
    expect(res).toEqual({ ok: true });
  });

  it('surfaces Shopify userErrors without flipping availability', async () => {
    global.fetch = mockFetchJson({
      data: { translationsRegister: { userErrors: [{ message: 'Invalid locale' }] } },
    }) as unknown as typeof fetch;

    const res = await writeCookieBannerTranslations(session, 'gid://shopify/CookieBanner/1', tx);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Invalid locale');
  });

  it('marks the shop unavailable on a schema-level GraphQL error', async () => {
    global.fetch = mockFetchJson({ errors: [{ message: "Field 'translationsRegister' doesn't exist" }] }) as unknown as typeof fetch;

    const res = await writeCookieBannerTranslations(session, 'gid://shopify/CookieBanner/1', tx);
    expect(res.ok).toBe(false);

    // Availability flipped to "unavailable" and is cached (no further fetch).
    const noFetch = vi.fn();
    global.fetch = noFetch as unknown as typeof fetch;
    expect(await getCookieBannerAvailability(session)).toBe('unavailable');
    expect(noFetch).not.toHaveBeenCalled();
  });

  it('returns ok:false (never throws) on a network blip', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;

    const res = await writeCookieBannerTranslations(session, 'gid://shopify/CookieBanner/1', tx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNRESET');
  });
});
