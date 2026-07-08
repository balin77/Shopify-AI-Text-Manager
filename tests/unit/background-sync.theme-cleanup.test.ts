/**
 * Regression guard for the Phase B review's HIGH finding: a FULL theme sync must
 * NOT delete rows belonging to a theme it did not enumerate. `translatableResources`
 * only ever returns the published/MAIN theme, so the combination cleanup must be
 * scoped to the theme(s) actually synced this run (syncedThemeIds) — otherwise
 * every non-MAIN row written by syncTheme() is swept on the next full cycle.
 *
 * Drives runFullThemeSync in FULL mode with a single MAIN-ish resource and a
 * "ghost" existing row, then asserts the cleanup deleteMany is theme-scoped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbm = vi.hoisted(() => ({
  themeContentFindMany: vi.fn(),
  themeContentUpsert: vi.fn().mockResolvedValue({}),
  themeContentUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  themeContentDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  themeContentCount: vi.fn().mockResolvedValue(0),
  themeTranslationFindMany: vi.fn().mockResolvedValue([]),
  themeTranslationCreateMany: vi.fn().mockResolvedValue({ count: 0 }),
  themeTranslationUpdate: vi.fn().mockResolvedValue({}),
  themeTranslationDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  themeTranslationCount: vi.fn().mockResolvedValue(0),
  transaction: vi.fn().mockResolvedValue([]),
}));

vi.mock('~/db.server', () => ({
  db: {
    themeContent: {
      findMany: dbm.themeContentFindMany,
      upsert: dbm.themeContentUpsert,
      updateMany: dbm.themeContentUpdateMany,
      deleteMany: dbm.themeContentDeleteMany,
      count: dbm.themeContentCount,
    },
    themeTranslation: {
      findMany: dbm.themeTranslationFindMany,
      createMany: dbm.themeTranslationCreateMany,
      update: dbm.themeTranslationUpdate,
      deleteMany: dbm.themeTranslationDeleteMany,
      count: dbm.themeTranslationCount,
    },
    $transaction: dbm.transaction,
  },
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('~/services/sync-utils', () => ({
  // single primary locale → nonPrimaryLocales empty → no translation fetch
  fetchShopLocales: vi.fn().mockResolvedValue([{ locale: 'en', primary: true }]),
  fetchAllTranslations: vi.fn().mockResolvedValue([]),
  fetchShopMarkets: vi.fn().mockResolvedValue([]),
  // Pure helpers — mirror the real implementations so market-aware code paths
  // behave exactly like production with zero markets.
  marketLayersForLocale: (markets: { id: string; localeCodes: string[] }[], locale: string) =>
    ['', ...markets.filter((m) => m.localeCodes.length === 0 || m.localeCodes.includes(locale)).map((m) => m.id)],
  fetchedMarketLayers: (markets: { id: string }[]) => ['', ...markets.map((m) => m.id)],
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let graphqlMock: (q: string, opts: any) => Promise<{ json: () => Promise<unknown> }>;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonResp = (data: any) => ({ json: async () => ({ data }) });

describe('runFullThemeSync() FULL-mode cleanup is theme-scoped (Phase B review finding 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbm.themeContentCount.mockResolvedValue(0);
    dbm.themeTranslationCount.mockResolvedValue(0);
    dbm.transaction.mockResolvedValue([]);
    // Cleanup candidate: a row whose (resourceId, groupId) was NOT synced this
    // run — stands in for a theme-scoped (non-MAIN) row. Must NOT be deleted
    // unscoped.
    dbm.themeContentFindMany.mockResolvedValue([{ resourceId: 'gid://shopify/OnlineStoreThemeJsonTemplate/x?theme_id=999', groupId: 'ghost' }]);
    dbm.themeTranslationFindMany.mockResolvedValue([]);
  });

  it('scopes the combination-cleanup deleteMany to the enumerated theme(s), not all themes', async () => {
    // FULL mode: only the MAIN theme's LOCALE_CONTENT resource is enumerated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphqlMock = vi.fn(async (q: string, opts: any) => {
      if (q.includes('getThemeTranslatableResources')) {
        if (opts.variables.resourceType === 'ONLINE_STORE_THEME_LOCALE_CONTENT') {
          return jsonResp({ translatableResources: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [{ node: {
              resourceId: 'gid://shopify/OnlineStoreThemeLocaleContent/111',
              translatableContent: [{ key: 'general.title', value: 'Hi', digest: 'd', locale: 'en' }],
            } }],
          } });
        }
        return jsonResp({ translatableResources: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } });
      }
      if (q.includes('themeIdsForCleanup')) {
        // Empty → orphan-theme cleanup is skipped, so its deleteMany can't
        // pollute the assertion below.
        return jsonResp({ themes: { nodes: [] } });
      }
      return jsonResp({});
    });

    const svc = new BackgroundSyncService({ graphql: vi.fn() } as never, 'test.myshopify.com');
    await svc.syncAllThemes();

    // The combination-cleanup deleteMany is the one carrying an OR of
    // resourceId/groupId conditions. It MUST also be scoped by themeId.
    const comboDeletes = dbm.themeContentDeleteMany.mock.calls
      .map((c) => c[0]?.where)
      .filter((w) => w && Array.isArray(w.OR));
    expect(comboDeletes.length).toBeGreaterThan(0);
    for (const where of comboDeletes) {
      expect(where.themeId).toBeDefined();
      expect(where.themeId).toHaveProperty('in');
      expect(Array.isArray(where.themeId.in)).toBe(true);
      // The MAIN LOCALE_CONTENT resourceId carries no ?theme_id= → stamped "".
      // The ghost (theme 999) row's themeId is NOT in this set, so it survives.
      expect(where.themeId.in).not.toContain('gid://shopify/OnlineStoreTheme/999');
    }
  });
});
