/**
 * Unit Tests for BackgroundSyncService.syncAll()
 *
 * Focus: The Promise.all() + per-type .catch() error isolation pattern, now
 * plan-aware. A single failing content-type must return 0 and not throw — the
 * overall syncAll() should still resolve with stats from the other types.
 * Disabled phases (per plan scope) resolve to 0 without being called.
 *
 * ✅ No real Shopify needed (admin + gateway are mocked)
 * ✅ DB is mocked (syncAll now reads the plan from aISettings)
 * ✅ ContentSyncService is mocked (articles + menus phases)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

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

// syncAll() now resolves the plan from aISettings — default to "pro" so every
// phase is entitled and the spied methods actually run.
const mockFindUnique = vi.fn().mockResolvedValue({ subscriptionPlan: 'pro' });
vi.mock('~/db.server', () => ({
  db: { aISettings: { findUnique: (...a: unknown[]) => mockFindUnique(...a) } },
}));

// Articles + Menus run through ContentSyncService.
const mockSyncAllArticles = vi.fn().mockResolvedValue(0);
const mockSyncAllMenus = vi.fn().mockResolvedValue(0);
vi.mock('~/services/content-sync.service', () => ({
  ContentSyncService: class {
    syncAllArticles = (...a: unknown[]) => mockSyncAllArticles(...a);
    syncAllMenus = (...a: unknown[]) => mockSyncAllMenus(...a);
  },
}));

import { BackgroundSyncService } from '~/services/background-sync.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockAdmin = { graphql: vi.fn() };
const shop = 'test.myshopify.com';

function makeService(): BackgroundSyncService {
  return new BackgroundSyncService(mockAdmin, shop);
}

type SyncResult = number | Error;

function spyAllMethods(
  service: BackgroundSyncService,
  {
    pages = 0, policies = 0, themes = 0, metaobjects = 0, articles = 0, menus = 0,
  }: {
    pages?: SyncResult; policies?: SyncResult; themes?: SyncResult;
    metaobjects?: SyncResult; articles?: SyncResult; menus?: SyncResult;
  } = {},
) {
  function mockMethod(name: string, value: SyncResult) {
    return value instanceof Error
      ? vi.spyOn(service as any, name as any).mockRejectedValue(value)
      : vi.spyOn(service as any, name as any).mockResolvedValue(value);
  }
  const setCs = (fn: ReturnType<typeof vi.fn>, value: SyncResult) =>
    value instanceof Error ? fn.mockRejectedValue(value) : fn.mockResolvedValue(value);

  setCs(mockSyncAllArticles, articles);
  setCs(mockSyncAllMenus, menus);
  return {
    spyPages: mockMethod('syncAllPages', pages),
    spyPolicies: mockMethod('syncAllPolicies', policies),
    spyThemes: mockMethod('syncAllThemes', themes),
    spyMetaobjects: mockMethod('syncAllMetaobjects', metaobjects),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BackgroundSyncService.syncAll()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue({ subscriptionPlan: 'pro' });
  });

  it('aggregates counts correctly when all content types succeed', async () => {
    const service = makeService();
    spyAllMethods(service, { pages: 10, policies: 2, themes: 5, metaobjects: 3, articles: 8, menus: 1 });

    const stats = await service.syncAll();

    expect(stats.pages).toBe(10);
    expect(stats.policies).toBe(2);
    expect(stats.themes).toBe(5);
    expect(stats.metaobjects).toBe(3);
    expect(stats.articles).toBe(8);
    expect(stats.menus).toBe(1);
    expect(stats.total).toBe(29);
  });

  it('returns 0 for a failing type and still resolves with the rest', async () => {
    const service = makeService();
    spyAllMethods(service, {
      pages: new Error('DB connection failed'),
      policies: 4, themes: 7, metaobjects: 1, articles: 3, menus: 2,
    });

    const stats = await service.syncAll();

    expect(stats.pages).toBe(0); // failed → isolated to 0
    expect(stats.policies).toBe(4);
    expect(stats.themes).toBe(7);
    expect(stats.metaobjects).toBe(1);
    expect(stats.articles).toBe(3);
    expect(stats.menus).toBe(2);
    expect(stats.total).toBe(17);
  });

  it('does NOT throw when multiple content types fail simultaneously', async () => {
    const service = makeService();
    spyAllMethods(service, {
      pages: new Error('pages error'),
      policies: new Error('policies error'),
      themes: 6,
      metaobjects: new Error('metaobjects error'),
      articles: new Error('articles error'),
      menus: 4,
    });

    await expect(service.syncAll()).resolves.toMatchObject({
      pages: 0, policies: 0, themes: 6, metaobjects: 0, articles: 0, menus: 4, total: 10,
    });
  });

  it('skips disabled phases on a lower plan (free → only entitled types)', async () => {
    mockFindUnique.mockResolvedValue({ subscriptionPlan: 'free' });
    const service = makeService();
    const { spyPages, spyPolicies, spyThemes, spyMetaobjects } =
      spyAllMethods(service, { pages: 9, policies: 9, themes: 9, metaobjects: 9, articles: 9, menus: 9 });

    const stats = await service.syncAll();

    // free entitles none of these webhook-less types.
    expect(spyPages).not.toHaveBeenCalled();
    expect(spyPolicies).not.toHaveBeenCalled();
    expect(spyThemes).not.toHaveBeenCalled();
    expect(spyMetaobjects).not.toHaveBeenCalled();
    expect(mockSyncAllArticles).not.toHaveBeenCalled();
    expect(mockSyncAllMenus).not.toHaveBeenCalled();
    expect(stats.total).toBe(0);
  });

  it('includes a non-negative duration in the returned stats', async () => {
    const service = makeService();
    spyAllMethods(service, {});

    const stats = await service.syncAll();

    expect(typeof stats.duration).toBe('number');
    expect(stats.duration).toBeGreaterThanOrEqual(0);
  });
});
