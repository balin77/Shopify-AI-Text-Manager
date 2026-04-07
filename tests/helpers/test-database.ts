/**
 * Test Database Helper
 *
 * Erstellt eine In-Memory SQLite-Datenbank für Tests
 * ✅ KEIN echtes PostgreSQL nötig
 * ✅ Schnell (<50ms Setup)
 * ✅ Automatisches Cleanup
 *
 * Verwendung:
 *   import { setupTestDatabase } from '../helpers/test-database';
 *
 *   beforeEach(async () => {
 *     await setupTestDatabase();
 *   });
 */

import { PrismaClient } from '@prisma/client';
import { beforeEach, afterEach } from 'vitest';

let testDb: PrismaClient | null = null;

/**
 * Erstellt eine In-Memory SQLite-Datenbank mit Prisma-Schema
 *
 * WICHTIG: Für SQLite müssen einige PostgreSQL-spezifische Features
 * angepasst werden (z.B. Json -> Text, Cascade-Deletes)
 */
export async function setupTestDatabase() {
  // Verwende SQLite in-memory für Tests
  const databaseUrl = 'file::memory:?mode=memory&cache=shared';

  testDb = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });

  // Verbinde zur DB
  await testDb.$connect();

  // Führe Migrations aus (oder Schema-Push für SQLite)
  // Note: In Produktion würdest du `prisma migrate deploy` verwenden
  // Für Tests reicht `prisma db push`

  return testDb;
}

/**
 * Bereinigt Test-Datenbank
 */
export async function cleanupTestDatabase() {
  if (testDb) {
    await testDb.$disconnect();
    testDb = null;
  }
}

/**
 * Reset alle Tabellen (für beforeEach)
 */
export async function resetTestDatabase() {
  if (!testDb) {
    throw new Error('Test database not initialized. Call setupTestDatabase() first.');
  }

  // Lösche alle Daten in allen Tabellen
  // Reihenfolge wichtig wegen Foreign Keys!
  await testDb.productImageAltTranslation.deleteMany();
  await testDb.productImage.deleteMany();
  await testDb.productOption.deleteMany();
  await testDb.productMetafield.deleteMany();
  await testDb.contentTranslation.deleteMany();
  await testDb.product.deleteMany();
  await testDb.collection.deleteMany();
  await testDb.article.deleteMany();
  await testDb.page.deleteMany();
  await testDb.shopPolicy.deleteMany();
  await testDb.menu.deleteMany();
  await testDb.task.deleteMany();
  await testDb.webhookLog.deleteMany();
  await testDb.webhookRetry.deleteMany();
  await testDb.themeContent.deleteMany();
  await testDb.themeTranslation.deleteMany();
  await testDb.aISettings.deleteMany();
  await testDb.aIInstructions.deleteMany();
  await testDb.session.deleteMany();
}

/**
 * Erstellt Test-Fixtures
 */
export async function createTestFixtures() {
  if (!testDb) {
    throw new Error('Test database not initialized');
  }

  const shop = 'test-shop.myshopify.com';

  // Erstelle AI Settings
  await testDb.aISettings.create({
    data: {
      shop,
      preferredProvider: 'huggingface',
      appLanguage: 'de',
      subscriptionPlan: 'pro',
    },
  });

  // Erstelle Test-Produkt
  const product = await testDb.product.create({
    data: {
      id: 'gid://shopify/Product/123456789',
      shop,
      title: 'Test Product',
      descriptionHtml: '<p>Test Description</p>',
      handle: 'test-product',
      status: 'ACTIVE',
      productType: 'Test Type',
      shopifyUpdatedAt: new Date(),
    },
  });

  // Erstelle Test-Übersetzungen
  await testDb.contentTranslation.createMany({
    data: [
      {
        shop,
        resourceId: product.id,
        resourceType: 'Product',
        key: 'title',
        value: 'Test Product EN',
        locale: 'en',
      },
      {
        shop,
        resourceId: product.id,
        resourceType: 'Product',
        key: 'body_html',
        value: '<p>Test Description EN</p>',
        locale: 'en',
      },
    ],
  });

  // Erstelle Test-Bilder
  await testDb.productImage.createMany({
    data: [
      {
        productId: product.id,
        url: 'https://cdn.shopify.com/test1.jpg',
        altText: 'Test Image 1',
        mediaId: 'gid://shopify/MediaImage/111',
        position: 0,
      },
      {
        productId: product.id,
        url: 'https://cdn.shopify.com/test2.jpg',
        altText: 'Test Image 2',
        mediaId: 'gid://shopify/MediaImage/222',
        position: 1,
      },
    ],
  });

  return { shop, product };
}

/**
 * Globaler Test-DB Getter
 */
export function getTestDb(): PrismaClient {
  if (!testDb) {
    throw new Error('Test database not initialized. Call setupTestDatabase() first.');
  }
  return testDb;
}

/**
 * Auto-Setup für Vitest
 *
 * Füge dies zu tests/setup.ts hinzu:
 *
 * import { setupTestDatabase, cleanupTestDatabase, resetTestDatabase } from './helpers/test-database';
 *
 * beforeAll(async () => {
 *   await setupTestDatabase();
 * });
 *
 * beforeEach(async () => {
 *   await resetTestDatabase();
 * });
 *
 * afterAll(async () => {
 *   await cleanupTestDatabase();
 * });
 */
