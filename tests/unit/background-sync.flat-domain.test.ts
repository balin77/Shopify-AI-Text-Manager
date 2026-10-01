/**
 * Unit tests for BackgroundSyncService.syncFlatDomain (via syncOnlineStoreExtras)
 *
 * Focus: the partial-failure guard. If one resource type in a domain fails
 * (GraphQL error or thrown), orphan cleanup MUST be skipped so the failed type's
 * still-valid rows are not deleted on a transient blip. When all types succeed,
 * orphan cleanup runs normally.
 *
 * ✅ Gateway + DB + sync-utils are mocked. No real Shopify / DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('~/services/shopify-api-gateway.service', () => {
  class ShopifyApiGateway {
    graphql = vi.fn();
    getQueueStatus = vi.fn().mockReturnValue({ queueLength: 0, isProcessing: false, requestCount: 0 });
    clearQueue = vi.fn();
  }
  return { ShopifyApiGateway };
});

// Locales come from sync-utils — mock so the gateway only handles resource queries.
vi.mock('~/services/sync-utils', () => ({
  fetchShopLocales: vi.fn().mockResolvedValue([
    { locale: 'en', primary: true },
    { locale: 'de', primary: false },
  ]),
  fetchAllTranslations: vi.fn().mockResolvedValue([]),
  fetchShopMarkets: vi.fn().mockResolvedValue([]),
  // Pure helpers — mirror the real implementations so market-aware code paths
  // behave exactly like production with zero markets.
  marketLayersForLocale: (markets: { id: string; localeCodes: string[] }[], locale: string) =>
    ['', ...markets.filter((m) => m.localeCodes.length === 0 || m.localeCodes.includes(locale)).map((m) => m.id)],
  fetchedMarketLayers: (markets: { id: string }[]) => ['', ...markets.map((m) => m.id)],
}));

const dbMock = vi.hoisted(() => ({
  aISettings: { findUnique: vi.fn().mockResolvedValue({ subscriptionPlan: 'pro' }) },
  themeContent: {
    upsert: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    count: vi.fn().mockResolvedValue(0),
  },
  themeTranslation: {
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    update: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  $transaction: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/db.server', () => ({ db: dbMock }));

import { BackgroundSyncService } from '~/services/background-sync.service';

const shop = 'flat.myshopify.com';

/** A translatableResources list response for one resource of `resourceType`. */
function listResponse(resourceId: string, content: Array<{ key: string; value: string }>) {
  return {
    json: async () => ({
      data: {
        translatableResources: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [{ node: { resourceId, translatableContent: content.map((c) => ({ ...c, digest: 'd', locale: 'en' })) } }],
        },
      },
    }),
  };
}

function errorResponse(message: string) {
  return { json: async () => ({ errors: [{ message }] }) };
}

function emptyTranslations() {
  return { json: async () => ({ data: { translatableResource: { translations: [] } } }) };
}

function makeService() {
  const service = new BackgroundSyncService({ graphql: vi.fn() } as never, shop);
  return service;
}

function gatewayOf(service: BackgroundSyncService) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).gateway.graphql as ReturnType<typeof vi.fn>;
}

describe('syncFlatDomain partial-failure guard (via syncOnlineStoreExtras)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.themeContent.findMany.mockResolvedValue([]);
    dbMock.themeTranslation.findMany.mockResolvedValue([]);
  });

  it('skips orphan cleanup when one resource type errors', async () => {
    const service = makeService();
    gatewayOf(service).mockImplementation(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const vars = opts?.variables || {};
      if (query.includes('translatableResources(')) {
        if (vars.resourceType === 'FILTER') return listResponse('gid://shopify/Filter/1', [{ key: 'label', value: 'Color' }]);
        if (vars.resourceType === 'SHOP') return errorResponse('boom'); // SHOP fails
      }
      return emptyTranslations();
    });

    // Existing rows include the SHOP group (would be deleted if cleanup ran).
    dbMock.themeContent.findMany.mockResolvedValue([
      { resourceId: 'gid://shopify/Shop/1', groupId: 'shop_metadata_1' },
    ]);

    const count = await service.syncOnlineStoreExtras();

    // FILTER persisted, SHOP failed.
    expect(dbMock.themeContent.upsert).toHaveBeenCalledTimes(1);
    expect(count).toBe(1);
    // Cleanup MUST be skipped → the SHOP group survives.
    expect(dbMock.themeContent.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it('lets an abort thrown from onProgress propagate', async () => {
    // The initial-sync orchestrator asserts its abort signal from INSIDE the
    // progress callback. Swallowing that throw as a resource-type failure left
    // the run going after the timer was stopped and — with nothing persisted —
    // tripped the empty-result health check into a bogus data-loss error.
    const service = makeService();
    gatewayOf(service).mockImplementation(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const vars = opts?.variables || {};
      if (query.includes('translatableResources(')) {
        if (vars.resourceType === 'FILTER') return listResponse('gid://shopify/Filter/1', [{ key: 'label', value: 'Color' }]);
        if (vars.resourceType === 'SHOP') return listResponse('gid://shopify/Shop/1', [{ key: 'meta_title', value: 'My Shop' }]);
      }
      return emptyTranslations();
    });
    // A local row exists, so a swallowed abort would reach the health check.
    dbMock.themeContent.count.mockResolvedValue(3);

    const abort = () => {
      const err = new Error('Client disconnected');
      err.name = 'AbortError';
      throw err;
    };

    await expect(service.syncOnlineStoreExtras(abort)).rejects.toMatchObject({ name: 'AbortError' });
    expect(dbMock.themeContent.deleteMany).not.toHaveBeenCalled();
  });

  it('runs orphan cleanup when all resource types succeed', async () => {
    const service = makeService();
    gatewayOf(service).mockImplementation(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const vars = opts?.variables || {};
      if (query.includes('translatableResources(')) {
        if (vars.resourceType === 'FILTER') return listResponse('gid://shopify/Filter/1', [{ key: 'label', value: 'Color' }]);
        if (vars.resourceType === 'SHOP') return listResponse('gid://shopify/Shop/1', [{ key: 'meta_title', value: 'My Shop' }]);
      }
      return emptyTranslations();
    });

    // An orphan row not present in this sync → should be cleaned up.
    dbMock.themeContent.findMany.mockResolvedValue([
      { resourceId: 'gid://shopify/Filter/OLD', groupId: 'filter_OLD' },
    ]);

    await service.syncOnlineStoreExtras();

    // Both resources persisted, and cleanup ran (transaction with deletes).
    expect(dbMock.themeContent.upsert).toHaveBeenCalledTimes(2);
    expect(dbMock.themeContent.deleteMany).toHaveBeenCalled();
    expect(dbMock.$transaction).toHaveBeenCalled();
  });
});
