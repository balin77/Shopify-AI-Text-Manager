/**
 * One-time cleanup script to remove duplicate translations
 * Run this after fixing the sync logic to clean up accumulated data
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanupDuplicateTranslations() {
  console.log('Starting cleanup of duplicate translations...\n');

  try {
    // 1. Clean up ThemeTranslation duplicates
    console.log('1. Cleaning up ThemeTranslation duplicates...');

    const themeTranslations = await prisma.themeTranslation.findMany({
      orderBy: { createdAt: 'asc' }
    });

    const seenKeys = new Set<string>();
    const toDelete: string[] = [];

    for (const trans of themeTranslations) {
      const uniqueKey = `${trans.shop}::${trans.resourceId}::${trans.groupId}::${trans.key}::${trans.locale}`;

      if (seenKeys.has(uniqueKey)) {
        // Duplicate found - mark for deletion
        toDelete.push(trans.id);
      } else {
        seenKeys.add(uniqueKey);
      }
    }

    if (toDelete.length > 0) {
      console.log(`   Found ${toDelete.length} duplicate ThemeTranslations`);

      // Delete in batches of 100
      for (let i = 0; i < toDelete.length; i += 100) {
        const batch = toDelete.slice(i, i + 100);
        await prisma.themeTranslation.deleteMany({
          where: { id: { in: batch } }
        });
        console.log(`   Deleted batch ${Math.floor(i / 100) + 1}/${Math.ceil(toDelete.length / 100)}`);
      }

      console.log(`   ✓ Deleted ${toDelete.length} duplicate ThemeTranslations\n`);
    } else {
      console.log('   ✓ No duplicates found\n');
    }

    // 2. Clean up ContentTranslation duplicates
    console.log('2. Cleaning up ContentTranslation duplicates...');

    const contentTranslations = await prisma.contentTranslation.findMany({
      orderBy: { createdAt: 'asc' }
    });

    const seenContentKeys = new Set<string>();
    const toDeleteContent: string[] = [];

    for (const trans of contentTranslations) {
      const uniqueKey = `${trans.resourceId}::${trans.key}::${trans.locale}`;

      if (seenContentKeys.has(uniqueKey)) {
        toDeleteContent.push(trans.id);
      } else {
        seenContentKeys.add(uniqueKey);
      }
    }

    if (toDeleteContent.length > 0) {
      console.log(`   Found ${toDeleteContent.length} duplicate ContentTranslations`);

      // Delete in batches of 100
      for (let i = 0; i < toDeleteContent.length; i += 100) {
        const batch = toDeleteContent.slice(i, i + 100);
        await prisma.contentTranslation.deleteMany({
          where: { id: { in: batch } }
        });
        console.log(`   Deleted batch ${Math.floor(i / 100) + 1}/${Math.ceil(toDeleteContent.length / 100)}`);
      }

      console.log(`   ✓ Deleted ${toDeleteContent.length} duplicate ContentTranslations\n`);
    } else {
      console.log('   ✓ No duplicates found\n');
    }

    // 3. Get final statistics
    console.log('3. Final database statistics:');

    const stats = {
      themeContent: await prisma.themeContent.count(),
      themeTranslations: await prisma.themeTranslation.count(),
      contentTranslations: await prisma.contentTranslation.count(),
      pages: await prisma.page.count(),
      policies: await prisma.shopPolicy.count(),
    };

    console.log(`   ThemeContent: ${stats.themeContent}`);
    console.log(`   ThemeTranslations: ${stats.themeTranslations}`);
    console.log(`   ContentTranslations: ${stats.contentTranslations}`);
    console.log(`   Pages: ${stats.pages}`);
    console.log(`   Policies: ${stats.policies}`);

    console.log('\n✓ Cleanup completed successfully!');

  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the cleanup
cleanupDuplicateTranslations()
  .catch((error) => {
    console.error('Cleanup failed:', error);
    process.exit(1);
  });
