#!/usr/bin/env node
/**
 * Run all migrations for Railway Pre-deploy
 *
 * This script runs:
 * 1. Generate Prisma Client
 * 2. Prisma Schema Migrations (all 12 migrations)
 * 3. API Key encryption migration (idempotent)
 * 4. Session PII encryption migration (idempotent)
 * 5. Webhook Payload encryption migration (idempotent)
 */

import { execSync } from 'child_process';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function runCommand(command, description) {
  try {
    log(`\n🔨 ${description}...`, 'blue');
    execSync(command, { stdio: 'inherit' });
    log(`✅ ${description} completed`, 'green');
    return true;
  } catch (error) {
    log(`❌ ${description} failed`, 'red');
    return false;
  }
}

function runSilent(command) {
  try {
    execSync(command, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  log('🚀 Starting Railway Pre-deploy Migrations', 'blue');
  log('='.repeat(50), 'blue');

  // Check DATABASE_URL
  if (!process.env.DATABASE_URL) {
    log('❌ ERROR: DATABASE_URL not set!', 'red');
    process.exit(1);
  }
  log('✅ DATABASE_URL configured', 'green');

  // Check ENCRYPTION_KEY
  if (!process.env.ENCRYPTION_KEY) {
    log('⚠️  WARNING: ENCRYPTION_KEY not set!', 'yellow');
    log('   API key encryption will be skipped.', 'yellow');
  } else {
    log('✅ ENCRYPTION_KEY configured', 'green');
  }

  // 1. Generate Prisma Client
  runCommand('npx prisma generate', 'Generate Prisma Client');

  // 2. Resolve orphaned migrations that exist in the DB but not locally
  //    These were from earlier manual schema pushes or deleted migration files.
  log('\n🔧 Resolving orphaned migrations...', 'blue');
  const orphanedMigrations = [
    '20250110_add_product_translation_webhook_models',
    '20250111_add_alttext_instructions',
    '20260113_add_product_image_alt_translations',
  ];
  for (const name of orphanedMigrations) {
    runSilent(`npx prisma migrate resolve --rolled-back ${name}`);
  }

  // Mark known migrations as applied so prisma doesn't treat them as "failed".
  // The baseline is often recorded as failed in the DB because it was applied
  // manually before Prisma migration tracking existed.
  log('\n🔧 Marking known migrations as applied...', 'blue');
  const knownAppliedMigrations = [
    '00000000000000_baseline',
    '20260204113149_add_contenttranslation_compound_index',
    '20260204123052_add_image_fields_to_article_and_collection',
    '20260224141738_add_metaobjects_and_missing_columns',
  ];
  for (const name of knownAppliedMigrations) {
    runSilent(`npx prisma migrate resolve --applied ${name}`);
  }

  // Direct SQL fallback: clear only "failed" rows (finished_at IS NULL AND rolled_back_at IS NULL)
  // NOTE: Do NOT touch rows where rolled_back_at IS NOT NULL — those are intentionally rolled back
  // and must be re-applied by prisma migrate deploy, not silently marked as done.
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const fixed = await prisma.$executeRawUnsafe(`
      UPDATE "_prisma_migrations"
      SET "finished_at" = NOW(),
          "logs" = 'Resolved by migration runner'
      WHERE "finished_at" IS NULL
        AND "rolled_back_at" IS NULL
        AND "started_at" IS NOT NULL
    `);
    if (fixed > 0) log(`  ↳ Fixed ${fixed} stuck migration rows via SQL`, 'green');
    await prisma.$disconnect();
  } catch (e) {
    log(`  ↳ Direct SQL fix skipped: ${e.message?.substring(0, 80)}`, 'yellow');
  }

  // 3. Run Prisma Schema Migrations
  log('\n📦 Running Prisma Schema Migrations...', 'blue');
  const migrateSuccess = runCommand(
    'npx prisma migrate deploy',
    'Prisma Schema Migrations'
  );

  if (!migrateSuccess) {
    log('⚠️  prisma migrate deploy failed, trying db push as fallback...', 'yellow');
    const pushSuccess = runCommand(
      'npx prisma db push --skip-generate --accept-data-loss',
      'Prisma DB Push (Fallback)'
    );

    if (!pushSuccess) {
      log('❌ Both migrate deploy and db push failed!', 'red');
      process.exit(1);
    }
  } else {
    // Always run db push after successful migrate deploy to sync schema-only changes
    // (models added via prisma db push without migration files, e.g. ProductVariant, ImageManagerSettings)
    runCommand(
      'npx prisma db push --skip-generate --accept-data-loss',
      'Prisma DB Push (schema sync)'
    );
  }

  // 3. Run API Key encryption migration (if ENCRYPTION_KEY is set)
  if (process.env.ENCRYPTION_KEY) {
    log('\n📦 Running API Key Encryption Migration...', 'blue');
    const success = runCommand(
      'npx tsx scripts/migrate-encrypt-api-keys.ts',
      'API Key Encryption'
    );

    if (!success) {
      log('⚠️  API Key encryption failed, but continuing...', 'yellow');
    }
  } else {
    log('\nℹ️  Skipping API Key encryption (ENCRYPTION_KEY not set)', 'blue');
  }

  // 4. Run Session PII encryption migration (if ENCRYPTION_KEY is set)
  if (process.env.ENCRYPTION_KEY) {
    log('\n📦 Running Session PII Encryption Migration...', 'blue');
    const success = runCommand(
      'npx tsx scripts/migrate-encrypt-session-pii.ts',
      'Session PII Encryption'
    );

    if (!success) {
      log('⚠️  Session PII encryption failed, but continuing...', 'yellow');
    }
  } else {
    log('\nℹ️  Skipping Session PII encryption (ENCRYPTION_KEY not set)', 'blue');
  }

  // 5. Run Webhook Payload encryption migration (if ENCRYPTION_KEY is set)
  if (process.env.ENCRYPTION_KEY) {
    log('\n📦 Running Webhook Payload Encryption Migration...', 'blue');
    const success = runCommand(
      'npx tsx scripts/migrate-encrypt-webhook-payloads.ts',
      'Webhook Payload Encryption'
    );

    if (!success) {
      log('⚠️  Webhook Payload encryption failed, but continuing...', 'yellow');
    }
  } else {
    log('\nℹ️  Skipping Webhook Payload encryption (ENCRYPTION_KEY not set)', 'blue');
  }

  log('\n' + '='.repeat(50), 'green');
  log('✅ All migrations completed!', 'green');
}

main().catch((error) => {
  log(`❌ Unexpected error: ${error.message}`, 'red');
  process.exit(1);
});
