/**
 * Migration Script: Encrypt existing API Keys in database
 *
 * This script encrypts all existing API keys in the AISettings table.
 * Run this ONCE after deploying the encryption feature.
 *
 * Usage:
 *   node --require dotenv/config --loader tsx scripts/migrate-encrypt-api-keys.ts
 *
 * Prerequisites:
 *   1. Set ENCRYPTION_KEY in your .env file
 *   2. Backup your database before running
 *   3. Test on staging environment first
 *
 * What it does:
 *   - Reads all AISettings records
 *   - Checks if API keys are already encrypted
 *   - Encrypts unencrypted API keys
 *   - Updates the database
 *   - Logs all changes
 */

import { PrismaClient } from '@prisma/client';
import { encryptApiKey, isEncrypted } from '../app/utils/encryption';

const prisma = new PrismaClient();

interface MigrationStats {
  totalShops: number;
  totalKeysProcessed: number;
  keysAlreadyEncrypted: number;
  keysNewlyEncrypted: number;
  keysEmpty: number;
  errors: string[];
}

async function migrateEncryptApiKeys() {
  console.log('🔐 Starting API Key Encryption Migration');
  console.log('========================================\n');

  // Check if ENCRYPTION_KEY is set
  if (!process.env.ENCRYPTION_KEY) {
    console.error('❌ ERROR: ENCRYPTION_KEY environment variable is not set!');
    console.error('Generate one with:');
    console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.error('\nThen add to .env file:');
    console.error('  ENCRYPTION_KEY=your_generated_key');
    process.exit(1);
  }

  const stats: MigrationStats = {
    totalShops: 0,
    totalKeysProcessed: 0,
    keysAlreadyEncrypted: 0,
    keysNewlyEncrypted: 0,
    keysEmpty: 0,
    errors: [],
  };

  try {
    // Fetch all AISettings
    const allSettings = await prisma.aISettings.findMany();
    stats.totalShops = allSettings.length;

    console.log(`📊 Found ${allSettings.length} shop(s) with AI settings\n`);

    if (allSettings.length === 0) {
      console.log('✅ No shops to migrate. Exiting.');
      return stats;
    }

    // Process each shop
    for (const setting of allSettings) {
      console.log(`\n🏪 Processing shop: ${setting.shop}`);
      console.log('─'.repeat(50));

      const updates: any = {};
      const apiKeys = [
        { name: 'huggingfaceApiKey', value: setting.huggingfaceApiKey },
        { name: 'geminiApiKey', value: setting.geminiApiKey },
        { name: 'claudeApiKey', value: setting.claudeApiKey },
        { name: 'openaiApiKey', value: setting.openaiApiKey },
        { name: 'grokApiKey', value: setting.grokApiKey },
        { name: 'deepseekApiKey', value: setting.deepseekApiKey },
      ];

      for (const key of apiKeys) {
        stats.totalKeysProcessed++;

        if (!key.value) {
          console.log(`  ${key.name}: Empty (skipped)`);
          stats.keysEmpty++;
          continue;
        }

        // Check if already encrypted
        if (isEncrypted(key.value)) {
          console.log(`  ${key.name}: Already encrypted ✓`);
          stats.keysAlreadyEncrypted++;
          continue;
        }

        // Encrypt the key
        try {
          const encrypted = encryptApiKey(key.value);
          updates[key.name] = encrypted;
          console.log(`  ${key.name}: Newly encrypted ✓`);
          stats.keysNewlyEncrypted++;
        } catch (error) {
          const errorMsg = `Failed to encrypt ${key.name} for shop ${setting.shop}: ${error instanceof Error ? error.message : String(error)}`;
          console.error(`  ${key.name}: ERROR - ${errorMsg}`);
          stats.errors.push(errorMsg);
        }
      }

      // Update database if there are any changes
      if (Object.keys(updates).length > 0) {
        try {
          await prisma.aISettings.update({
            where: { id: setting.id },
            data: updates,
          });
          console.log(`\n  ✅ Updated ${Object.keys(updates).length} key(s) in database`);
        } catch (error) {
          const errorMsg = `Failed to update database for shop ${setting.shop}: ${error instanceof Error ? error.message : String(error)}`;
          console.error(`\n  ❌ ${errorMsg}`);
          stats.errors.push(errorMsg);
        }
      } else {
        console.log(`\n  ℹ️  No changes needed for this shop`);
      }
    }

    // Print summary
    console.log('\n\n' + '='.repeat(50));
    console.log('📋 MIGRATION SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total shops processed:      ${stats.totalShops}`);
    console.log(`Total API keys checked:     ${stats.totalKeysProcessed}`);
    console.log(`  - Already encrypted:      ${stats.keysAlreadyEncrypted}`);
    console.log(`  - Newly encrypted:        ${stats.keysNewlyEncrypted}`);
    console.log(`  - Empty (skipped):        ${stats.keysEmpty}`);
    console.log(`  - Errors:                 ${stats.errors.length}`);

    if (stats.errors.length > 0) {
      console.log('\n❌ ERRORS:');
      stats.errors.forEach((error, index) => {
        console.log(`  ${index + 1}. ${error}`);
      });
    }

    if (stats.keysNewlyEncrypted > 0) {
      console.log('\n✅ Migration completed successfully!');
      console.log(`${stats.keysNewlyEncrypted} API key(s) have been encrypted.`);
    } else {
      console.log('\n✅ No migration needed. All API keys are already encrypted or empty.');
    }

    return stats;
  } catch (error) {
    console.error('\n❌ FATAL ERROR during migration:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  migrateEncryptApiKeys()
    .then((stats) => {
      if (stats.errors.length > 0) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}

export { migrateEncryptApiKeys };
