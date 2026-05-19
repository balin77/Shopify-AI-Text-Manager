#!/usr/bin/env node

/**
 * Baseline Migration Script for Railway
 *
 * This script handles migrations for an existing production database
 * by using prisma migrate resolve to mark existing migrations as applied.
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';

console.log('🔄 Starting migration baseline process...');

const migrationsDir = './prisma/migrations';

try {
  // Check if migrations directory exists
  if (!existsSync(migrationsDir)) {
    console.log('⚠️ No migrations directory found. Running db push instead...');
    execSync('npx prisma db push', { stdio: 'inherit' });
    console.log('✅ Database schema updated successfully!');
    process.exit(0);
  }

  // Get all migration folders
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)
    .filter(name => name !== 'migration_lock.toml')
    .sort();

  console.log(`📋 Found ${migrations.length} migration(s)`);

  if (migrations.length === 0) {
    console.log('⚠️ No migrations found. Running db push instead...');
    execSync('npx prisma db push', { stdio: 'inherit' });
    console.log('✅ Database schema updated successfully!');
    process.exit(0);
  }

  // Try to apply migrations normally first
  console.log('🔄 Attempting normal migration...');
  try {
    execSync('npx prisma migrate deploy', { stdio: 'pipe' });
    console.log('✅ Migrations applied successfully!');
    // No post-success db push: the migration history is now complete
    // (ImageManagerSettings/ProductVariant/AltTextTemplate have idempotent
    // CREATE TABLE migrations), so migrate deploy alone reproduces the full
    // schema. An unconditional db push here previously masked history gaps.
    process.exit(0);
  } catch (migrateError) {
    // Get error output from stderr and stdout
    const errorOutput = migrateError.stderr?.toString() || migrateError.stdout?.toString() || migrateError.message || '';

    // Check if it's a P3005 error (non-empty database)
    if (errorOutput.includes('P3005') || errorOutput.includes('database schema is not empty')) {
      // P3005 = the DB already has a schema but no _prisma_migrations history.
      // The correct, history-PRESERVING remediation is to baseline: record
      // every existing migration as applied (without re-running its SQL) via
      // `migrate resolve --applied`, then run `migrate deploy` which becomes a
      // clean no-op / only applies genuinely new migrations. The old `db push`
      // fallback discarded migration history entirely and left the project on
      // an ad-hoc push workflow.
      console.log(`⚠️ Database is not empty (P3005). Baselining ${migrations.length} migration(s) into history...`);
      try {
        for (const name of migrations) {
          try {
            execSync(`npx prisma migrate resolve --applied ${name}`, { stdio: 'pipe' });
            console.log(`  ↳ Baselined: ${name}`);
          } catch (resolveErr) {
            // Already-recorded migrations make resolve fail — that's fine,
            // it just means this row already exists in history.
            const out = resolveErr.stderr?.toString() || resolveErr.message || '';
            console.log(`  ↳ Skipped ${name} (already recorded or not applicable)`);
            if (process.env.DEBUG_MIGRATIONS) console.log(`     ${out.substring(0, 200)}`);
          }
        }
        // History now exists — deploy is a no-op or applies only new ones.
        console.log('🔄 Running prisma migrate deploy after baseline...');
        execSync('npx prisma migrate deploy', { stdio: 'inherit' });
        console.log('✅ Database baselined and migrations applied — history preserved!');
        process.exit(0);
      } catch (baselineError) {
        console.error('❌ Baseline failed:', baselineError.message);
        throw baselineError;
      }
    } else {
      // Log the actual error for debugging
      console.error('❌ Unexpected migration error:', errorOutput);
      throw migrateError;
    }
  }

} catch (error) {
  console.error('❌ Migration failed:', error.message);

  // Fallback to db push
  console.log('🔄 Falling back to db push...');
  try {
    execSync('npx prisma db push --skip-generate', { stdio: 'inherit' });
    console.log('✅ Database schema updated via db push!');
  } catch (pushError) {
    console.error('❌ DB push also failed:', pushError.message);
    process.exit(1);
  }
}
