/**
 * Unit Tests for MetaobjectSyncService.syncAll() — definition discovery
 *
 * The list-level "sync from Shopify" button for the Metaobjects tab routes to
 * /api/sync-content?types=metaobjects → MetaobjectSyncService.syncAll(). That
 * full sync must DISCOVER brand-new metaobject *definitions* (types the user
 * created in Shopify that the app has never seen) by upserting them — not just
 * refresh instances of already-known types.
 *
 * DB mocked; getLocales + per-type sync stubbed so no network is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbm = vi.hoisted(() => ({
  defUpsert: vi.fn().mockResolvedValue({}),
  defCount: vi.fn().mockResolvedValue(0),
  defDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  moDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  motDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  transaction: vi.fn(),
}));

vi.mock('~/db.server', () => {
  const db = {
    metaobjectDefinition: { upsert: dbm.defUpsert, count: dbm.defCount, deleteMany: dbm.defDeleteMany },
    metaobject: { deleteMany: dbm.moDeleteMany },
    metaobjectTranslation: { deleteMany: dbm.motDeleteMany },
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

/** A Shopify GraphQL response stub: `.json()` resolves the given payload. */
const gql = (payload: unknown) => ({ json: async () => payload });

const definitionsPayload = (defs: { id: string; type: string; name?: string }[]) => ({
  data: {
    metaobjectDefinitions: {
      edges: defs.map((d) => ({
        node: { id: d.id, type: d.type, name: d.name ?? d.type, description: null, fieldDefinitions: [] },
      })),
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbm.defUpsert.mockResolvedValue({});
  dbm.defCount.mockResolvedValue(0);
  dbm.defDeleteMany.mockResolvedValue({ count: 0 });
  (dbm.transaction as any).mockImplementation((cb: (tx: unknown) => unknown) =>
    cb({
      metaobjectDefinition: { deleteMany: dbm.defDeleteMany },
      metaobject: { deleteMany: dbm.moDeleteMany },
      metaobjectTranslation: { deleteMany: dbm.motDeleteMany },
    }),
  );
});

describe('MetaobjectSyncService.syncAll() — definition discovery', () => {
  it('discovers and upserts a brand-new definition (type) from Shopify', async () => {
    const graphql = vi.fn().mockResolvedValue(
      gql(definitionsPayload([{ id: 'gid://shopify/MetaobjectDefinition/99', type: 'author', name: 'Author' }])),
    );
    const svc = new MetaobjectSyncService({ graphql } as never, shop);
    vi.spyOn(svc as any, 'getLocales').mockResolvedValue([]);
    const perType = vi
      .spyOn(svc, 'syncMetaobjectsForType')
      .mockResolvedValue({ metaobjects: 0, translations: 0 });

    const result = await svc.syncAll();

    // The new definition is written to the DB (create branch of the upsert).
    expect(dbm.defUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = dbm.defUpsert.mock.calls[0][0];
    expect(upsertArg.where.shop_id).toEqual({ shop, id: 'gid://shopify/MetaobjectDefinition/99' });
    expect(upsertArg.create.type).toBe('author');

    // And its instances get synced via the per-type path.
    expect(perType).toHaveBeenCalledWith('author');
    expect(result.definitions).toBe(1);
  });

  it('does not mass-delete definitions when Shopify returns zero (outage guard)', async () => {
    const graphql = vi.fn().mockResolvedValue(gql(definitionsPayload([])));
    const svc = new MetaobjectSyncService({ graphql } as never, shop);
    vi.spyOn(svc as any, 'getLocales').mockResolvedValue([]);
    vi.spyOn(svc, 'syncMetaobjectsForType').mockResolvedValue({ metaobjects: 0, translations: 0 });
    dbm.defCount.mockResolvedValue(3); // local rows exist → empty response must NOT delete

    const result = await svc.syncAll();

    expect(dbm.defDeleteMany).not.toHaveBeenCalled();
    expect(result.definitions).toBe(0);
  });
});
