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

  // 2. Run Prisma Schema Migrations
  log('\n📦 Running Prisma Schema Migrations...', 'blue');
  const migrateSuccess = runCommand(
    'npx prisma migrate deploy',
    'Prisma Schema Migrations'
  );

  if (!migrateSuccess) {
    log('⚠️  Prisma migrate deploy failed, trying db push as fallback...', 'yellow');
    const pushSuccess = runCommand(
      'npx prisma db push --skip-generate',
      'Prisma DB Push (Fallback)'
    );

    if (!pushSuccess) {
      log('❌ Both migrate deploy and db push failed!', 'red');
      process.exit(1);
    }
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
