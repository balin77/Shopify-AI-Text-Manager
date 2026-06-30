/**
 * Unit Tests for BackgroundSyncService.syncSingleThemeGroup() — theme discovery
 *
 * Background: the per-group "Reload" button used to call findMany({ groupId })
 * and throw "Theme group not found" whenever the group had no local rows. That
 * made the reload unable to discover a brand-new theme resource (e.g. a freshly
 * added static section) — it could only refresh groups the DB already knew.
 *
 * The fix delegates the unknown-group case to syncAllThemes() (the authoritative
 * discovery path used by the scheduler + initial sync), then re-reads the group.
 * The "not found" contract is preserved only when the group is STILL absent
 * after a full discovery (a genuinely stale id).
 *
 * Constraints this guards:
 *  - the existing-group refresh path is left completely untouched (no discovery,
 *    its own group-scoped writes still run);
 *  - discovery is only triggered for a genuinely unknown group.
 *
 * DB is mocked (dynamic import("../db.server")); the gateway + sync-utils are
 * mocked so no network is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const dbm = vi.hoisted(() => ({
  themeContentFindMany: vi.fn(),
  themeContentUpdate: vi.fn().mockResolvedValue({}),
  themeTranslationFindMany: vi.fn().mockResolvedValue([]),
  themeTranslationCreate: vi.fn(),
  themeTranslationUpdate: vi.fn(),
  themeTranslationDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  transaction: vi.fn().mockResolvedValue([]),
}));

vi.mock('~/db.server', () => ({
  db: {
    themeContent: { findMany: dbm.themeContentFindMany, update: dbm.themeContentUpdate },
    themeTranslation: {
      findMany: dbm.themeTranslationFindMany,
      create: dbm.themeTranslationCreate,
      update: dbm.themeTranslationUpdate,
      deleteMany: dbm.themeTranslationDeleteMany,
    },
    $transaction: dbm.transaction,
    aISettings: { findUnique: vi.fn().mockResolvedValue({ subscriptionPlan: 'pro' }) },
  },
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// fetchShopLocales → single primary locale, so nonPrimaryLocales is empty and the
// existing-group refresh path makes exactly one translatable-resource call.
vi.mock('~/services/sync-utils', () => ({
  fetchShopLocales: vi.fn().mockResolvedValue([{ locale: 'en', primary: true }]),
  fetchAllTranslations: vi.fn().mockResolvedValue([]),
}));

vi.mock('~/services/shopify-api-gateway.service', () => {
  class ShopifyApiGateway {
    graphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          translatableResource: {
            resourceId: 'gid://shopify/OnlineStoreThemeSettingsDataSections/1',
            translatableContent: [],
          },
        },
      }),
    });
    getQueueStatus = vi.fn().mockReturnValue({ queueLength: 0, isProcessing: false, requestCount: 0 });
    clearQueue = vi.fn();
  }
  return { ShopifyApiGateway };
});

import { BackgroundSyncService } from '~/services/background-sync.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const shop = 'test.myshopify.com';
const makeService = () => new BackgroundSyncService({ graphql: vi.fn() } as never, shop);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BackgroundSyncService.syncSingleThemeGroup() — discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbm.themeTranslationFindMany.mockResolvedValue([]);
    dbm.transaction.mockResolvedValue([]);
  });

  it('runs full theme discovery for an unknown group instead of throwing', async () => {
    const svc = makeService();
    const syncAllSpy = vi.spyOn(svc, 'syncAllThemes').mockResolvedValue(1);

    const discovered = [{ resourceId: 'gid://shopify/x/1', groupId: 'shared_new', domain: 'theme' }];
    dbm.themeContentFindMany
      .mockResolvedValueOnce([])          // existingRows: group unknown locally
      .mockResolvedValueOnce(discovered); // discoveredContent: created by syncAllThemes
    dbm.themeTranslationFindMany.mockResolvedValueOnce([
      { id: 't1', resourceId: 'gid://shopify/x/1', groupId: 'shared_new', key: 'k', locale: 'de', value: 'v' },
    ]);

    const result = await svc.syncSingleThemeGroup('shared_new');

    expect(syncAllSpy).toHaveBeenCalledTimes(1);
    expect(result.themeContent).toEqual(discovered);
    expect((result.translations as unknown[])).toHaveLength(1);
    // Discovery path must NOT run the per-resource refresh writes.
    expect(dbm.themeContentUpdate).not.toHaveBeenCalled();
  });

  it('throws "not found" only when the group is still absent after discovery', async () => {
    const svc = makeService();
    const syncAllSpy = vi.spyOn(svc, 'syncAllThemes').mockResolvedValue(0);
    dbm.themeContentFindMany.mockResolvedValue([]); // unknown before AND after discovery

    await expect(svc.syncSingleThemeGroup('ghost')).rejects.toThrow('Theme group not found: ghost');
    expect(syncAllSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes a known group without triggering discovery', async () => {
    const svc = makeService();
    const syncAllSpy = vi.spyOn(svc, 'syncAllThemes').mockResolvedValue(0);

    const existing = [{ resourceId: 'gid://shopify/x/1', groupId: 'product', domain: 'theme' }];
    dbm.themeContentFindMany
      .mockResolvedValueOnce(existing)  // existingRows (known group)
      .mockResolvedValueOnce(existing); // updatedThemeContent returned at the end
    dbm.themeTranslationFindMany
      .mockResolvedValueOnce([])        // existing translations (differential read)
      .mockResolvedValueOnce([]);       // updatedTranslations at the end

    const result = await svc.syncSingleThemeGroup('product');

    expect(syncAllSpy).not.toHaveBeenCalled();
    expect(dbm.themeContentUpdate).toHaveBeenCalledTimes(1); // known resource refreshed
    expect(result.themeContent).toEqual(existing);
  });

  it('propagates the error when discovery (syncAllThemes) aborts', async () => {
    const svc = makeService();
    vi.spyOn(svc, 'syncAllThemes').mockRejectedValue(
      new Error('Shopify returned 0 theme resources but 5 exist locally - aborting to prevent data loss')
    );
    dbm.themeContentFindMany.mockResolvedValueOnce([]); // unknown group → triggers discovery

    await expect(svc.syncSingleThemeGroup('shared_new')).rejects.toThrow('aborting to prevent data loss');
  });
});

// ── Coalescing guard: concurrent full theme syncs must not run twice ──────────
describe('BackgroundSyncService.syncAllThemes() — per-shop coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('coalesces concurrent full theme syncs for the same shop onto one run', async () => {
    const svc = makeService();
    let resolveRun!: (n: number) => void;
    const runPromise = new Promise<number>((r) => { resolveRun = r; });
    const impl = vi.spyOn(svc as unknown as { runFullThemeSync: () => Promise<number> }, 'runFullThemeSync')
      .mockReturnValue(runPromise);

    const p1 = svc.syncAllThemes();
    const p2 = svc.syncAllThemes(); // in-flight run exists → must coalesce, not start a 2nd

    expect(impl).toHaveBeenCalledTimes(1);

    resolveRun(7);
    await expect(p1).resolves.toBe(7);
    await expect(p2).resolves.toBe(7);

    // Lock released on settle → a subsequent call starts a fresh run.
    impl.mockResolvedValue(3);
    await expect(svc.syncAllThemes()).resolves.toBe(3);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('coalesces across two service instances sharing the same shop', async () => {
    const svc1 = makeService();
    const svc2 = makeService(); // same shop (the scheduler-vs-reload scenario)
    let resolveRun!: (n: number) => void;
    const runPromise = new Promise<number>((r) => { resolveRun = r; });
    const impl1 = vi.spyOn(svc1 as unknown as { runFullThemeSync: () => Promise<number> }, 'runFullThemeSync')
      .mockReturnValue(runPromise);
    const impl2 = vi.spyOn(svc2 as unknown as { runFullThemeSync: () => Promise<number> }, 'runFullThemeSync')
      .mockResolvedValue(99);

    const p1 = svc1.syncAllThemes();
    const p2 = svc2.syncAllThemes(); // same shop → rides svc1's in-flight run

    expect(impl1).toHaveBeenCalledTimes(1);
    expect(impl2).not.toHaveBeenCalled();

    resolveRun(5);
    await expect(p1).resolves.toBe(5);
    await expect(p2).resolves.toBe(5);
  });

  it('does NOT coalesce across different shops', async () => {
    const svcA = makeService();
    const svcB = new BackgroundSyncService({ graphql: vi.fn() } as never, 'other.myshopify.com');
    const implA = vi.spyOn(svcA as unknown as { runFullThemeSync: () => Promise<number> }, 'runFullThemeSync')
      .mockResolvedValue(1);
    const implB = vi.spyOn(svcB as unknown as { runFullThemeSync: () => Promise<number> }, 'runFullThemeSync')
      .mockResolvedValue(2);

    const [a, b] = await Promise.all([svcA.syncAllThemes(), svcB.syncAllThemes()]);

    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(implA).toHaveBeenCalledTimes(1);
    expect(implB).toHaveBeenCalledTimes(1);
  });
});
