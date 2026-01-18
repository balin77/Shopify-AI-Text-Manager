#!/usr/bin/env node
/**
 * Fix Failed Migrations Script
 *
 * This script resolves failed migrations in the production database
 * by marking them as rolled back and then applying the schema changes manually.
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

function runCommand(command, description, options = {}) {
  try {
    log(`\n🔨 ${description}...`, 'blue');
    const result = execSync(command, {
      stdio: options.silent ? 'pipe' : 'inherit',
      encoding: 'utf8'
    });
    log(`✅ ${description} completed`, 'green');
    return { success: true, output: result };
  } catch (error) {
    log(`❌ ${description} failed`, 'red');
    return { success: false, error, output: error.stdout || error.stderr };
  }
}

async function main() {
  log('🔧 Fixing Failed Migrations', 'blue');
  log('='.repeat(50), 'blue');

  // Check DATABASE_URL
  if (!process.env.DATABASE_URL) {
    log('❌ ERROR: DATABASE_URL not set!', 'red');
    process.exit(1);
  }

  // Step 1: Check for failed migrations
  log('\n📋 Checking for failed migrations...', 'blue');
  const statusResult = runCommand(
    'npx prisma migrate status',
    'Check migration status',
    { silent: true }
  );

  if (statusResult.output && statusResult.output.includes('20260113_add_product_image_alt_translations')) {
    log('⚠️  Found failed migration: 20260113_add_product_image_alt_translations', 'yellow');

    // Step 2: Mark failed migration as rolled back
    log('\n🔄 Marking failed migration as rolled back...', 'yellow');
    const resolveResult = runCommand(
      'npx prisma migrate resolve --rolled-back 20260113_add_product_image_alt_translations',
      'Mark migration as rolled back'
    );

    if (!resolveResult.success) {
      log('⚠️  Could not mark migration as rolled back, continuing anyway...', 'yellow');
    }
  }

  // Step 3: Try to deploy migrations again
  log('\n📦 Attempting to deploy all migrations...', 'blue');
  const deployResult = runCommand(
    'npx prisma migrate deploy',
    'Deploy migrations'
  );

  if (deployResult.success) {
    log('\n✅ All migrations deployed successfully!', 'green');
    process.exit(0);
  }

  // Step 4: If deploy still fails, use db push to sync schema
  log('\n⚠️  Migration deploy still failing, using db push to sync schema...', 'yellow');
  log('ℹ️  This will apply all schema changes without migration history', 'blue');

  const pushResult = runCommand(
    'npx prisma db push --skip-generate --accept-data-loss',
    'Push schema to database'
  );

  if (pushResult.success) {
    log('\n✅ Schema synced successfully using db push!', 'green');
    log('ℹ️  Migration history was not preserved, but schema is now up-to-date', 'blue');
    process.exit(0);
  }

  // If everything fails
  log('\n❌ Could not fix migrations automatically', 'red');
  log('Please check the database manually or contact support', 'yellow');
  process.exit(1);
}

main().catch((error) => {
  log(`❌ Unexpected error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});
