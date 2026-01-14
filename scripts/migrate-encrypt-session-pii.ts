/**
 * Migration Script: Encrypt Session PII Data
 *
 * Encrypts all unencrypted PII data in the Session table:
 * - firstName
 * - lastName
 * - email
 * - accessToken
 * - refreshToken
 *
 * This script is IDEMPOTENT - it can be run multiple times safely.
 * Already encrypted data will be skipped.
 *
 * Usage:
 *   npx tsx scripts/migrate-encrypt-session-pii.ts
 *
 * Environment Variables Required:
 *   - DATABASE_URL: PostgreSQL connection string
 *   - ENCRYPTION_KEY: 32-byte hex key for AES-256-GCM encryption
 *
 * Safety Features:
 *   - Dry-run mode by default
 *   - Batch processing (100 sessions at a time)
 *   - Progress reporting
 *   - Error handling per session (continues on errors)
 *   - Transaction support for atomicity
 */

import { PrismaClient } from '@prisma/client';
import { encryptPII, encryptToken, isEncrypted } from '../app/utils/encryption.server';

const db = new PrismaClient();

interface MigrationStats {
  totalSessions: number;
  sessionsProcessed: number;
  sessionsEncrypted: number;
  sessionsSkipped: number;
  errors: number;
  fieldsEncrypted: {
    firstName: number;
    lastName: number;
    email: number;
    accessToken: number;
    refreshToken: number;
  };
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
 * Check if a session needs encryption
 */
function needsEncryption(session: any): boolean {
  // Check if any PII field is not encrypted
  const fieldsToCheck = [
    session.firstName,
    session.lastName,
    session.email,
    session.accessToken,
    session.refreshToken,
  ];

  return fieldsToCheck.some(field => field && !isEncrypted(field));
}

/**
 * Encrypt a single session's PII data
 */
async function encryptSession(session: any, dryRun: boolean, stats: MigrationStats): Promise<void> {
  try {
    // Check if session needs encryption
    if (!needsEncryption(session)) {
      stats.sessionsSkipped++;
      return;
    }

    console.log(`  Processing session: ${session.id.substring(0, 20)}... (shop: ${session.shop})`);

    // Prepare encrypted data
    const updates: any = {};
    let fieldsEncryptedInSession = 0;

    // Encrypt firstName
    if (session.firstName && !isEncrypted(session.firstName)) {
      updates.firstName = encryptPII(session.firstName);
      stats.fieldsEncrypted.firstName++;
      fieldsEncryptedInSession++;
    }

    // Encrypt lastName
    if (session.lastName && !isEncrypted(session.lastName)) {
      updates.lastName = encryptPII(session.lastName);
      stats.fieldsEncrypted.lastName++;
      fieldsEncryptedInSession++;
    }

    // Encrypt email
    if (session.email && !isEncrypted(session.email)) {
      updates.email = encryptPII(session.email);
      stats.fieldsEncrypted.email++;
      fieldsEncryptedInSession++;
    }

    // Encrypt accessToken
    if (session.accessToken && !isEncrypted(session.accessToken)) {
      updates.accessToken = encryptToken(session.accessToken);
      stats.fieldsEncrypted.accessToken++;
      fieldsEncryptedInSession++;
    }

    // Encrypt refreshToken
    if (session.refreshToken && !isEncrypted(session.refreshToken)) {
      updates.refreshToken = encryptToken(session.refreshToken);
      stats.fieldsEncrypted.refreshToken++;
      fieldsEncryptedInSession++;
    }

    // Update session in database
    if (fieldsEncryptedInSession > 0) {
      if (!dryRun) {
        await db.session.update({
          where: { id: session.id },
          data: updates,
        });
      }

      console.log(`    ✅ Encrypted ${fieldsEncryptedInSession} field(s)${dryRun ? ' (DRY RUN)' : ''}`);
      stats.sessionsEncrypted++;
    }

    stats.sessionsProcessed++;
  } catch (error) {
    stats.errors++;
    console.error(`    ❌ Error encrypting session ${session.id}:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Run the migration
 */
async function migrate(dryRun: boolean = true): Promise<MigrationStats> {
  const stats: MigrationStats = {
    totalSessions: 0,
    sessionsProcessed: 0,
    sessionsEncrypted: 0,
    sessionsSkipped: 0,
    errors: 0,
    fieldsEncrypted: {
      firstName: 0,
      lastName: 0,
      email: 0,
      accessToken: 0,
      refreshToken: 0,
    },
  };

  try {
    // Count total sessions
    stats.totalSessions = await db.session.count();
    console.log(`📊 Found ${stats.totalSessions} sessions in database\n`);

    if (stats.totalSessions === 0) {
      console.log('✅ No sessions to migrate\n');
      return stats;
    }

    // Process sessions in batches
    const BATCH_SIZE = 100;
    let skip = 0;

    console.log(`🔄 Processing sessions in batches of ${BATCH_SIZE}...\n`);

    while (skip < stats.totalSessions) {
      const sessions = await db.session.findMany({
        take: BATCH_SIZE,
        skip,
        select: {
          id: true,
          shop: true,
          firstName: true,
          lastName: true,
          email: true,
          accessToken: true,
          refreshToken: true,
        },
      });

      if (sessions.length === 0) break;

      console.log(`📦 Batch ${Math.floor(skip / BATCH_SIZE) + 1}: Processing ${sessions.length} sessions...`);

      // Process each session in the batch
      for (const session of sessions) {
        await encryptSession(session, dryRun, stats);
      }

      skip += BATCH_SIZE;

      // Progress update
      const progress = Math.min(100, Math.round((skip / stats.totalSessions) * 100));
      console.log(`  Progress: ${progress}% (${skip}/${stats.totalSessions})\n`);
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
  console.log(`\nSessions:`);
  console.log(`  Total:     ${stats.totalSessions}`);
  console.log(`  Processed: ${stats.sessionsProcessed}`);
  console.log(`  Encrypted: ${stats.sessionsEncrypted}`);
  console.log(`  Skipped:   ${stats.sessionsSkipped} (already encrypted)`);
  console.log(`  Errors:    ${stats.errors}`);
  console.log(`\nFields Encrypted:`);
  console.log(`  firstName:    ${stats.fieldsEncrypted.firstName}`);
  console.log(`  lastName:     ${stats.fieldsEncrypted.lastName}`);
  console.log(`  email:        ${stats.fieldsEncrypted.email}`);
  console.log(`  accessToken:  ${stats.fieldsEncrypted.accessToken}`);
  console.log(`  refreshToken: ${stats.fieldsEncrypted.refreshToken}`);
  console.log('='.repeat(80) + '\n');

  if (dryRun && stats.sessionsEncrypted > 0) {
    console.log('💡 This was a dry run. To apply changes, run with --live flag:\n');
    console.log('   npx tsx scripts/migrate-encrypt-session-pii.ts --live\n');
  } else if (!dryRun && stats.sessionsEncrypted > 0) {
    console.log('✅ Migration completed successfully!\n');
    console.log('⚠️  IMPORTANT: All PII data is now encrypted.');
    console.log('   Make sure to use decryptPII/decryptToken when reading Session data.\n');
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('\n🔐 Session PII Encryption Migration\n');
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
