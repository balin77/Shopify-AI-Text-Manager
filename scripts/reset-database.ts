/**
 * Database Reset Script - Complete Database Wipe
 *
 * WARNING: This will delete ALL data from the database!
 * Use only for development/testing purposes.
 *
 * This removes:
 * - All sessions
 * - All products and translations
 * - All content (pages, policies, themes)
 * - All AI settings
 * - All webhook logs
 * - All tasks
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function resetDatabase() {
  console.log('⚠️  WARNING: This will delete ALL data from the database!\n');
  console.log('🔄 Starting complete database reset...\n');

  try {
    // Delete in correct order (respecting foreign keys)

    console.log('🗑️  Deleting Theme data...');
    await prisma.themeTranslation.deleteMany({});
    await prisma.themeContent.deleteMany({});
    console.log('   ✓ Theme data deleted\n');

    console.log('🗑️  Deleting Content translations...');
    await prisma.contentTranslation.deleteMany({});
    console.log('   ✓ Content translations deleted\n');

    console.log('🗑️  Deleting Content...');
    await prisma.page.deleteMany({});
    await prisma.shopPolicy.deleteMany({});
    await prisma.collection.deleteMany({});
    await prisma.article.deleteMany({});
    console.log('   ✓ Content deleted\n');

    console.log('🗑️  Deleting Products...');
    await prisma.productMetafield.deleteMany({});
    await prisma.productOption.deleteMany({});
    await prisma.productImage.deleteMany({});
    await prisma.translation.deleteMany({});
    await prisma.product.deleteMany({});
    console.log('   ✓ Products deleted\n');

    console.log('🗑️  Deleting Webhooks...');
    await prisma.webhookLog.deleteMany({});
    console.log('   ✓ Webhook logs deleted\n');

    console.log('🗑️  Deleting Tasks...');
    await prisma.task.deleteMany({});
    console.log('   ✓ Tasks deleted\n');

    console.log('🗑️  Deleting AI Settings...');
    await prisma.aIInstructions.deleteMany({});
    await prisma.aISettings.deleteMany({});
    console.log('   ✓ AI settings deleted\n');

    console.log('🗑️  Deleting Sessions...');
    await prisma.session.deleteMany({});
    console.log('   ✓ Sessions deleted\n');

    console.log('✅ Complete database reset finished!\n');
    console.log('ℹ️  You will need to:');
    console.log('   1. Re-authenticate with Shopify');
    console.log('   2. Re-configure AI settings');
    console.log('   3. Re-sync all data\n');

  } catch (error) {
    console.error('❌ Error during reset:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run reset
resetDatabase()
  .then(() => {
    console.log('🎉 Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Reset failed:', error);
    process.exit(1);
  });
