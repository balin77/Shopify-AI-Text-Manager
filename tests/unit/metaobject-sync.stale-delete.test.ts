/**
 * Unit Tests for app/services/metaobject-sync.service.ts — Lücke A
 *
 * Metaobjects have no Shopify webhook either. Two stale-delete levels were
 * added:
 *
 *  - per-TYPE (syncMetaobjectsForType): metaobjects whose id is `notIn` the
 *    live set for that type are deleted together with their
 *    MetaobjectTranslation rows. Guarded by the same >=250 truncation /
 *    0-with-local-rows health checks as articles.
 *  - definition-LEVEL (syncAll): when a whole definition/type disappears in
 *    Shopify the per-type loop never visits it again, so its definition +
 *    metaobjects + translations are cascaded via `type notIn liveTypes`.
 *    Guarded by a >=100 truncation / 0-with-local-rows check.
 *
 * DB mocked; fetch + translation helpers stubbed (no network).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbm = vi.hoisted(() => ({
  moCount: vi.fn().mockResolvedValue(0),
  moFindMany: vi.fn().mockResolvedValue([]),
  moDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  moUpsert: vi.fn().mockResolvedValue({}),
  motDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  defCount: vi.fn().mockResolvedValue(0),
  defDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  transaction: vi.fn(),
}));

vi.mock('~/db.server', () => {
  const db = {
    metaobject: {
      count: dbm.moCount,
      findMany: dbm.moFindMany,
      deleteMany: dbm.moDeleteMany,
      upsert: dbm.moUpsert,
    },
    metaobjectTranslation: { deleteMany: dbm.motDeleteMany },
    metaobjectDefinition: { count: dbm.defCount, deleteMany: dbm.defDeleteMany },
    $transaction: dbm.transaction,
  };
  (dbm.transaction as any).mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  return { db };
});

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MetaobjectSyncService } from '~/services/metaobject-sync.service';

const shop = 'test.myshopify.com';

function mo(id: string, type = 't') {
  return { id, handle: `h-${id}`, displayName: id, type, updatedAt: '2026-01-01T00:00:00Z', fields: [] };
}
function makeService() {
  const svc = new MetaobjectSyncService({ graphql: vi.fn() } as never, shop);
  // Avoid network: no real locale fetch / translation pull.
  vi.spyOn(svc as any, 'getLocales').mockResolvedValue([]);
  vi.spyOn(svc as any, 'syncTranslationsBulk').mockResolvedValue(0);
  return svc;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbm.moCount.mockResolvedValue(0);
  dbm.moFindMany.mockResolvedValue([]);
  dbm.moDeleteMany.mockResolvedValue({ count: 0 });
  dbm.moUpsert.mockResolvedValue({});
  dbm.motDeleteMany.mockResolvedValue({ count: 0 });
  dbm.defCount.mockResolvedValue(0);
  dbm.defDeleteMany.mockResolvedValue({ count: 0 });
});

describe('syncMetaobjectsForType — per-type stale-delete', () => {
  it('deletes metaobjects notIn the live set + their translations', async () => {
    const svc = makeService();
    vi.spyOn(svc as any, 'fetchMetaobjects').mockResolvedValue([mo('M1'), mo('M2')]);
    dbm.moFindMany.mockResolvedValue([{ id: 'STALE' }]);
    dbm.moDeleteMany.mockResolvedValue({ count: 1 });

    const res = await svc.syncMetaobjectsForType('t');

    expect(dbm.moDeleteMany).toHaveBeenCalledWith({
      where: { shop, type: 't', id: { notIn: ['M1', 'M2'] } },
    });
    expect(dbm.motDeleteMany).toHaveBeenCalledWith({
      where: { shop, metaobjectId: { in: ['STALE'] } },
    });
    expect(res.metaobjects).toBe(2);
  });

  it('>=250 results → truncation guard skips the stale-delete', async () => {
    const svc = makeService();
    const many = Array.from({ length: 250 }, (_, i) => mo(`M${i}`));
    vi.spyOn(svc as any, 'fetchMetaobjects').mockResolvedValue(many);

    await svc.syncMetaobjectsForType('t');

    expect(dbm.transaction).not.toHaveBeenCalled();
    expect(dbm.moCount).not.toHaveBeenCalled();
    expect(dbm.moDeleteMany).not.toHaveBeenCalled();
  });

  it('0 results + local rows present → skip delete (no throw, no transaction)', async () => {
    const svc = makeService();
    vi.spyOn(svc as any, 'fetchMetaobjects').mockResolvedValue([]);
    dbm.moCount.mockResolvedValue(4);

    const res = await svc.syncMetaobjectsForType('t');

    expect(dbm.moCount).toHaveBeenCalledWith({ where: { shop, type: 't' } });
    expect(dbm.transaction).not.toHaveBeenCalled();
    expect(dbm.moDeleteMany).not.toHaveBeenCalled();
    expect(res.metaobjects).toBe(0);
  });
});

describe('syncAll — definition-level cascade stale-delete', () => {
  function serviceWithDefs(defs: Array<{ id: string; type: string }>) {
    const svc = makeService();
    vi.spyOn(svc as any, 'syncDefinitions').mockResolvedValue(
      defs.map((d) => ({ ...d, name: d.type, description: null, fieldDefinitions: [] })),
    );
    vi.spyOn(svc as any, 'syncMetaobjectsForType').mockResolvedValue({ metaobjects: 0, translations: 0 });
    return svc;
  }

  it('removed definitions cascade: defs + metaobjects + translations pruned by type notIn liveTypes', async () => {
    const svc = serviceWithDefs([{ id: 'D1', type: 'a' }, { id: 'D2', type: 'b' }]);

    await svc.syncAll();

    expect(dbm.defDeleteMany).toHaveBeenCalledWith({
      where: { shop, id: { notIn: ['D1', 'D2'] } },
    });
    expect(dbm.motDeleteMany).toHaveBeenCalledWith({
      where: { shop, type: { notIn: ['a', 'b'] } },
    });
    expect(dbm.moDeleteMany).toHaveBeenCalledWith({
      where: { shop, type: { notIn: ['a', 'b'] } },
    });
  });

  it('>=100 definitions → truncation guard skips the definition-level cascade', async () => {
    const defs = Array.from({ length: 100 }, (_, i) => ({ id: `D${i}`, type: `t${i}` }));
    const svc = serviceWithDefs(defs);

    await svc.syncAll();

    expect(dbm.defDeleteMany).not.toHaveBeenCalled();
  });

  it('0 definitions + local definitions present → skip cascade (no delete)', async () => {
    const svc = serviceWithDefs([]);
    dbm.defCount.mockResolvedValue(2);

    await svc.syncAll();

    expect(dbm.defCount).toHaveBeenCalledWith({ where: { shop } });
    expect(dbm.defDeleteMany).not.toHaveBeenCalled();
    expect(dbm.moDeleteMany).not.toHaveBeenCalled();
  });
});
