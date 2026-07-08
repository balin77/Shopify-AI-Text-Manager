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
    } else if (result.output.includes('P3008') || result.output.includes('already recorded as applied')) {
      // P3008 = already in migration history. This is the steady state after the
      // one-time baseline; not an error. Stay quiet so genuine failures stand out.
    } else {
      log(`  ↳ Could not resolve ${name}: ${result.output.substring(0, 100)}`, 'yellow');
    }
  }

  // Diagnostic only: report (do NOT mutate) failed/rolled-back migration rows.
  // The previous blanket UPDATE set rolled_back_at=NULL and finished_at=NOW()
  // for every unfinished/rolled-back row — that revives intentionally
  // rolled-back migrations and masks genuine failures, letting a broken deploy
  // proceed silently. Known legacy rows are handled via `migrate resolve` above.
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const stuck = await prisma.$queryRawUnsafe(`
      SELECT "migration_name", "rolled_back_at"
      FROM "_prisma_migrations"
      WHERE "finished_at" IS NULL
        OR "rolled_back_at" IS NOT NULL
    `);
    if (Array.isArray(stuck) && stuck.length > 0) {
      log(`  ↳ ${stuck.length} migration row(s) failed or rolled back — NOT auto-resolving:`, 'yellow');
      for (const row of stuck) log(`     • ${row.migration_name}`, 'yellow');
      log('     Resolve explicitly with `prisma migrate resolve` if these are known-applied.', 'yellow');
    }
    await prisma.$disconnect();
  } catch (e) {
    log(`  ↳ Migration-state check skipped: ${e.message?.substring(0, 80)}`, 'yellow');
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

    // No --accept-data-loss: additive changes still apply, but destructive
    // drift aborts loudly instead of silently dropping production columns/tables.
    const pushSuccess = runCommand(
      'npx prisma db push --skip-generate',
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
