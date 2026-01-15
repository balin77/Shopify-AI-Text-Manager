/**
 * Migration Script: Move Product Translations to ContentTranslation Table
 *
 * This script migrates all product translation data from the Translation table
 * to the ContentTranslation table, making Products consistent with Collections,
 * Articles, Pages, and Policies.
 *
 * Run with: npm run migrate:product-translations
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function migrateProductTranslations() {
  console.log("🚀 Starting Product Translation Migration...\n");

  try {
    // 1. Check if Translation table exists and has data
    const translationCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM "Translation"
    `;
    const count = Number(translationCount[0].count);

    console.log(`📊 Found ${count} product translations to migrate`);

    if (count === 0) {
      console.log("✅ No translations to migrate. Migration complete!");
      return;
    }

    // 2. Copy all Translation records to ContentTranslation
    console.log("\n📝 Step 1: Copying translations to ContentTranslation table...");

    const migrated = await prisma.$executeRaw`
      INSERT INTO "ContentTranslation" (
        "id",
        "resourceId",
        "resourceType",
        "key",
        "value",
        "locale",
        "digest",
        "createdAt",
        "updatedAt"
      )
      SELECT
        gen_random_uuid(),
        "productId",
        'Product',
        "key",
        "value",
        "locale",
        "digest",
        "createdAt",
        "updatedAt"
      FROM "Translation"
      ON CONFLICT ("resourceId", "key", "locale") DO NOTHING
    `;

    console.log(`✅ Migrated ${migrated} translation records`);

    // 3. Verify migration
    console.log("\n🔍 Step 2: Verifying migration...");

    const contentTranslationCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count
      FROM "ContentTranslation"
      WHERE "resourceType" = 'Product'
    `;
    const newCount = Number(contentTranslationCount[0].count);

    console.log(`📊 ContentTranslation table now has ${newCount} Product translations`);

    if (newCount !== count) {
      console.warn(`⚠️  Warning: Count mismatch! Original: ${count}, Migrated: ${newCount}`);
      console.warn("   Some records may have been skipped due to conflicts.");
    }

    // 4. Drop the old Translation table
    console.log("\n🗑️  Step 3: Dropping old Translation table...");

    await prisma.$executeRaw`DROP TABLE IF EXISTS "Translation" CASCADE`;

    console.log("✅ Old Translation table dropped");

    // 5. Final summary
    console.log("\n" + "=".repeat(60));
    console.log("✨ Migration Complete!");
    console.log("=".repeat(60));
    console.log(`✅ ${newCount} product translations migrated successfully`);
    console.log(`✅ Translation table removed`);
    console.log(`✅ Products now use ContentTranslation table`);
    console.log("\n📝 Next steps:");
    console.log("   1. Update Products loader to use ContentTranslation");
    console.log("   2. Update Products route to use UnifiedContentEditor");
    console.log("   3. Test Products page functionality");
    console.log("=".repeat(60) + "\n");

  } catch (error) {
    console.error("\n❌ Migration failed:", error);
    console.error("\n⚠️  Database may be in an inconsistent state!");
    console.error("   Please restore from backup if necessary.");
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run migration
migrateProductTranslations()
  .then(() => {
    console.log("✅ Migration script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Migration script failed:", error);
    process.exit(1);
  });
