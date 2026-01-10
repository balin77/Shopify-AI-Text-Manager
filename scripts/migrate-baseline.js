#!/usr/bin/env node

/**
 * Baseline Migration Script for Railway
 *
 * This script handles migrations for an existing production database
 * by using prisma migrate resolve to mark existing migrations as applied.
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

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
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
    console.log('✅ Migrations applied successfully!');
    process.exit(0);
  } catch (migrateError) {
    console.log('⚠️ Normal migration failed. Attempting baseline...');

    // Mark all migrations as applied (baseline)
    for (const migration of migrations) {
      console.log(`📌 Marking migration as applied: ${migration}`);
      try {
        execSync(`npx prisma migrate resolve --applied ${migration}`, {
          stdio: 'inherit'
        });
      } catch (resolveError) {
        console.log(`⚠️ Could not resolve ${migration}, it may already be applied`);
      }
    }

    // Try to apply any new migrations
    console.log('🔄 Applying any new migrations...');
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });

    console.log('✅ Migration baseline complete!');
  }

} catch (error) {
  console.error('❌ Migration failed:', error.message);

  // Fallback to db push
  console.log('🔄 Falling back to db push...');
  try {
    execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' });
    console.log('✅ Database schema updated via db push!');
  } catch (pushError) {
    console.error('❌ DB push also failed:', pushError.message);
    process.exit(1);
  }
}
