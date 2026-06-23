/**
 * Unit Tests for app/services/initial-sync.service.ts — R1 + R5
 *
 * R1 (completion marker integrity): a swallowed non-abort phase error must NOT
 * mark onboarding "done" — otherwise webhook-less content (collections/articles/
 * menus) would stay permanently uncached. Only a fully successful run sets
 * initialSyncCompletedAt; an AbortError propagates and leaves the marker unset.
 *
 * R5 (resync request consistency): requestInitialResync writes
 * initialSyncStats: Prisma.JsonNull (a real SQL NULL, NOT undefined which Prisma
 * treats as "no change") and the same field set in BOTH the create and update
 * branches of the upsert.
 *
 * All collaborators (Prisma, the three sync services) are mocked. i18n is real
 * (pure, deterministic).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ── Mocks ────────────────────────────────────────────────────────────────────

const m = vi.hoisted(() => ({
  aiFindUnique: vi.fn(),
  sisFindUnique: vi.fn(),
  sisUpsert: vi.fn().mockResolvedValue({}),
  productFindMany: vi.fn().mockResolvedValue([]),
  transaction: vi.fn().mockResolvedValue([]),
  syncAllProducts: vi.fn().mockResolvedValue(0),
  syncAllCollections: vi.fn().mockResolvedValue(0),
  syncAllArticles: vi.fn().mockResolvedValue(0),
  syncAllMenus: vi.fn().mockResolvedValue(0),
  syncAllPages: vi.fn().mockResolvedValue(0),
  syncAllPolicies: vi.fn().mockResolvedValue(0),
  syncAllThemes: vi.fn().mockResolvedValue(0),
  syncSystemContent: vi.fn().mockResolvedValue(0),
  syncOnlineStoreExtras: vi.fn().mockResolvedValue(0),
  syncSellingPlans: vi.fn().mockResolvedValue(0),
  metaSyncAll: vi.fn().mockResolvedValue({ definitions: 0, metaobjects: 0, translations: 0 }),
}));

vi.mock('~/db.server', () => ({
  db: {
    aISettings: { findUnique: m.aiFindUnique },
    shopInstallState: { findUnique: m.sisFindUnique, upsert: m.sisUpsert },
    product: { findMany: m.productFindMany, deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    contentTranslation: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    productImage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    productOption: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    productMetafield: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: m.transaction,
  },
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('~/services/product-sync.service', () => ({
  ProductSyncService: class {
    syncAllProducts = (...a: unknown[]) => m.syncAllProducts(...a);
  },
}));

vi.mock('~/services/content-sync.service', () => ({
  ContentSyncService: class {
    syncAllCollections = (...a: unknown[]) => m.syncAllCollections(...a);
    syncAllArticles = (...a: unknown[]) => m.syncAllArticles(...a);
    syncAllMenus = (...a: unknown[]) => m.syncAllMenus(...a);
  },
}));

vi.mock('~/services/background-sync.service', () => ({
  BackgroundSyncService: class {
    syncAllPages = (...a: unknown[]) => m.syncAllPages(...a);
    syncAllPolicies = (...a: unknown[]) => m.syncAllPolicies(...a);
    syncAllThemes = (...a: unknown[]) => m.syncAllThemes(...a);
    syncSystemContent = (...a: unknown[]) => m.syncSystemContent(...a);
    syncOnlineStoreExtras = (...a: unknown[]) => m.syncOnlineStoreExtras(...a);
    syncSellingPlans = (...a: unknown[]) => m.syncSellingPlans(...a);
  },
}));

vi.mock('~/services/metaobject-sync.service', () => ({
  MetaobjectSyncService: class {
    syncAll = (...a: unknown[]) => m.metaSyncAll(...a);
  },
}));

import { runInitialFullSync, requestInitialResync } from '~/services/initial-sync.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const admin = {} as never;
const shop = 'test.myshopify.com';

/** Find the upsert call whose `update` sets the success completion marker. */
function successUpsertCall() {
  return m.sisUpsert.mock.calls.find(
    (c) => (c[0] as any)?.update?.initialSyncCompletedAt instanceof Date,
  );
}
/** Find the upsert call that records a phase failure (initialSyncError). */
function errorUpsertCall() {
  return m.sisUpsert.mock.calls.find(
    (c) =>
      typeof (c[0] as any)?.update?.initialSyncError === 'string' &&
      !((c[0] as any)?.update?.initialSyncCompletedAt instanceof Date),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.aiFindUnique.mockResolvedValue({ subscriptionPlan: 'pro', appLanguage: 'en' });
  m.sisFindUnique.mockResolvedValue(null); // products gate: not completed yet
  m.sisUpsert.mockResolvedValue({});
  m.productFindMany.mockResolvedValue([]);
  for (const fn of [
    m.syncAllProducts, m.syncAllCollections, m.syncAllArticles, m.syncAllMenus,
    m.syncAllPages, m.syncAllPolicies, m.syncAllThemes,
    m.syncSystemContent, m.syncOnlineStoreExtras, m.syncSellingPlans,
  ]) fn.mockResolvedValue(0);
  m.metaSyncAll.mockResolvedValue({ definitions: 0, metaobjects: 0, translations: 0 });
});

// ── R1: completion-marker integrity ───────────────────────────────────────────

describe('runInitialFullSync — R1 completion marker', () => {
  it('full success (pro): completed:true, marker set, force flag cleared', async () => {
    m.syncAllProducts.mockResolvedValue(12);
    m.syncAllCollections.mockResolvedValue(3);

    const res = await runInitialFullSync(admin, shop);

    expect(res.completed).toBe(true);
    expect(res.stats.products).toBe(12);
    expect(res.stats.collections).toBe(3);

    const ok = successUpsertCall();
    expect(ok).toBeDefined();
    expect((ok![0] as any).update.initialSyncCompletedAt).toBeInstanceOf(Date);
    expect((ok![0] as any).create.initialSyncCompletedAt).toBeInstanceOf(Date);
    expect((ok![0] as any).update.initialSyncForceRequested).toBe(false);
    expect((ok![0] as any).update.initialSyncError).toBeNull();
    expect(errorUpsertCall()).toBeUndefined();
  });

  it('a non-abort error in an ENABLED phase → completed:false, NO marker, error recorded', async () => {
    m.syncAllCollections.mockRejectedValue(new Error('transient DB blip'));

    const res = await runInitialFullSync(admin, shop);

    expect(res.completed).toBe(false);
    // The success marker must never be written on a partial failure.
    expect(successUpsertCall()).toBeUndefined();
    const err = errorUpsertCall();
    expect(err).toBeDefined();
    expect(typeof (err![0] as any).update.initialSyncError).toBe('string');
    expect((err![0] as any).update.initialSyncError.length).toBeGreaterThan(0);
    expect((err![0] as any).update.initialSyncCompletedAt).toBeUndefined();
  });

  it('AbortError from a phase propagates and leaves the marker unset', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    m.syncAllCollections.mockRejectedValue(abort);

    await expect(runInitialFullSync(admin, shop)).rejects.toMatchObject({ name: 'AbortError' });

    // Neither the success nor the error upsert ran — the safe "unset" state.
    expect(successUpsertCall()).toBeUndefined();
    expect(errorUpsertCall()).toBeUndefined();
  });

  it('a pre-aborted signal propagates an AbortError before any phase runs', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(
      runInitialFullSync(admin, shop, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(m.syncAllProducts).not.toHaveBeenCalled();
    expect(m.sisUpsert).not.toHaveBeenCalled();
  });

  it('disabled phases (free plan) are skipped — not called, not counted as failure', async () => {
    m.aiFindUnique.mockResolvedValue({ subscriptionPlan: 'free', appLanguage: 'en' });
    m.syncAllProducts.mockResolvedValue(7);
    m.syncAllCollections.mockResolvedValue(2); // collections IS enabled on free

    const res = await runInitialFullSync(admin, shop);

    expect(res.completed).toBe(true); // skips are not failures
    expect(m.syncAllProducts).toHaveBeenCalled();
    expect(m.syncAllCollections).toHaveBeenCalled();
    // free is not entitled to any of these → services never constructed/called.
    expect(m.syncAllArticles).not.toHaveBeenCalled();
    expect(m.syncAllMenus).not.toHaveBeenCalled();
    expect(m.syncAllPages).not.toHaveBeenCalled();
    expect(m.syncAllPolicies).not.toHaveBeenCalled();
    expect(m.syncAllThemes).not.toHaveBeenCalled();
    expect(m.metaSyncAll).not.toHaveBeenCalled();
    expect(successUpsertCall()).toBeDefined();
  });
});

// ── R5: requestInitialResync consistency ──────────────────────────────────────

describe('requestInitialResync — R5 JsonNull + create/update parity', () => {
  it.each([true, false])('force=%s: JsonNull stats + force flag in BOTH create and update', async (force) => {
    await requestInitialResync(shop, { force });

    expect(m.sisUpsert).toHaveBeenCalledTimes(1);
    const arg = m.sisUpsert.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ shop });

    for (const branch of [arg.create, arg.update]) {
      expect(branch.initialSyncCompletedAt).toBeNull();
      // Must be the Prisma.JsonNull sentinel, NOT undefined (Prisma would
      // otherwise leave the previous run's stats untouched).
      expect(branch.initialSyncStats).toBe(Prisma.JsonNull);
      expect(branch.initialSyncStats).not.toBeUndefined();
      expect(branch.initialSyncForceRequested).toBe(force);
      expect(branch.initialSyncError).toBeNull();
      expect(branch.initialSyncPercent).toBe(0);
      expect(branch.initialSyncPhase).toBeNull();
    }
  });
});
