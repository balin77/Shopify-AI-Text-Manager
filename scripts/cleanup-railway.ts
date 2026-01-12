/**
 * Railway Database Cleanup Script
 *
 * Usage:
 * DATABASE_URL="postgresql://..." npm run db:cleanup:railway
 *
 * Or set DATABASE_URL in .env file
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ Error: DATABASE_URL environment variable not set');
  console.log('\nUsage:');
  console.log('  DATABASE_URL="postgresql://..." npm run db:cleanup:railway');
  console.log('\nOr add DATABASE_URL to your .env file');
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: DATABASE_URL
    }
  }
});

async function cleanupRailwayDatabase() {
  console.log('🧹 Starting Railway database cleanup...\n');
  console.log(`📍 Connected to: ${DATABASE_URL.split('@')[1]?.split('/')[0] || 'Railway DB'}\n`);

  try {
    // 1. Delete Theme Translations
    console.log('🗑️  Deleting ThemeTranslation records...');
    const themeTranslationsDeleted = await prisma.themeTranslation.deleteMany({});
    console.log(`   ✓ Deleted ${themeTranslationsDeleted.count} theme translations\n`);

    // 2. Delete Theme Content
    console.log('🗑️  Deleting ThemeContent records...');
    const themeContentDeleted = await prisma.themeContent.deleteMany({});
    console.log(`   ✓ Deleted ${themeContentDeleted.count} theme content records\n`);

    // 3. Delete Content Translations
    console.log('🗑️  Deleting ContentTranslation records...');
    const contentTranslationsDeleted = await prisma.contentTranslation.deleteMany({});
    console.log(`   ✓ Deleted ${contentTranslationsDeleted.count} content translations\n`);

    // 4. Delete Pages
    console.log('🗑️  Deleting Page records...');
    const pagesDeleted = await prisma.page.deleteMany({});
    console.log(`   ✓ Deleted ${pagesDeleted.count} pages\n`);

    // 5. Delete Shop Policies
    console.log('🗑️  Deleting ShopPolicy records...');
    const policiesDeleted = await prisma.shopPolicy.deleteMany({});
    console.log(`   ✓ Deleted ${policiesDeleted.count} shop policies\n`);

    // 6. Delete Collections
    console.log('🗑️  Deleting Collection records...');
    const collectionsDeleted = await prisma.collection.deleteMany({});
    console.log(`   ✓ Deleted ${collectionsDeleted.count} collections\n`);

    // 7. Delete Articles
    console.log('🗑️  Deleting Article records...');
    const articlesDeleted = await prisma.article.deleteMany({});
    console.log(`   ✓ Deleted ${articlesDeleted.count} articles\n`);

    const total =
      themeTranslationsDeleted.count +
      themeContentDeleted.count +
      contentTranslationsDeleted.count +
      pagesDeleted.count +
      policiesDeleted.count +
      collectionsDeleted.count +
      articlesDeleted.count;

    console.log('✅ Railway database cleanup complete!\n');
    console.log('📊 Summary:');
    console.log(`   Total records deleted: ${total.toLocaleString()}\n`);
    console.log('   Breakdown:');
    console.log(`   - Theme Translations: ${themeTranslationsDeleted.count.toLocaleString()}`);
    console.log(`   - Theme Content: ${themeContentDeleted.count.toLocaleString()}`);
    console.log(`   - Content Translations: ${contentTranslationsDeleted.count.toLocaleString()}`);
    console.log(`   - Pages: ${pagesDeleted.count.toLocaleString()}`);
    console.log(`   - Policies: ${policiesDeleted.count.toLocaleString()}`);
    console.log(`   - Collections: ${collectionsDeleted.count.toLocaleString()}`);
    console.log(`   - Articles: ${articlesDeleted.count.toLocaleString()}\n`);

    console.log('ℹ️  Preserved data:');
    console.log('   - Sessions');
    console.log('   - Products');
    console.log('   - AI Settings');
    console.log('   - Webhook Logs');
    console.log('   - Tasks\n');

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run cleanup
cleanupRailwayDatabase()
  .then(() => {
    console.log('🎉 Done! Your Railway database has been cleaned up.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Cleanup failed:', error);
    process.exit(1);
  });
