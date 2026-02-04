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
    findUnique: vi.fn().mockResolvedValue(null),
  },
  contentTranslation: {
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
  },
  productOption: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  productMetafield: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  $transaction: vi.fn((callback) => {
    // Simuliere Transaction
    return callback(mockDb);
  }),
};

// Mock db.server import
vi.mock('~/db.server', () => ({
  db: mockDb,
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
          variables: { id: productId },
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
            id: expect.stringContaining('gid://shopify/ProductOption/'),
            name: 'Color',
            values: JSON.stringify(['Brown', 'Black', 'Navy']),
          }),
        ]),
      });
    });

    it('sollte Metafields speichern', async () => {
      const productId = 'gid://shopify/Product/123456789';

      await service.syncProduct(productId);

      expect(mockDb.productMetafield.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            namespace: 'custom',
            key: 'material',
            value: 'Genuine Italian Leather',
          }),
        ]),
      });
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
        `[ProductSync] Product not found: ${productId}`
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

      expect(mockDb.product.delete).toHaveBeenCalledWith({
        where: {
          shop_id: {
            shop: testShop,
            id: productId,
          },
        },
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
          variables: { id: 'gid://shopify/Product/123456789' },
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
});
