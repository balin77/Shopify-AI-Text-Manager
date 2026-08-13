/**
 * Unit Tests für app/services/media-library/load.server.ts
 *
 * `loadMediaLibraryImages` ist der vereinbarte Integrationspunkt für den
 * Bulk-Editor — Signatur und Zeilenform sind bindend. Getestet werden deshalb
 * die Filterzusammensetzung (jede Query auf `shop` gefiltert), die
 * Paginierungs-Grenzen und die Abbildung auf MediaLibraryImageRow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadMediaLibraryImages, toUsageKind } from '~/services/media-library/load.server';

const shop = 'test.myshopify.com';

function makeDb(opts: {
  records?: Array<Record<string, unknown>>;
  total?: number;
  syncState?: { lastFullSyncAt: Date } | null;
}) {
  const findMany = vi.fn().mockResolvedValue(opts.records ?? []);
  const count = vi.fn().mockResolvedValue(opts.total ?? 0);
  const findUnique = vi.fn().mockResolvedValue(opts.syncState ?? null);
  return {
    db: {
      mediaLibraryImage: { findMany, count },
      mediaLibrarySyncState: { findUnique },
    } as never,
    findMany,
    count,
    findUnique,
  };
}

const BASE = { search: '', skip: 0, take: 50, excludeProductMedia: false };

beforeEach(() => vi.clearAllMocks());

describe('loadMediaLibraryImages — Filter', () => {
  it('filtert immer auf den Shop — auch die Zählung', async () => {
    const { db, findMany, count } = makeDb({});

    await loadMediaLibraryImages(db, shop, BASE);

    expect(findMany.mock.calls[0][0].where).toEqual({ shop });
    expect(count.mock.calls[0][0].where).toEqual({ shop });
  });

  it('excludeProductMedia schliesst Produktmedien über die flache Spalte aus', async () => {
    const { db, findMany, count } = makeDb({});

    await loadMediaLibraryImages(db, shop, { ...BASE, excludeProductMedia: true });

    const where = findMany.mock.calls[0][0].where;
    expect(where.shop).toBe(shop);
    expect(where.AND).toContainEqual({ usageKind: { not: 'product' } });
    // Zählung und Seite müssen exakt dieselbe Bedingung benutzen, sonst
    // stimmt die Paginierung im Editor nicht.
    expect(count.mock.calls[0][0].where).toEqual(where);
  });

  it('missingAltOnly trifft NULL und leeren String', async () => {
    const { db, findMany } = makeDb({});

    await loadMediaLibraryImages(db, shop, { ...BASE, missingAltOnly: true });

    expect(findMany.mock.calls[0][0].where.AND).toContainEqual({
      OR: [{ altText: null }, { altText: '' }],
    });
  });

  it('search sucht case-insensitiv über Dateiname, Alt-Text und Besitzer-Label', async () => {
    const { db, findMany } = makeDb({});

    await loadMediaLibraryImages(db, shop, { ...BASE, search: '  Vase  ' });

    expect(findMany.mock.calls[0][0].where.AND).toContainEqual({
      OR: [
        { filename: { contains: 'Vase', mode: 'insensitive' } },
        { altText: { contains: 'Vase', mode: 'insensitive' } },
        { usageLabel: { contains: 'Vase', mode: 'insensitive' } },
      ],
    });
  });

  it('kombiniert alle Filter mit UND', async () => {
    const { db, findMany } = makeDb({});

    await loadMediaLibraryImages(db, shop, {
      ...BASE,
      search: 'vase',
      excludeProductMedia: true,
      missingAltOnly: true,
    });

    expect(findMany.mock.calls[0][0].where.AND).toHaveLength(3);
  });

  it('leerer Suchstring erzeugt keine Bedingung', async () => {
    const { db, findMany } = makeDb({});

    await loadMediaLibraryImages(db, shop, { ...BASE, search: '   ' });

    expect(findMany.mock.calls[0][0].where).toEqual({ shop });
  });
});

describe('loadMediaLibraryImages — Paginierung', () => {
  it('reicht skip/take durch und sortiert stabil', async () => {
    const { db, findMany } = makeDb({});

    await loadMediaLibraryImages(db, shop, { ...BASE, skip: 100, take: 25 });

    expect(findMany.mock.calls[0][0]).toMatchObject({
      skip: 100,
      take: 25,
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  });

  it('deckelt take und normalisiert negative Werte', async () => {
    const { db, findMany } = makeDb({});

    await loadMediaLibraryImages(db, shop, { ...BASE, skip: -5, take: 100000 });

    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 250 });
  });

  it('take=0 fragt keine Zeilen ab, liefert aber weiterhin total', async () => {
    const { db, findMany, count } = makeDb({ total: 42 });

    const result = await loadMediaLibraryImages(db, shop, { ...BASE, take: 0 });

    expect(findMany).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalled();
    expect(result).toMatchObject({ rows: [], total: 42 });
  });
});

describe('loadMediaLibraryImages — Zeilenform', () => {
  it('bildet den Cache auf MediaLibraryImageRow ab ("" statt null)', async () => {
    const { db } = makeDb({
      records: [
        {
          id: 'gid://shopify/MediaImage/1',
          url: 'https://cdn.shopify.com/x/1.jpg',
          altText: null,
          filename: '1.jpg',
          usageKind: 'product',
          usageOwnerId: 'gid://shopify/Product/10',
          usageLabel: 'Vase Ascera',
        },
      ],
      total: 1,
      syncState: { lastFullSyncAt: new Date('2026-08-13T00:00:00Z') },
    });

    const { rows, total, neverSynced } = await loadMediaLibraryImages(db, shop, BASE);

    expect(rows).toEqual([
      {
        mediaId: 'gid://shopify/MediaImage/1',
        url: 'https://cdn.shopify.com/x/1.jpg',
        altText: '',
        filename: '1.jpg',
        usageKind: 'product',
        usageOwnerId: 'gid://shopify/Product/10',
        usageLabel: 'Vase Ascera',
      },
    ]);
    expect(total).toBe(1);
    expect(neverSynced).toBe(false);
  });

  it('unbekannter usageKind aus der DB fällt auf "unknown" zurück', async () => {
    const { db } = makeDb({
      records: [
        {
          id: 'gid://shopify/MediaImage/1',
          url: 'u',
          altText: 'a',
          filename: 'f',
          usageKind: 'brandneu',
          usageOwnerId: '',
          usageLabel: '',
        },
      ],
    });

    const { rows } = await loadMediaLibraryImages(db, shop, BASE);

    expect(rows[0].usageKind).toBe('unknown');
    expect(toUsageKind('metaobject')).toBe('metaobject');
  });

  it('neverSynced=true, solange kein Sync vollständig durchgelaufen ist', async () => {
    const { db, findUnique } = makeDb({ syncState: null });

    const { neverSynced } = await loadMediaLibraryImages(db, shop, BASE);

    expect(neverSynced).toBe(true);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { shop } }));
  });
});
