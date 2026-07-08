/**
 * Unit tests for the market-aware read-back helpers (PLAN_MARKET_TRANSLATIONS_READBACK)
 *
 * Covers:
 *  - marketLayersForLocale bounding (localeCodes intersection; empty = no restriction)
 *  - fetchedMarketLayers (delete-scoping helper)
 *  - fetchAllTranslations market passes: one query per (locale, layer), marketId
 *    threaded into the GraphQL variables and tagged onto the returned rows
 *  - fetchShopMarkets degrading to [] on any error (sync must never break)
 *
 * ✅ Everything mocked. No real Shopify / DB.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loggers: { translation: vi.fn() },
}));

import {
  marketLayersForLocale,
  fetchedMarketLayers,
  fetchAllTranslations,
  fetchShopMarkets,
} from '~/services/sync-utils';
import type { MarketInfo } from '~/types/content-editor.types';

const MARKET_EU: MarketInfo = { id: 'gid://shopify/Market/1', name: 'EU', handle: 'eu', localeCodes: ['de', 'fr'] };
const MARKET_US: MarketInfo = { id: 'gid://shopify/Market/2', name: 'US', handle: 'us', localeCodes: ['en'] };
const MARKET_OPEN: MarketInfo = { id: 'gid://shopify/Market/3', name: 'Open', handle: 'open', localeCodes: [] };

describe('marketLayersForLocale', () => {
  it('always starts with the global layer and bounds markets by localeCodes', () => {
    expect(marketLayersForLocale([MARKET_EU, MARKET_US], 'de')).toEqual(['', MARKET_EU.id]);
    expect(marketLayersForLocale([MARKET_EU, MARKET_US], 'en')).toEqual(['', MARKET_US.id]);
    expect(marketLayersForLocale([MARKET_EU, MARKET_US], 'it')).toEqual(['']);
  });

  it('treats an empty localeCodes list as "serves every locale"', () => {
    expect(marketLayersForLocale([MARKET_OPEN], 'anything')).toEqual(['', MARKET_OPEN.id]);
  });

  it('returns only the global layer with no markets', () => {
    expect(marketLayersForLocale([], 'de')).toEqual(['']);
  });
});

describe('fetchedMarketLayers', () => {
  it('is global + every market id (delete scope)', () => {
    expect(fetchedMarketLayers([])).toEqual(['']);
    expect(fetchedMarketLayers([MARKET_EU, MARKET_US])).toEqual(['', MARKET_EU.id, MARKET_US.id]);
  });
});

describe('fetchAllTranslations (market passes)', () => {
  const locales = [
    { locale: 'de', primary: false, published: true },
    { locale: 'en', primary: false, published: true },
  ];

  function graphqlFnReturning(perCall: (variables: Record<string, unknown>) => unknown[]) {
    const calls: Array<Record<string, unknown>> = [];
    const fn = vi.fn(async (_query: string, options?: { variables?: Record<string, unknown> }) => {
      const variables = options?.variables ?? {};
      calls.push(variables);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            translatableResource: {
              translatableContent: [{ key: 'title', value: 'Src', digest: 'digest-1', locale: 'en' }],
              translations: perCall(variables),
            },
          },
        }),
      };
    });
    return { fn, calls };
  }

  it('queries one (locale, layer) pair per market the locale is served in and tags rows with marketId', async () => {
    const { fn, calls } = graphqlFnReturning((variables) => [
      { key: 'title', value: `v-${variables.locale}-${variables.marketId ?? 'global'}`, locale: variables.locale },
    ]);

    const rows = await fetchAllTranslations(fn, 'gid://shopify/Product/1', locales, 'Product', [MARKET_EU, MARKET_US]);

    // de → global + EU; en → global + US (EU does not serve en, US does not serve de)
    expect(calls).toEqual([
      { resourceId: 'gid://shopify/Product/1', locale: 'de', marketId: null },
      { resourceId: 'gid://shopify/Product/1', locale: 'de', marketId: MARKET_EU.id },
      { resourceId: 'gid://shopify/Product/1', locale: 'en', marketId: null },
      { resourceId: 'gid://shopify/Product/1', locale: 'en', marketId: MARKET_US.id },
    ]);

    expect(rows).toHaveLength(4);
    const byLayer = new Map(rows.map((r) => [`${r.locale}:${r.marketId}`, r]));
    expect(byLayer.get('de:')?.value).toBe('v-de-global');
    expect(byLayer.get(`de:${MARKET_EU.id}`)?.value).toBe(`v-de-${MARKET_EU.id}`);
    expect(byLayer.get('en:')?.value).toBe('v-en-global');
    expect(byLayer.get(`en:${MARKET_US.id}`)?.value).toBe(`v-en-${MARKET_US.id}`);
    // Digest from translatableContent is threaded onto every layer's rows
    expect(rows.every((r) => r.digest === 'digest-1')).toBe(true);
  });

  it('runs global-only with no markets (today’s behaviour)', async () => {
    const { fn, calls } = graphqlFnReturning(() => []);
    await fetchAllTranslations(fn, 'gid://shopify/Product/1', locales, 'Product');
    expect(calls.every((v) => v.marketId === null)).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe('fetchShopMarkets', () => {
  it('degrades to [] when the markets query errors (missing scope / outage)', async () => {
    const fn = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    }));
    await expect(fetchShopMarkets(fn)).resolves.toEqual([]);
  });

  it('degrades to [] when graphql throws entirely', async () => {
    const fn = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(fetchShopMarkets(fn)).resolves.toEqual([]);
  });
});
