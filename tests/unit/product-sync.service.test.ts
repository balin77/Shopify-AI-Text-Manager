/**
 * Unit Tests für ProductSyncService
 *
 * ✅ KEIN echtes Shopify nötig
 * ✅ KEIN echtes PostgreSQL nötig (SQLite in-memory)
 * ✅ Schnell (<100ms pro Test)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProductSyncService } from '~/services/product-sync.service';
import { createMockShopifyAdmin, mockShopifyProduct, mockShopLocales, mockTranslatableContent } from '../mocks/shopify-graphql.mock';

// Mock der Datenbank
const mockDb = {
  product: {
    upsert: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUnique: vi.fn().mockResolvedValue(null),
  },
  contentTranslation: {
    // No pre-existing rows → digest-skip (R3-H4) can't prove "unchanged",
    // so syncProduct falls through to the delete+recreate path the
    // assertions below expect.
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  productImage: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockImplementation(({ data }) => Promise.resolve({
      id: `db-image-${Math.random()}`,
      ...data,
    })),
    findMany: vi.fn().mockResolvedValue([]), // Keine existierenden Images
  },
  productImageAltTranslation: {
    create: vi.fn().mockResolvedValue({}),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    // No pre-existing market alt rows → nothing to preserve across the
    // ProductImage delete-then-recreate.
    findMany: vi.fn().mockResolvedValue([]),
  },
  productOption: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  productMetafield: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  $transaction: vi.fn((arg) => {
    // Supports both forms: the interactive callback form
    // $transaction(tx => ...) and the array form $transaction([p1, p2]).
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg(mockDb);
  }),
};

// Mock db.server import
vi.mock('~/db.server', () => ({
  db: mockDb,
  upsertProductMetafields: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock('~/utils/logger.server', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ProductSyncService', () => {
  let service: ProductSyncService;
  let mockAdmin: ReturnType<typeof createMockShopifyAdmin>;
  const testShop = 'test-shop.myshopify.com';

  beforeEach(() => {
    // Reset alle Mocks
    vi.clearAllMocks();

    // Erstelle Mock Admin Client
    mockAdmin = createMockShopifyAdmin();

    // Erstelle Service-Instanz
    service = new ProductSyncService(mockAdmin as any, testShop);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('syncProduct', () => {
    it('sollte ein Produkt mit allen Daten synchronisieren', async () => {
      const productId = 'gid://shopify/Product/123456789';

      await service.syncProduct(productId);

      // Verifiziere: Product Query wurde aufgerufen
      expect(mockAdmin.graphql).toHaveBeenCalledWith(
        expect.stringContaining('query getProduct'),
        expect.objectContaining({
          variables: expect.objectContaining({
            id: productId,
            metafieldsFirst: 250,
          }),
        })
      );

      // Verifiziere: Shop Locales wurden abgerufen
      expect(mockAdmin.graphql).toHaveBeenCalledWith(
        expect.stringContaining('query getShopLocales')
      );

      // Verifiziere: Translations wurden abgerufen
      expect(mockAdmin.graphql).toHaveBeenCalledWith(
        expect.stringContaining('query getTranslations'),
        expect.any(Object)
      );

      // Verifiziere: Product wurde in DB gespeichert
      expect(mockDb.product.upsert).toHaveBeenCalledWith({
        where: {
          shop_id: {
            shop: testShop,
            id: productId,
          },
        },
        create: expect.objectContaining({
          id: productId,
          shop: testShop,
          title: mockShopifyProduct.title,
          handle: mockShopifyProduct.handle,
        }),
        update: expect.objectContaining({
          title: mockShopifyProduct.title,
          handle: mockShopifyProduct.handle,
        }),
      });
    });

    it('sollte Bilder mit MediaIds speichern', async () => {
      const productId = 'gid://shopify/Product/123456789';

      await service.syncProduct(productId);

      // Verifiziere: Images wurden gelöscht und neu erstellt
      expect(mockDb.productImage.deleteMany).toHaveBeenCalledWith({
        where: { productId },
      });

      // Verifiziere: Neue Images wurden erstellt
      expect(mockDb.productImage.create).toHaveBeenCalledTimes(2); // 2 Images in mockShopifyProduct

      // Verifiziere: Images haben MediaIds
      expect(mockDb.productImage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaId: expect.stringContaining('gid://shopify/MediaImage/'),
          url: expect.any(String),
          altText: expect.any(String),
        }),
      });
    });

    it('sollte Image Alt-Text Übersetzungen speichern', async () => {
      const productId = 'gid://shopify/Product/123456789';

      await service.syncProduct(productId);

      // Verifiziere: Bulk Alt-Text Query wurde für nicht-primäre Locales aufgerufen
      expect(mockAdmin.graphql).toHaveBeenCalledWith(
        expect.stringContaining('query getMediaImageTranslationsBulk'),
        expect.objectContaining({
          variables: expect.objectContaining({
            locale: expect.stringMatching(/^(en|fr)$/), // Nicht-primäre Locales
          }),
        })
      );
    });

    it('sollte Translations korrekt filtern (nur echte Übersetzungen)', async () => {
      const productId = 'gid://shopify/Product/123456789';

      await service.syncProduct(productId);

      // Verifiziere: Nur translations wurden gespeichert, nicht translatableContent
      expect(mockDb.contentTranslation.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            key: 'title',
            value: 'Premium Leather Wallet', // Aus translations, nicht translatableContent
            locale: 'en',
          }),
        ]),
      });
    });

    it('sollte Optionen speichern', async () => {
      const productId = 'gid://shopify/Product/123456789';

      await service.syncProduct(productId);

      expect(mockDb.productOption.deleteMany).toHaveBeenCalledWith({
        where: { productId },
      });

      expect(mockDb.productOption.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            id: 'gid://shopify/ProductOption/1',
            productId: productId,
            name: 'Color',
            position: 1,
            linkedMetafieldKey: null,
          }),
        ]),
      });
    });

    it('sollte Metafields speichern', async () => {
      const productId = 'gid://shopify/Product/123456789';

      await service.syncProduct(productId);

      // Metafields werden jetzt über upsertProductMetafields gespeichert
      const { upsertProductMetafields } = await import('~/db.server');
      expect(upsertProductMetafields).toHaveBeenCalledWith(
        expect.any(Object), // tx (transaction)
        productId,
        expect.arrayContaining([
          expect.objectContaining({
            namespace: 'custom',
            key: 'material',
            value: 'Genuine Italian Leather',
          }),
        ])
      );
    });

    it('sollte Fehler loggen wenn Produkt nicht gefunden wird', async () => {
      // Mock: Produkt existiert nicht
      mockAdmin.graphql = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ data: { product: null } }),
      });

      const productId = 'gid://shopify/Product/999';

      await service.syncProduct(productId);

      // Import logger dynamisch, da es gemockt ist
      const { logger } = await import('~/utils/logger.server');

      // Logger verwendet Template-String, also prüfen wir auf den vollen String
      expect(logger.warn).toHaveBeenCalledWith(
        `[ProductSync] Product not found in Shopify: ${productId} - attempting to delete from local database`
      );
    });

    it('sollte User-Modifications von Alt-Texten bewahren', async () => {
      const productId = 'gid://shopify/Product/123456789';
      const now = new Date();
      const recentlyModifiedTime = new Date(now.getTime() - 2 * 60 * 1000); // 2 Minuten alt

      // Mock: Existierendes Bild mit kürzlich geändertem Alt-Text
      mockDb.productImage.findMany = vi.fn().mockResolvedValue([
        {
          mediaId: 'gid://shopify/MediaImage/111',
          altText: 'Custom user alt-text that should be preserved',
          altTextModifiedAt: recentlyModifiedTime,
        },
      ]);

      await service.syncProduct(productId);

      // Verifiziere: User Alt-Text wurde NICHT überschrieben
      expect(mockDb.productImage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaId: 'gid://shopify/MediaImage/111',
          altText: 'Custom user alt-text that should be preserved', // Preserved!
        }),
      });
    });
  });

  describe('deleteProduct', () => {
    it('sollte ein Produkt aus der DB löschen', async () => {
      const productId = 'gid://shopify/Product/123456789';

      await service.deleteProduct(productId);

      // deleteProduct atomically clears the product AND its polymorphic
      // ContentTranslation rows (no FK cascade), using deleteMany for
      // idempotency — scoped by { shop, id } / { shop, resourceId }.
      expect(mockDb.contentTranslation.deleteMany).toHaveBeenCalledWith({
        where: { shop: testShop, resourceId: productId },
      });
      expect(mockDb.product.deleteMany).toHaveBeenCalledWith({
        where: { shop: testShop, id: productId },
      });
    });
  });

  describe('syncSingleProduct', () => {
    it('sollte numerische IDs zu GID konvertieren', async () => {
      mockDb.product.findUnique = vi.fn().mockResolvedValue({
        id: 'gid://shopify/Product/123456789',
        title: 'Test Product',
      });

      await service.syncSingleProduct('123456789', false);

      // Verifiziere: GID wurde korrekt konstruiert
      expect(mockAdmin.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          variables: expect.objectContaining({
            id: 'gid://shopify/Product/123456789',
            metafieldsFirst: 250,
          }),
        })
      );
    });

    it('sollte plan-aware image loading unterstützen', async () => {
      const productId = 'gid://shopify/Product/123456789';
      mockDb.product.findUnique = vi.fn().mockResolvedValue({
        id: productId,
        title: 'Test Product',
        images: [],
      });

      // Test mit includeAllImages = false
      await service.syncSingleProduct(productId, false);

      expect(mockDb.product.findUnique).toHaveBeenCalledWith({
        where: {
          shop_id: {
            shop: testShop,
            id: productId,
          },
        },
        include: {
          images: false, // Nur Featured Image
          options: true,
          metafields: true,
        },
      });
    });
  });

  // ── syncAllProducts ───────────────────────────────────────────────────────

  describe('syncAllProducts()', () => {
    /** Helper: make an admin whose graphql returns multiple product pages */
    function makeAdminWithPages(pages: Array<{ edges: unknown[]; hasNextPage: boolean; endCursor?: string | null }>) {
      let call = 0;
      return {
        graphql: vi.fn().mockImplementation(async () => {
          const page = pages[Math.min(call++, pages.length - 1)];
          return {
            json: async () => ({
              data: {
                products: {
                  pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor ?? null },
                  edges: page.edges,
                },
              },
            }),
          };
        }),
      };
    }

    const defaultOptions = { maxProducts: 50, cacheProductImages: false };

    it('returns 0 when Shopify returns no products (single page)', async () => {
      const admin = makeAdminWithPages([{ edges: [], hasNextPage: false }]);
      const svc = new ProductSyncService(admin as never, testShop);

      const count = await svc.syncAllProducts(defaultOptions);

      expect(count).toBe(0);
      expect(admin.graphql).toHaveBeenCalledTimes(1);
    });

    it('throws DOMException("AbortError") when signal is already aborted', async () => {
      const admin = makeAdminWithPages([{ edges: [], hasNextPage: false }]);
      const svc = new ProductSyncService(admin as never, testShop);

      const controller = new AbortController();
      controller.abort();

      await expect(
        svc.syncAllProducts({ ...defaultOptions, signal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError' });

      // graphql must NOT have been called — abort fires before the network request
      expect(admin.graphql).toHaveBeenCalledTimes(0);
    });

    it('makes a second graphql call when hasNextPage=true on first page', async () => {
      const admin = makeAdminWithPages([
        { edges: [], hasNextPage: true, endCursor: 'cursor-abc' },
        { edges: [], hasNextPage: false },
      ]);
      const svc = new ProductSyncService(admin as never, testShop);

      const count = await svc.syncAllProducts(defaultOptions);

      // Both pages returned empty edges → still 0 products
      expect(count).toBe(0);
      // Two graphql calls: page 1 (hasNextPage=true) + page 2 (hasNextPage=false)
      expect(admin.graphql).toHaveBeenCalledTimes(2);
      // Second call must forward the cursor from page 1
      expect(admin.graphql).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        { variables: { first: expect.any(Number), after: 'cursor-abc' } }
      );
    });
  });
});
