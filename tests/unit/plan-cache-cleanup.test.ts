/**
 * Unit Tests for app/utils/planCacheCleanup.ts — R2 fix
 *
 * R2: on a downgrade the cleanup must prune content the new plan is no longer
 * entitled to. The two phases that have no per-item cap (menus, metaobjects)
 * are gated on getSyncScope(newPlan) — the SAME scope the sync uses — so cache
 * and sync can never disagree.
 *
 *  - free (pro→free downgrade): scope.menus / scope.metaobjects disabled
 *    → deleteMenus + deleteMetaobjects run, stats reflect the deleted counts.
 *  - pro / max: both phases entitled → neither delete runs.
 *  - deleteMetaobjects wipes metaobjectTranslation + metaobject +
 *    metaobjectDefinition for the shop, inside one $transaction.
 *
 * DB is fully mocked (billing.server.test.ts convention).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db } = vi.hoisted(() => {
  const deleteMany = () => vi.fn().mockResolvedValue({ count: 0 });
  const findMany = () => vi.fn().mockResolvedValue([]);
  const dbObj = {
    product: { findMany: findMany(), deleteMany: deleteMany() },
    productImage: { deleteMany: deleteMany() },
    productOption: { deleteMany: deleteMany() },
    productMetafield: { deleteMany: deleteMany() },
    collection: { findMany: findMany(), deleteMany: deleteMany() },
    article: { findMany: findMany(), deleteMany: deleteMany() },
    page: { findMany: findMany(), deleteMany: deleteMany() },
    shopPolicy: { findMany: findMany(), deleteMany: deleteMany() },
    themeContent: { deleteMany: deleteMany() },
    themeTranslation: { findMany: findMany(), deleteMany: deleteMany() },
    contentTranslation: { deleteMany: deleteMany() },
    menu: { deleteMany: deleteMany() },
    metaobject: { deleteMany: deleteMany() },
    metaobjectTranslation: { deleteMany: deleteMany() },
    metaobjectDefinition: { deleteMany: deleteMany() },
    mediaLibraryImage: { deleteMany: deleteMany() },
    mediaLibrarySyncState: { deleteMany: deleteMany() },
    // cleanup uses db.$transaction(async (tx) => …) — tx is the same client.
    $transaction: vi.fn(),
  };
  (dbObj.$transaction as any).mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(dbObj) : Promise.all(arg as unknown[]),
  );
  return { db: dbObj };
});

vi.mock('~/db.server', () => ({ db }));
vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cleanupCacheForPlan } from '~/utils/planCacheCleanup';

const shop = 'test.myshopify.com';

function resetDb() {
  for (const model of Object.values(db)) {
    if (typeof model === 'function') continue;
    for (const fn of Object.values(model as Record<string, ReturnType<typeof vi.fn>>)) {
      fn.mockClear();
    }
  }
  (db.$transaction as any).mockClear();
  (db.$transaction as any).mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : Promise.all(arg as unknown[]),
  );
}

describe('cleanupCacheForPlan — R2 menus/metaobjects pruning', () => {
  beforeEach(() => resetDb());

  it('downgrade to free deletes menus AND metaobjects (scope disables both)', async () => {
    db.menu.deleteMany.mockResolvedValueOnce({ count: 4 });
    db.metaobject.deleteMany.mockResolvedValueOnce({ count: 7 });

    const stats = await cleanupCacheForPlan(shop, 'free');

    expect(db.menu.deleteMany).toHaveBeenCalledWith({ where: { shop } });
    expect(db.metaobject.deleteMany).toHaveBeenCalledWith({ where: { shop } });
    expect(stats.deletedMenus).toBe(4);
    expect(stats.deletedMetaobjects).toBe(7);
  });

  it('deleteMetaobjects wipes translations + metaobjects + definitions in one transaction', async () => {
    await cleanupCacheForPlan(shop, 'free');

    expect(db.metaobjectTranslation.deleteMany).toHaveBeenCalledWith({ where: { shop } });
    expect(db.metaobject.deleteMany).toHaveBeenCalledWith({ where: { shop } });
    expect(db.metaobjectDefinition.deleteMany).toHaveBeenCalledWith({ where: { shop } });
    // All three run via db.$transaction (callback form).
    expect(db.$transaction).toHaveBeenCalled();
  });

  it.each(['pro', 'max'] as const)(
    '%s keeps menus + metaobjects (scope entitles both → no delete)',
    async (plan) => {
      const stats = await cleanupCacheForPlan(shop, plan);

      expect(db.menu.deleteMany).not.toHaveBeenCalled();
      expect(db.metaobjectDefinition.deleteMany).not.toHaveBeenCalled();
      expect(db.metaobjectTranslation.deleteMany).not.toHaveBeenCalled();
      expect(stats.deletedMenus).toBe(0);
      expect(stats.deletedMetaobjects).toBe(0);
    },
  );

  it('downgrade to basic still prunes metaobjects + menus (not entitled below pro)', async () => {
    db.menu.deleteMany.mockResolvedValueOnce({ count: 2 });
    db.metaobject.deleteMany.mockResolvedValueOnce({ count: 3 });

    const stats = await cleanupCacheForPlan(shop, 'basic');

    expect(db.menu.deleteMany).toHaveBeenCalledWith({ where: { shop } });
    expect(db.metaobject.deleteMany).toHaveBeenCalledWith({ where: { shop } });
    expect(stats.deletedMenus).toBe(2);
    expect(stats.deletedMetaobjects).toBe(3);
  });
});
