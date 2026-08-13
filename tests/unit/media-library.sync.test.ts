/**
 * Unit Tests für app/services/media-library/sync.server.ts
 *
 * Schwerpunkt ist das Stale-Delete-Verhalten. Regel (wie bei den Stale-Deletes
 * in content-sync.service.ts): gelöscht wird NUR nach einem vollständig
 * durchgelaufenen Sync. Unvollständig ist ein Lauf, wenn
 *
 *   - eine Seite einen Fehler wirft (Abbruch → gar kein Delete),
 *   - das Seitenlimit greift (abgeschnittene Liste),
 *   - Shopify hasNextPage meldet, aber keinen Cursor liefert,
 *   - Shopify 0 Bilder liefert, während lokal noch welche liegen (Störung).
 *
 * DB + Admin-API vollständig gemockt (kein Prisma, kein Netz).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncMediaLibrary } from '~/services/media-library/sync.server';

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const shop = 'test.myshopify.com';
const M1 = 'gid://shopify/MediaImage/1';
const M2 = 'gid://shopify/MediaImage/2';

function imageNode(id: string, url = `https://cdn.shopify.com/s/files/1/x/${id.split('/').pop()}.jpg?v=1`) {
  return {
    node: {
      __typename: 'MediaImage',
      id,
      alt: null,
      createdAt: '2026-01-01T00:00:00Z',
      image: { url },
      mimeType: 'image/jpeg',
    },
  };
}

function page(edges: unknown[], pageInfo: { hasNextPage: boolean; endCursor?: string | null }) {
  return {
    json: async () => ({
      data: { files: { edges, pageInfo: { endCursor: null, ...pageInfo } } },
    }),
  };
}

function makeDb(plan = 'pro', localCount = 0) {
  const db = {
    aISettings: { findUnique: vi.fn().mockResolvedValue({ subscriptionPlan: plan }) },
    mediaLibraryImage: {
      count: vi.fn().mockResolvedValue(localCount),
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    mediaLibrarySyncState: { upsert: vi.fn().mockResolvedValue({}) },
    productImage: { findMany: vi.fn().mockResolvedValue([]) },
    metaobject: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return db;
}

function makeAdmin(...pages: unknown[]) {
  const graphql = vi.fn();
  for (const p of pages) graphql.mockResolvedValueOnce(p);
  return { admin: { graphql } as never, graphql };
}

beforeEach(() => vi.clearAllMocks());

describe('syncMediaLibrary — Plan-Gate', () => {
  it('macht auf einem Plan ohne Bild-Cache gar nichts (kein Shopify-Call, kein Delete)', async () => {
    const db = makeDb('free');
    const { admin, graphql } = makeAdmin();

    const result = await syncMediaLibrary(admin, db as never, shop);

    expect(result).toEqual({ synced: 0, removed: 0 });
    expect(graphql).not.toHaveBeenCalled();
    expect(db.mediaLibraryImage.deleteMany).not.toHaveBeenCalled();
    expect(db.mediaLibrarySyncState.upsert).not.toHaveBeenCalled();
  });

  it('behandelt einen unbekannten Plan-String wie "free"', async () => {
    const db = makeDb('legacy-tier');
    const { admin, graphql } = makeAdmin();

    const result = await syncMediaLibrary(admin, db as never, shop);

    expect(result).toEqual({ synced: 0, removed: 0 });
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe('syncMediaLibrary — vollständiger Lauf', () => {
  it('schreibt jedes Bild mandantengetrennt und räumt danach auf', async () => {
    const db = makeDb();
    db.mediaLibraryImage.deleteMany.mockResolvedValue({ count: 3 });
    const { admin } = makeAdmin(page([imageNode(M1), imageNode(M2)], { hasNextPage: false }));

    const result = await syncMediaLibrary(admin, db as never, shop);

    expect(result).toEqual({ synced: 2, removed: 3 });
    expect(db.mediaLibraryImage.upsert).toHaveBeenCalledTimes(2);

    const first = db.mediaLibraryImage.upsert.mock.calls[0][0];
    expect(first.where).toEqual({ shop_id: { shop, id: M1 } });
    // URL bleibt unverändert (der ?v=-Parameter gehört zur CDN-Adresse),
    // nur der Dateiname wird ohne Query-String abgelegt.
    expect(first.create).toMatchObject({ id: M1, shop, filename: '1.jpg', usageKind: 'unknown' });
    expect(first.create.url).toBe('https://cdn.shopify.com/s/files/1/x/1.jpg?v=1');
    expect(first.update.position).toBe(0);
    expect(db.mediaLibraryImage.upsert.mock.calls[1][0].update.position).toBe(1);

    // Sweep-Kriterium: alles, was in diesem Lauf nicht angefasst wurde.
    expect(db.mediaLibraryImage.deleteMany).toHaveBeenCalledWith({
      where: { shop, lastSyncedAt: { lt: expect.any(Date) } },
    });

    // Marker für neverSynced.
    expect(db.mediaLibrarySyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shop } }),
    );
  });

  it('paginiert über den Cursor und übernimmt nur MediaImage-Knoten', async () => {
    const db = makeDb();
    const { admin, graphql } = makeAdmin(
      page([imageNode(M1), { node: { __typename: 'Video', id: 'gid://shopify/Video/9' } }], {
        hasNextPage: true,
        endCursor: 'CURSOR-1',
      }),
      page([imageNode(M2)], { hasNextPage: false }),
    );

    const result = await syncMediaLibrary(admin, db as never, shop);

    expect(result.synced).toBe(2);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[0][1].variables).toMatchObject({ first: 250, after: null, query: 'media_type:IMAGE' });
    expect(graphql.mock.calls[1][1].variables.after).toBe('CURSOR-1');
    expect(db.mediaLibraryImage.deleteMany).toHaveBeenCalled();
  });

  it('übernimmt die aufgelöste Verwendung in die flachen Spalten', async () => {
    const db = makeDb();
    db.productImage.findMany.mockResolvedValue([
      { mediaId: M1, product: { id: 'gid://shopify/Product/10', title: 'Vase Ascera' } },
    ]);
    const { admin } = makeAdmin(page([imageNode(M1), imageNode(M2)], { hasNextPage: false }));

    await syncMediaLibrary(admin, db as never, shop);

    const [firstCall, secondCall] = db.mediaLibraryImage.upsert.mock.calls;
    expect(firstCall[0].update).toMatchObject({
      usageKind: 'product',
      usageOwnerId: 'gid://shopify/Product/10',
      usageLabel: 'Vase Ascera',
    });
    expect(secondCall[0].update).toMatchObject({ usageKind: 'unknown', usageOwnerId: '', usageLabel: '' });
  });

  it('Bilder ohne URL werden nicht geschrieben, aber vor dem Sweep bewahrt', async () => {
    const db = makeDb();
    const pending = { node: { __typename: 'MediaImage', id: M2, alt: null, image: { url: null } } };
    const { admin } = makeAdmin(page([imageNode(M1), pending], { hasNextPage: false }));

    const result = await syncMediaLibrary(admin, db as never, shop);

    expect(result.synced).toBe(1);
    expect(db.mediaLibraryImage.upsert).toHaveBeenCalledTimes(1);
    expect(db.mediaLibraryImage.updateMany).toHaveBeenCalledWith({
      where: { shop, id: { in: [M2] } },
      data: { lastSyncedAt: expect.any(Date) },
    });
  });
});

describe('syncMediaLibrary — Stale-Delete-Schutz', () => {
  it('Fehler auf einer Folgeseite bricht ab, ohne irgendetwas zu löschen', async () => {
    const db = makeDb();
    const { admin, graphql } = makeAdmin(page([imageNode(M1)], { hasNextPage: true, endCursor: 'C1' }));
    graphql.mockRejectedValueOnce(new Error('network down'));

    await expect(syncMediaLibrary(admin, db as never, shop)).rejects.toThrow('network down');

    expect(db.mediaLibraryImage.deleteMany).not.toHaveBeenCalled();
    expect(db.mediaLibraryImage.upsert).not.toHaveBeenCalled();
    expect(db.mediaLibrarySyncState.upsert).not.toHaveBeenCalled();
  });

  it('GraphQL-Fehler in der Antwort bricht ab, ohne zu löschen', async () => {
    const db = makeDb();
    const { admin } = makeAdmin({
      json: async () => ({ errors: [{ message: 'Throttled' }] }),
    });

    await expect(syncMediaLibrary(admin, db as never, shop)).rejects.toThrow(/Throttled/);

    expect(db.mediaLibraryImage.deleteMany).not.toHaveBeenCalled();
    expect(db.mediaLibrarySyncState.upsert).not.toHaveBeenCalled();
  });

  it('hasNextPage ohne Cursor gilt als unvollständig — Bilder werden geschrieben, nichts gelöscht', async () => {
    const db = makeDb();
    const { admin } = makeAdmin(page([imageNode(M1)], { hasNextPage: true, endCursor: null }));

    const result = await syncMediaLibrary(admin, db as never, shop);

    expect(result).toEqual({ synced: 1, removed: 0 });
    expect(db.mediaLibraryImage.upsert).toHaveBeenCalledTimes(1);
    expect(db.mediaLibraryImage.deleteMany).not.toHaveBeenCalled();
    expect(db.mediaLibrarySyncState.upsert).not.toHaveBeenCalled();
  });

  it('Seitenlimit erreicht → abgeschnittene Liste löscht nichts', async () => {
    const db = makeDb();
    const graphql = vi.fn().mockImplementation(async (_q: string, opts: { variables: { after: string | null } }) => {
      const next = Number(opts.variables.after ?? '0') + 1;
      return page([imageNode(`gid://shopify/MediaImage/${next}`)], {
        hasNextPage: true,
        endCursor: String(next),
      });
    });

    const result = await syncMediaLibrary({ graphql } as never, db as never, shop);

    // MAX_PAGES = 200 Seiten, danach Abbruch der Schleife.
    expect(graphql).toHaveBeenCalledTimes(200);
    expect(result.synced).toBe(200);
    expect(db.mediaLibraryImage.deleteMany).not.toHaveBeenCalled();
    expect(db.mediaLibrarySyncState.upsert).not.toHaveBeenCalled();
  });

  it('0 Bilder bei vorhandenem lokalem Cache → Störungsverdacht, kein Delete', async () => {
    const db = makeDb('pro', 12);
    const { admin } = makeAdmin(page([], { hasNextPage: false }));

    const result = await syncMediaLibrary(admin, db as never, shop);

    expect(result).toEqual({ synced: 0, removed: 0 });
    expect(db.mediaLibraryImage.count).toHaveBeenCalledWith({ where: { shop } });
    expect(db.mediaLibraryImage.deleteMany).not.toHaveBeenCalled();
    expect(db.mediaLibrarySyncState.upsert).not.toHaveBeenCalled();
  });

  it('0 Bilder bei leerem Cache ist ein legitimer Zustand → Marker wird gesetzt', async () => {
    const db = makeDb('pro', 0);
    const { admin } = makeAdmin(page([], { hasNextPage: false }));

    const result = await syncMediaLibrary(admin, db as never, shop);

    expect(result).toEqual({ synced: 0, removed: 0 });
    expect(db.mediaLibrarySyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shop } }),
    );
  });
});
