/**
 * Unit Tests für app/services/media-library/usage.server.ts
 *
 * Die Verwendungs-Auflösung ist reine Ableitung aus lokalen Caches — Shopifys
 * files() sagt nicht, wo eine Datei benutzt wird. Getestet wird deshalb vor
 * allem, dass sie EHRLICH bleibt:
 *
 *  - auflösbar:  product (ProductImage.mediaId), metaobject (file_reference)
 *  - mehrdeutig: Art bleibt, Besitzer wird geleert statt geraten
 *  - alles andere: kein Eintrag → der Aufrufer setzt "unknown"
 *  - Mandantentrennung: jede Query trägt den shop-Filter
 *
 * DB vollständig gemockt (kein Prisma, kein Netz).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveMediaUsage,
  extractFileReferenceGids,
  isMediaImageGid,
} from '~/services/media-library/usage.server';

const shop = 'test.myshopify.com';
const OTHER_SHOP = 'other.myshopify.com';

const M1 = 'gid://shopify/MediaImage/1';
const M2 = 'gid://shopify/MediaImage/2';
const M3 = 'gid://shopify/MediaImage/3';

function makeDb(opts: {
  productImages?: Array<{ mediaId: string | null; product: { id: string; title: string } | null }>;
  metaobjects?: Array<{ id: string; displayName: string; fields: unknown }>;
}) {
  const productImageFindMany = vi.fn().mockResolvedValue(opts.productImages ?? []);
  const metaobjectFindMany = vi.fn().mockResolvedValue(opts.metaobjects ?? []);
  return {
    db: {
      productImage: { findMany: productImageFindMany },
      metaobject: { findMany: metaobjectFindMany },
    } as never,
    productImageFindMany,
    metaobjectFindMany,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('isMediaImageGid()', () => {
  it('akzeptiert nur MediaImage-GIDs', () => {
    expect(isMediaImageGid(M1)).toBe(true);
    // CollectionImage/ArticleImage haben zwar GIDs, sind aber keine MediaImages
    // (und laut Translation-Probe ohne übersetzbare Keys).
    expect(isMediaImageGid('gid://shopify/CollectionImage/1')).toBe(false);
    expect(isMediaImageGid('gid://shopify/GenericFile/1')).toBe(false);
    expect(isMediaImageGid('gid://shopify/MediaImage/abc')).toBe(false);
    expect(isMediaImageGid(null)).toBe(false);
    expect(isMediaImageGid(42)).toBe(false);
  });
});

describe('extractFileReferenceGids()', () => {
  it('liest Einzel- und Listenreferenzen', () => {
    const gids = extractFileReferenceGids([
      { key: 'image', type: 'file_reference', value: M1 },
      { key: 'gallery', type: 'list.file_reference', value: JSON.stringify([M2, M3]) },
    ]);
    expect(gids).toEqual([M1, M2, M3]);
  });

  it('ignoriert Felder, die keine Dateireferenz sind — auch wenn der Wert wie eine GID aussieht', () => {
    const gids = extractFileReferenceGids([
      { key: 'note', type: 'single_line_text_field', value: M1 },
      { key: 'ref', type: 'metaobject_reference', value: M2 },
    ]);
    expect(gids).toEqual([]);
  });

  it('ignoriert Nicht-MediaImage-Referenzen (z.B. GenericFile/PDF)', () => {
    const gids = extractFileReferenceGids([
      { key: 'datasheet', type: 'file_reference', value: 'gid://shopify/GenericFile/9' },
      { key: 'mixed', type: 'list.file_reference', value: JSON.stringify(['gid://shopify/Video/8', M1]) },
    ]);
    expect(gids).toEqual([M1]);
  });

  it('verkraftet kaputtes JSON, leere Werte und Nicht-Arrays', () => {
    expect(extractFileReferenceGids([{ type: 'list.file_reference', value: '[not json' }])).toEqual([]);
    expect(extractFileReferenceGids([{ type: 'file_reference', value: '' }])).toEqual([]);
    expect(extractFileReferenceGids([{ type: 'file_reference', value: null }])).toEqual([]);
    expect(extractFileReferenceGids(null)).toEqual([]);
    expect(extractFileReferenceGids({ nope: true })).toEqual([]);
  });
});

describe('resolveMediaUsage() — product', () => {
  it('genau ein Produkt → kind=product mit GID und Titel', async () => {
    const { db } = makeDb({
      productImages: [{ mediaId: M1, product: { id: 'gid://shopify/Product/10', title: 'Vase Ascera' } }],
    });

    const usage = await resolveMediaUsage(db, shop, [M1, M2]);

    expect(usage.get(M1)).toEqual({
      kind: 'product',
      ownerId: 'gid://shopify/Product/10',
      label: 'Vase Ascera',
    });
    // Kein Treffer → gar kein Eintrag (der Sync setzt daraus "unknown").
    expect(usage.has(M2)).toBe(false);
  });

  it('mehrere Produkte → kind bleibt product, Besitzer wird NICHT geraten', async () => {
    const { db } = makeDb({
      productImages: [
        { mediaId: M1, product: { id: 'gid://shopify/Product/10', title: 'Vase Ascera' } },
        { mediaId: M1, product: { id: 'gid://shopify/Product/11', title: 'Vase Belona' } },
      ],
    });

    const usage = await resolveMediaUsage(db, shop, [M1]);

    expect(usage.get(M1)).toEqual({ kind: 'product', ownerId: '', label: '' });
  });

  it('filtert die ProductImage-Abfrage über die Produkt-Relation auf den Shop', async () => {
    const { db, productImageFindMany } = makeDb({});

    await resolveMediaUsage(db, shop, [M1]);

    expect(productImageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mediaId: { in: [M1] }, product: { shop } },
      }),
    );
    expect(productImageFindMany.mock.calls[0][0].where.product.shop).not.toBe(OTHER_SHOP);
  });

  it('ignoriert ProductImage-Zeilen ohne mediaId (Legacy-Daten)', async () => {
    const { db } = makeDb({
      productImages: [{ mediaId: null, product: { id: 'gid://shopify/Product/10', title: 'X' } }],
    });

    const usage = await resolveMediaUsage(db, shop, [M1]);

    expect(usage.size).toBe(0);
  });
});

describe('resolveMediaUsage() — metaobject', () => {
  it('löst Dateireferenzen aus dem Metaobjekt-Cache auf', async () => {
    const { db, metaobjectFindMany } = makeDb({
      metaobjects: [
        {
          id: 'gid://shopify/Metaobject/77',
          displayName: 'Lookbook Frühling',
          fields: [{ key: 'hero', type: 'file_reference', value: M2 }],
        },
      ],
    });

    const usage = await resolveMediaUsage(db, shop, [M1, M2]);

    expect(usage.get(M2)).toEqual({
      kind: 'metaobject',
      ownerId: 'gid://shopify/Metaobject/77',
      label: 'Lookbook Frühling',
    });
    expect(metaobjectFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { shop } }));
  });

  it('mehrere Metaobjekte → Besitzer leer, Art bleibt', async () => {
    const { db } = makeDb({
      metaobjects: [
        { id: 'gid://shopify/Metaobject/1', displayName: 'A', fields: [{ type: 'file_reference', value: M1 }] },
        { id: 'gid://shopify/Metaobject/2', displayName: 'B', fields: [{ type: 'file_reference', value: M1 }] },
      ],
    });

    const usage = await resolveMediaUsage(db, shop, [M1]);

    expect(usage.get(M1)).toEqual({ kind: 'metaobject', ownerId: '', label: '' });
  });

  it('product schlägt metaobject bei Doppelverwendung', async () => {
    const { db } = makeDb({
      productImages: [{ mediaId: M1, product: { id: 'gid://shopify/Product/10', title: 'Vase Ascera' } }],
      metaobjects: [
        { id: 'gid://shopify/Metaobject/77', displayName: 'Lookbook', fields: [{ type: 'file_reference', value: M1 }] },
      ],
    });

    const usage = await resolveMediaUsage(db, shop, [M1]);

    expect(usage.get(M1)?.kind).toBe('product');
    expect(usage.get(M1)?.label).toBe('Vase Ascera');
  });

  it('Metaobjekt-Referenzen auf nicht abgefragte Bilder werden ignoriert', async () => {
    const { db } = makeDb({
      metaobjects: [
        { id: 'gid://shopify/Metaobject/77', displayName: 'Lookbook', fields: [{ type: 'file_reference', value: M3 }] },
      ],
    });

    const usage = await resolveMediaUsage(db, shop, [M1]);

    expect(usage.size).toBe(0);
  });

  it('leere Eingabe fragt die Datenbank gar nicht erst', async () => {
    const { db, productImageFindMany, metaobjectFindMany } = makeDb({});

    const usage = await resolveMediaUsage(db, shop, []);

    expect(usage.size).toBe(0);
    expect(productImageFindMany).not.toHaveBeenCalled();
    expect(metaobjectFindMany).not.toHaveBeenCalled();
  });
});
