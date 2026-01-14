/**
 * Migration Script: Encrypt Webhook Payloads
 *
 * Encrypts all unencrypted webhook payloads in the WebhookLog table.
 *
 * This script is IDEMPOTENT - it can be run multiple times safely.
 * Already encrypted payloads will be skipped.
 *
 * Usage:
 *   npx tsx scripts/migrate-encrypt-webhook-payloads.ts
 *
 * Environment Variables Required:
 *   - DATABASE_URL: PostgreSQL connection string
 *   - ENCRYPTION_KEY: 32-byte hex key for AES-256-GCM encryption
 *
 * Safety Features:
 *   - Dry-run mode by default
 *   - Batch processing (100 webhooks at a time)
 *   - Progress reporting
 *   - Error handling per webhook (continues on errors)
 */

import { PrismaClient } from '@prisma/client';
import { encryptPayload, isEncrypted } from '../app/utils/encryption.server';

const db = new PrismaClient();

interface MigrationStats {
  totalWebhooks: number;
  webhooksProcessed: number;
  webhooksEncrypted: number;
  webhooksSkipped: number;
  errors: number;
}

/**
 * Check if environment is properly configured
 */
function validateEnvironment(): void {
  console.log('🔍 Validating environment...\n');

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  if (!process.env.ENCRYPTION_KEY) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is not set. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  console.log('✅ Environment validated');
  console.log(`📊 Database: ${process.env.DATABASE_URL.split('@')[1] || 'configured'}\n`);
}

/**
 * Encrypt a single webhook's payload
 */
async function encryptWebhook(webhook: any, dryRun: boolean, stats: MigrationStats): Promise<void> {
  try {
    // Check if webhook payload needs encryption
    if (!webhook.payload || isEncrypted(webhook.payload)) {
      stats.webhooksSkipped++;
      return;
    }

    console.log(`  Processing webhook: ${webhook.id} (topic: ${webhook.topic}, shop: ${webhook.shop})`);

    // Encrypt payload
    const encryptedPayload = encryptPayload(webhook.payload);

    if (!encryptedPayload) {
      console.warn(`    ⚠️  Failed to encrypt payload for webhook ${webhook.id}`);
      stats.errors++;
      return;
    }

    // Update webhook in database
    if (!dryRun) {
      await db.webhookLog.update({
        where: { id: webhook.id },
        data: { payload: encryptedPayload },
      });
    }

    console.log(`    ✅ Payload encrypted${dryRun ? ' (DRY RUN)' : ''}`);
    stats.webhooksEncrypted++;
    stats.webhooksProcessed++;
  } catch (error) {
    stats.errors++;
    console.error(`    ❌ Error encrypting webhook ${webhook.id}:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Run the migration
 */
async function migrate(dryRun: boolean = true): Promise<MigrationStats> {
  const stats: MigrationStats = {
    totalWebhooks: 0,
    webhooksProcessed: 0,
    webhooksEncrypted: 0,
    webhooksSkipped: 0,
    errors: 0,
  };

  try {
    // Count total webhooks
    stats.totalWebhooks = await db.webhookLog.count();
    console.log(`📊 Found ${stats.totalWebhooks} webhook logs in database\n`);

    if (stats.totalWebhooks === 0) {
      console.log('✅ No webhook logs to migrate\n');
      return stats;
    }

    // Process webhooks in batches
    const BATCH_SIZE = 100;
    let skip = 0;

    console.log(`🔄 Processing webhooks in batches of ${BATCH_SIZE}...\n`);

    while (skip < stats.totalWebhooks) {
      const webhooks = await db.webhookLog.findMany({
        take: BATCH_SIZE,
        skip,
        select: {
          id: true,
          shop: true,
          topic: true,
          payload: true,
        },
      });

      if (webhooks.length === 0) break;

      console.log(`📦 Batch ${Math.floor(skip / BATCH_SIZE) + 1}: Processing ${webhooks.length} webhooks...`);

      // Process each webhook in the batch
      for (const webhook of webhooks) {
        await encryptWebhook(webhook, dryRun, stats);
      }

      skip += BATCH_SIZE;

      // Progress update
      const progress = Math.min(100, Math.round((skip / stats.totalWebhooks) * 100));
      console.log(`  Progress: ${progress}% (${skip}/${stats.totalWebhooks})\n`);
    }

    return stats;
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

/**
 * Print migration summary
 */
function printSummary(stats: MigrationStats, dryRun: boolean): void {
  console.log('\n' + '='.repeat(80));
  console.log('📊 Migration Summary');
  console.log('='.repeat(80));
  console.log(`Mode: ${dryRun ? '🔍 DRY RUN (no changes made)' : '✅ LIVE RUN (changes applied)'}`);
  console.log(`\nWebhook Logs:`);
  console.log(`  Total:     ${stats.totalWebhooks}`);
  console.log(`  Processed: ${stats.webhooksProcessed}`);
  console.log(`  Encrypted: ${stats.webhooksEncrypted}`);
  console.log(`  Skipped:   ${stats.webhooksSkipped} (already encrypted or empty)`);
  console.log(`  Errors:    ${stats.errors}`);
  console.log('='.repeat(80) + '\n');

  if (dryRun && stats.webhooksEncrypted > 0) {
    console.log('💡 This was a dry run. To apply changes, run with --live flag:\n');
    console.log('   npx tsx scripts/migrate-encrypt-webhook-payloads.ts --live\n');
  } else if (!dryRun && stats.webhooksEncrypted > 0) {
    console.log('✅ Migration completed successfully!\n');
    console.log('⚠️  IMPORTANT: All webhook payloads are now encrypted.');
    console.log('   Use decryptPayload() when reading WebhookLog data.\n');
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('\n🔐 Webhook Payload Encryption Migration\n');
  console.log('='.repeat(80) + '\n');

  // Check if --live flag is provided
  const isLive = process.argv.includes('--live');
  const dryRun = !isLive;

  if (dryRun) {
    console.log('🔍 Running in DRY RUN mode (no changes will be made)');
    console.log('   To apply changes, run with --live flag\n');
  } else {
    console.log('⚠️  Running in LIVE mode - changes will be applied!');
    console.log('   Press Ctrl+C within 5 seconds to cancel...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  try {
    // Validate environment
    validateEnvironment();

    // Run migration
    const stats = await migrate(dryRun);

    // Print summary
    printSummary(stats, dryRun);

    // Exit
    process.exit(stats.errors > 0 ? 1 : 0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { migrate, MigrationStats };
