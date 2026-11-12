#!/usr/bin/env node

/**
 * Database Cleanup Script
 *
 * This script removes accumulated data that is no longer needed:
 * 1. Old theme content and translations (since theme sync is disabled)
 * 2. Expired tasks (older than 3 days)
 * 3. Old webhook logs (older than 24 hours)
 * 4. Excess product images (only first image is kept, others loaded on-demand)
 * 5. Orphaned translations (translations without parent resources)
 *
 * Run this manually or schedule it as a cron job on Railway.
 */

import { PrismaClient } from '@prisma/client';
import { NOT_OPEN_BATCH_TASK, SETTLED_TASK_STATUSES } from '../app/config/task-statuses.js';

const db = new PrismaClient();

async function cleanupDatabase() {
  console.log('🧹 Starting database cleanup...\n');

  try {
    // 1. Delete ALL theme-related data (theme sync is disabled)
    console.log('1️⃣ Cleaning up theme data...');
    const themeTranslationsDeleted = await db.themeTranslation.deleteMany({});
    console.log(`   ✓ Deleted ${themeTranslationsDeleted.count} theme translations`);

    const themeContentDeleted = await db.themeContent.deleteMany({});
    console.log(`   ✓ Deleted ${themeContentDeleted.count} theme content entries`);

    // 2. Delete expired tasks (older than 3 days)
    console.log('\n2️⃣ Cleaning up expired tasks...');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const expiredTasksDeleted = await db.task.deleteMany({
      where: {
        OR: [
          // Never an open batch task (submitting / waiting_batch / cancel_requested):
          // its row is the only handle on a paid provider batch.
          { expiresAt: { lt: new Date() }, ...NOT_OPEN_BATCH_TASK },
          {
            status: { in: SETTLED_TASK_STATUSES },
            completedAt: { lt: threeDaysAgo }
          }
        ]
      }
    });
    console.log(`   ✓ Deleted ${expiredTasksDeleted.count} expired tasks`);

    // 3. Delete old webhook logs (older than 24 hours)
    console.log('\n3️⃣ Cleaning up old webhook logs...');
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const webhookLogsDeleted = await db.webhookLog.deleteMany({
      where: {
        createdAt: { lt: oneDayAgo },
        processed: true
      }
    });
    console.log(`   ✓ Deleted ${webhookLogsDeleted.count} old webhook logs`);

    // 4. Delete excess product images (keep only first image per product)
    console.log('\n4️⃣ Cleaning up excess product images...');
    const excessImagesDeleted = await db.productImage.deleteMany({
      where: {
        position: { gt: 0 } // Delete all images except the first one (position 0)
      }
    });
    console.log(`   ✓ Deleted ${excessImagesDeleted.count} excess product images (keeping only first image)`);

    // 5. Find and delete orphaned content translations
    console.log('\n5️⃣ Finding orphaned content translations...');

    // Get all unique resourceIds from ContentTranslation
    const translations = await db.contentTranslation.findMany({
      select: {
        resourceId: true,
        resourceType: true
      },
      distinct: ['resourceId', 'resourceType']
    });

    let orphanedCount = 0;

    for (const translation of translations) {
      let parentExists = false;

      // Check if parent resource exists based on resourceType
      switch (translation.resourceType) {
        case 'Page':
          parentExists = await db.page.findUnique({
            where: { id: translation.resourceId }
          }) !== null;
          break;
        case 'ShopPolicy':
          parentExists = await db.shopPolicy.findUnique({
            where: { id: translation.resourceId }
          }) !== null;
          break;
        case 'Collection':
          parentExists = await db.collection.findUnique({
            where: { id: translation.resourceId }
          }) !== null;
          break;
        case 'Article':
          parentExists = await db.article.findUnique({
            where: { id: translation.resourceId }
          }) !== null;
          break;
      }

      // Delete orphaned translations
      if (!parentExists) {
        const deleted = await db.contentTranslation.deleteMany({
          where: {
            resourceId: translation.resourceId,
            resourceType: translation.resourceType
          }
        });
        orphanedCount += deleted.count;
      }
    }

    console.log(`   ✓ Deleted ${orphanedCount} orphaned content translations`);

    // 6. Run VACUUM to reclaim disk space (PostgreSQL specific)
    console.log('\n6️⃣ Running VACUUM to reclaim disk space...');
    try {
      await db.$executeRawUnsafe('VACUUM FULL;');
      console.log('   ✓ VACUUM completed successfully');
    } catch (error) {
      console.log('   ⚠️ VACUUM failed (may need superuser privileges):', error.message);
      console.log('   ℹ️ This is optional - cleanup was still successful');
    }

    // Print summary
    console.log('\n' + '='.repeat(50));
    console.log('✅ Database cleanup complete!\n');
    console.log('Summary:');
    console.log(`  • Theme translations: ${themeTranslationsDeleted.count}`);
    console.log(`  • Theme content: ${themeContentDeleted.count}`);
    console.log(`  • Expired tasks: ${expiredTasksDeleted.count}`);
    console.log(`  • Webhook logs: ${webhookLogsDeleted.count}`);
    console.log(`  • Excess product images: ${excessImagesDeleted.count}`);
    console.log(`  • Orphaned translations: ${orphanedCount}`);
    console.log(`  • Total records deleted: ${
      themeTranslationsDeleted.count +
      themeContentDeleted.count +
      expiredTasksDeleted.count +
      webhookLogsDeleted.count +
      excessImagesDeleted.count +
      orphanedCount
    }`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('\n❌ Cleanup failed:', error);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

// Run cleanup
cleanupDatabase();
