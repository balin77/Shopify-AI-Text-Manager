/**
 * Database Cleanup Script - Remove Background Sync Data
 *
 * This script removes all data created by the background sync system:
 * - ThemeContent
 * - ThemeTranslation
 * - Pages
 * - Policies
 * - ContentTranslation
 *
 * WARNING: This will delete all cached content data.
 * Products, Sessions, and Settings will be preserved.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanupSyncData() {
  console.log('🧹 Starting database cleanup...\n');

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

    // 6. Delete Collections (optional - created by webhooks)
    console.log('🗑️  Deleting Collection records...');
    const collectionsDeleted = await prisma.collection.deleteMany({});
    console.log(`   ✓ Deleted ${collectionsDeleted.count} collections\n`);

    // 7. Delete Articles (optional - created by webhooks)
    console.log('🗑️  Deleting Article records...');
    const articlesDeleted = await prisma.article.deleteMany({});
    console.log(`   ✓ Deleted ${articlesDeleted.count} articles\n`);

    console.log('✅ Database cleanup complete!\n');
    console.log('📊 Summary:');
    console.log(`   - Theme Translations: ${themeTranslationsDeleted.count}`);
    console.log(`   - Theme Content: ${themeContentDeleted.count}`);
    console.log(`   - Content Translations: ${contentTranslationsDeleted.count}`);
    console.log(`   - Pages: ${pagesDeleted.count}`);
    console.log(`   - Policies: ${policiesDeleted.count}`);
    console.log(`   - Collections: ${collectionsDeleted.count}`);
    console.log(`   - Articles: ${articlesDeleted.count}`);
    console.log(`   Total: ${
      themeTranslationsDeleted.count +
      themeContentDeleted.count +
      contentTranslationsDeleted.count +
      pagesDeleted.count +
      policiesDeleted.count +
      collectionsDeleted.count +
      articlesDeleted.count
    } records deleted\n`);

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
cleanupSyncData()
  .then(() => {
    console.log('🎉 Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Cleanup failed:', error);
    process.exit(1);
  });
