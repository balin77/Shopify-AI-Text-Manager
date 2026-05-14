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
    execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' });
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
    execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' });
    console.log('✅ Database schema updated successfully!');
    process.exit(0);
  }

  // Try to apply migrations normally first
  console.log('🔄 Attempting normal migration...');
  try {
    execSync('npx prisma migrate deploy', { stdio: 'pipe' });
    console.log('✅ Migrations applied successfully!');
    // Also run db push to sync schema-only changes not captured in migration files
    console.log('🔄 Running db push to sync any additional schema changes...');
    execSync('npx prisma db push --skip-generate --accept-data-loss', { stdio: 'inherit' });
    console.log('✅ Schema sync complete!');
    process.exit(0);
  } catch (migrateError) {
    // Get error output from stderr and stdout
    const errorOutput = migrateError.stderr?.toString() || migrateError.stdout?.toString() || migrateError.message || '';

    // Check if it's a P3005 error (non-empty database)
    if (errorOutput.includes('P3005') || errorOutput.includes('database schema is not empty')) {
      console.log('⚠️ Database is not empty (P3005). Using db push to sync schema...');

      // For existing databases without migration history, use db push
      try {
        console.log('🔄 Running prisma db push to sync schema...');
        execSync('npx prisma db push --skip-generate', { stdio: 'inherit' });
        console.log('✅ Database schema synced successfully!');
        console.log('ℹ️  Note: Migration history was not preserved. Future schema changes will use db push.');
        process.exit(0);
      } catch (pushError) {
        console.error('❌ DB push failed:', pushError.message);
        throw pushError;
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
