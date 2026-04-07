#!/usr/bin/env node
/**
 * Railway Migration Runner
 *
 * This script runs database migrations before starting the app.
 *
 * Flow:
 * 1. Generate Prisma Client
 * 2. Fix failed/orphaned migrations in _prisma_migrations table
 * 3. Run `prisma migrate deploy` (applies all formal migrations)
 * 4. If migrate deploy fails, fall back to `prisma db push`
 */

import { execSync } from 'child_process';

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function runCommand(command, description) {
  try {
    log(`🔨 ${description}...`, 'blue');
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
    const output = execSync(command, { stdio: 'pipe', encoding: 'utf-8' });
    return { success: true, output };
  } catch (e) {
    return { success: false, output: e.stderr || e.message };
  }
}

async function fixFailedMigrations() {
  log('🔧 Fixing failed/orphaned migrations...', 'blue');

  // Resolve orphaned migrations (exist in DB but not in local files)
  const orphanedMigrations = [
    '20250110_add_product_translation_webhook_models',
    '20250111_add_alttext_instructions',
    '20260113_add_product_image_alt_translations',
  ];
  for (const name of orphanedMigrations) {
    const result = runSilent(`npx prisma migrate resolve --rolled-back ${name}`);
    if (result.success) log(`  ↳ Rolled back orphan: ${name}`, 'green');
  }

  // Mark previously-applied migrations as applied (fixes "failed" status)
  const failedMigrations = [
    '00000000000000_baseline',
    '20260204113149_add_contenttranslation_compound_index',
    '20260204123052_add_image_fields_to_article_and_collection',
    '20260224141738_add_metaobjects_and_missing_columns',
  ];
  for (const name of failedMigrations) {
    const result = runSilent(`npx prisma migrate resolve --applied ${name}`);
    if (result.success) {
      log(`  ↳ Marked as applied: ${name}`, 'green');
    } else {
      log(`  ↳ Could not resolve ${name}: ${result.output.substring(0, 100)}`, 'yellow');
    }
  }

  // Direct SQL fallback: fix any remaining "failed" rows in _prisma_migrations
  // This handles edge cases where prisma migrate resolve doesn't work
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const fixed = await prisma.$executeRawUnsafe(`
      UPDATE "_prisma_migrations"
      SET "finished_at" = NOW(),
          "rolled_back_at" = NULL,
          "logs" = 'Resolved by migration runner'
      WHERE "finished_at" IS NULL
        OR "rolled_back_at" IS NOT NULL
    `);
    if (fixed > 0) {
      log(`  ↳ Fixed ${fixed} migration rows via direct SQL`, 'green');
    }
    await prisma.$disconnect();
  } catch (e) {
    log(`  ↳ Direct SQL fix skipped: ${e.message?.substring(0, 80)}`, 'yellow');
  }

  log('✅ Migration status resolved', 'green');
}

async function main() {
  log('🚀 Starting database migration...', 'blue');

  if (!process.env.DATABASE_URL) {
    log('❌ ERROR: DATABASE_URL is not set!', 'red');
    process.exit(1);
  }
  log('✅ DATABASE_URL is configured', 'green');

  // 1. Generate Prisma Client
  if (!runCommand('npx prisma generate', 'Generate Prisma Client')) {
    log('❌ Failed to generate Prisma Client — cannot continue', 'red');
    process.exit(1);
  }

  // 2. Fix any failed/orphaned migrations
  await fixFailedMigrations();

  // 3. Run formal migrations
  const migrateSuccess = runCommand(
    'npx prisma migrate deploy',
    'Prisma migrate deploy'
  );

  if (!migrateSuccess) {
    log('⚠️  migrate deploy failed, trying db push as fallback...', 'yellow');

    const pushSuccess = runCommand(
      'npx prisma db push --skip-generate --accept-data-loss',
      'Prisma db push (fallback)'
    );

    if (!pushSuccess) {
      log('❌ Both migrate deploy and db push failed!', 'red');
      process.exit(1);
    }
  }

  log('✅ Database setup complete!', 'green');
}

main().catch((error) => {
  log(`❌ Unexpected error: ${error.message}`, 'red');
  process.exit(1);
});
