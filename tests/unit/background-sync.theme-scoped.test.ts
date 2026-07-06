/**
 * Unit tests for BackgroundSyncService theme-SCOPED enumeration
 * (PLAN_THEME_SELECTION_B_LITE Phase B).
 *
 * `enumerateThemeResourcesFor(resourceType, targetThemeGid)` builds a specific
 * theme's translatable-resource set — which `translatableResources` cannot
 * enumerate — via three strategies keyed on resourceId shape, then fetches
 * content via translatableResourcesByIds. These tests pin the constructed ids.
 *
 * The gateway is mocked and dispatches by query text; DB is not touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let graphqlMock: (q: string, opts: any) => Promise<{ json: () => Promise<unknown> }>;

vi.mock('~/db.server', () => ({ db: {} }));
vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('~/services/sync-utils', () => ({
  fetchShopLocales: vi.fn().mockResolvedValue([{ locale: 'en', primary: true }]),
  fetchAllTranslations: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/services/shopify-api-gateway.service', () => {
  class ShopifyApiGateway {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphql = (q: string, opts: any) => graphqlMock(q, opts);
    getQueueStatus = vi.fn().mockReturnValue({ queueLength: 0, isProcessing: false, requestCount: 0 });
    clearQueue = vi.fn();
  }
  return { ShopifyApiGateway };
});

import { BackgroundSyncService } from '~/services/background-sync.service';

const makeService = () => new BackgroundSyncService({ graphql: vi.fn() } as never, 'test.myshopify.com');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const enumFor = (svc: BackgroundSyncService, type: string, gid: string): Promise<any[]> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).enumerateThemeResourcesFor(type, gid);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonResp = (data: any) => ({ json: async () => ({ data }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const byIdsEcho = (ids: string[]) => jsonResp({
  translatableResourcesByIds: {
    edges: ids.map((id) => ({ node: { resourceId: id, translatableContent: [{ key: 'k', value: 'v', digest: 'd', locale: 'en' }] } })),
  },
});

describe('BackgroundSyncService.enumerateThemeResourcesFor()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Strategy A (LOCALE_CONTENT): constructs a deterministic id from the theme num', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphqlMock = vi.fn(async (q: string, opts: any) => {
      if (q.includes('translatableResourcesByIds')) {
        expect(opts.variables.ids).toEqual(['gid://shopify/OnlineStoreThemeLocaleContent/999']);
        return byIdsEcho(opts.variables.ids);
      }
      return jsonResp({});
    });

    const res = await enumFor(makeService(), 'ONLINE_STORE_THEME_LOCALE_CONTENT', 'gid://shopify/OnlineStoreTheme/999');
    expect(res).toHaveLength(1);
    expect(res[0].resourceId).toBe('gid://shopify/OnlineStoreThemeLocaleContent/999');
    expect(res[0].translatableContent[0].key).toBe('k');
  });

  it('Strategy A (SETTINGS_DATA_SECTIONS): deterministic id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphqlMock = vi.fn(async (q: string, opts: any) => {
      if (q.includes('translatableResourcesByIds')) return byIdsEcho(opts.variables.ids);
      return jsonResp({});
    });
    const res = await enumFor(makeService(), 'ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS', 'gid://shopify/OnlineStoreTheme/42');
    expect(res[0].resourceId).toBe('gid://shopify/OnlineStoreThemeSettingsDataSections/42');
  });

  it('Strategy B (JSON_TEMPLATE): derives ids from theme files with ?theme_id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphqlMock = vi.fn(async (q: string, opts: any) => {
      if (q.includes('translatableResourcesByIds')) {
        expect(opts.variables.ids).toEqual([
          'gid://shopify/OnlineStoreThemeJsonTemplate/article?theme_id=999',
          'gid://shopify/OnlineStoreThemeJsonTemplate/customers/account?theme_id=999',
        ]);
        return byIdsEcho(opts.variables.ids);
      }
      if (q.includes('files(filenames')) {
        expect(opts.variables.filenames).toEqual(['templates/*.json']);
        return jsonResp({ theme: { files: { nodes: [
          { filename: 'templates/article.json' },
          { filename: 'templates/customers/account.json' },
        ] } } });
      }
      return jsonResp({});
    });

    const res = await enumFor(makeService(), 'ONLINE_STORE_THEME_JSON_TEMPLATE', 'gid://shopify/OnlineStoreTheme/999');
    expect(res.map((r) => r.resourceId)).toEqual([
      'gid://shopify/OnlineStoreThemeJsonTemplate/article?theme_id=999',
      'gid://shopify/OnlineStoreThemeJsonTemplate/customers/account?theme_id=999',
    ]);
  });

  it('Strategy C (SETTINGS_CATEGORY): rewrites the MAIN theme_id onto the target', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphqlMock = vi.fn(async (q: string, opts: any) => {
      if (q.includes('translatableResourcesByIds')) {
        expect(opts.variables.ids).toEqual([
          'gid://shopify/OnlineStoreThemeSettingsCategory/Brand?theme_id=999&first_setting_id=x',
        ]);
        return byIdsEcho(opts.variables.ids);
      }
      if (q.includes('mainResourceIds')) {
        return jsonResp({ translatableResources: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [{ node: { resourceId: 'gid://shopify/OnlineStoreThemeSettingsCategory/Brand?theme_id=111&first_setting_id=x' } }],
        } });
      }
      return jsonResp({});
    });

    const res = await enumFor(makeService(), 'ONLINE_STORE_THEME_SETTINGS_CATEGORY', 'gid://shopify/OnlineStoreTheme/999');
    expect(res[0].resourceId).toBe('gid://shopify/OnlineStoreThemeSettingsCategory/Brand?theme_id=999&first_setting_id=x');
  });

  it('skips resources whose translatableResourcesByIds returns empty content', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphqlMock = vi.fn(async (q: string, opts: any) => {
      if (q.includes('translatableResourcesByIds')) {
        return jsonResp({ translatableResourcesByIds: { edges: [
          { node: { resourceId: opts.variables.ids[0], translatableContent: [] } },
        ] } });
      }
      return jsonResp({});
    });
    const res = await enumFor(makeService(), 'ONLINE_STORE_THEME_LOCALE_CONTENT', 'gid://shopify/OnlineStoreTheme/7');
    expect(res).toEqual([]);
  });
});
