#!/usr/bin/env node

/**
 * Database Cleanup Script
 *
 * This script removes accumulated data that is no longer needed:
 * 1. Old theme content and translations (since theme sync is disabled)
 * 2. Expired tasks (older than 3 days)
 * 3. Old webhook logs (older than 7 days)
 * 4. Orphaned translations (translations without parent resources)
 *
 * Run this manually or schedule it as a cron job on Railway.
 */

import { PrismaClient } from '@prisma/client';

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
          { expiresAt: { lt: new Date() } },
          {
            status: { in: ['completed', 'failed', 'cancelled'] },
            completedAt: { lt: threeDaysAgo }
          }
        ]
      }
    });
    console.log(`   ✓ Deleted ${expiredTasksDeleted.count} expired tasks`);

    // 3. Delete old webhook logs (older than 7 days)
    console.log('\n3️⃣ Cleaning up old webhook logs...');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const webhookLogsDeleted = await db.webhookLog.deleteMany({
      where: {
        createdAt: { lt: sevenDaysAgo },
        processed: true
      }
    });
    console.log(`   ✓ Deleted ${webhookLogsDeleted.count} old webhook logs`);

    // 4. Find and delete orphaned content translations
    console.log('\n4️⃣ Finding orphaned content translations...');

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

    // 5. Run VACUUM to reclaim disk space (PostgreSQL specific)
    console.log('\n5️⃣ Running VACUUM to reclaim disk space...');
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
    console.log(`  • Orphaned translations: ${orphanedCount}`);
    console.log(`  • Total records deleted: ${
      themeTranslationsDeleted.count +
      themeContentDeleted.count +
      expiredTasksDeleted.count +
      webhookLogsDeleted.count +
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
