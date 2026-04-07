#!/usr/bin/env node
/**
 * Railway Migration Runner
 *
 * This script runs database migrations before starting the app.
 * It works on any platform (Windows, Linux, Mac).
 *
 * Flow:
 * 1. Generate Prisma Client
 * 2. Resolve orphaned migrations (if any)
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
    log(`❌ ${description} failed: ${error.message}`, 'red');
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
  log('🚀 Starting Railway deployment with database migration...', 'blue');

  // Check if DATABASE_URL is set
  if (!process.env.DATABASE_URL) {
    log('❌ ERROR: DATABASE_URL environment variable is not set!', 'red');
    process.exit(1);
  }

  log('✅ DATABASE_URL is configured', 'green');

  // 1. Generate Prisma Client
  const genSuccess = runCommand(
    'npx prisma generate',
    'Generate Prisma Client'
  );

  if (!genSuccess) {
    log('❌ Failed to generate Prisma Client — cannot continue', 'red');
    process.exit(1);
  }

  // 2. Resolve orphaned migrations that exist in the DB but not locally
  //    (e.g. from previous manual schema pushes or deleted migration files)
  const orphanedMigrations = [
    '20250110_add_product_translation_webhook_models',
    '20250111_add_alttext_instructions',
    '20260113_add_product_image_alt_translations',
  ];
  for (const name of orphanedMigrations) {
    runSilent(`npx prisma migrate resolve --rolled-back ${name}`);
  }

  // 2b. Resolve failed migrations so new migrations can run
  //     These migrations were already applied to the DB (via db push or manually)
  //     but may be marked as "failed" in _prisma_migrations, blocking migrate deploy.
  const failedMigrations = [
    '00000000000000_baseline',
    '20260204113149_add_contenttranslation_compound_index',
    '20260204123052_add_image_fields_to_article_and_collection',
    '20260224141738_add_metaobjects_and_missing_columns',
  ];
  for (const name of failedMigrations) {
    runSilent(`npx prisma migrate resolve --applied ${name}`);
  }
  log('✅ Resolved migration status for previously applied migrations', 'green');

  // 3. Run Prisma Schema Migrations (applies all migration files)
  const migrateSuccess = runCommand(
    'npx prisma migrate deploy',
    'Prisma Schema Migrations (migrate deploy)'
  );

  if (!migrateSuccess) {
    log('⚠️  prisma migrate deploy failed, trying db push as fallback...', 'yellow');

    const pushSuccess = runCommand(
      'npx prisma db push --skip-generate --accept-data-loss',
      'Prisma DB Push (fallback)'
    );

    if (!pushSuccess) {
      log('❌ Both migrate deploy and db push failed!', 'red');
      process.exit(1);
    }
  }

  log('✅ Database setup complete!', 'green');
  log('🚀 Ready to start application...', 'blue');
}

main().catch((error) => {
  log(`❌ Unexpected error: ${error.message}`, 'red');
  process.exit(1);
});
