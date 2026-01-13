#!/usr/bin/env node
/**
 * Railway Migration Runner
 *
 * This script runs database migrations before starting the app.
 * It works on any platform (Windows, Linux, Mac).
 *
 * Usage in Railway Custom Start Command:
 *   node scripts/run-migration.js && npm run start
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function runCommand(command, errorMessage) {
  try {
    execSync(command, { stdio: 'inherit' });
    return true;
  } catch (error) {
    log(`❌ ${errorMessage}`, 'red');
    log(`Error: ${error.message}`, 'red');
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

  // Run all migrations in order
  const migrations = [
    'add_entity_specific_ai_instructions.sql',
    '20250113_add_menu_model.sql'
  ];

  for (const migrationFile of migrations) {
    const migrationPath = path.join(__dirname, '..', 'prisma', 'migrations', migrationFile);

    if (fs.existsSync(migrationPath)) {
      log(`📦 Running migration: ${migrationFile}...`, 'blue');

      // Read the migration SQL file
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

      // Use Prisma's db execute command to run the SQL
      const tempSqlPath = path.join(__dirname, '..', 'temp_migration.sql');
      fs.writeFileSync(tempSqlPath, migrationSQL);

      const success = runCommand(
        `npx prisma db execute --file ${tempSqlPath} --schema prisma/schema.prisma`,
        `Failed to run migration: ${migrationFile}`
      );

      // Clean up temp file
      try {
        fs.unlinkSync(tempSqlPath);
      } catch (e) {
        // Ignore cleanup errors
      }

      if (success) {
        log(`✅ Migration ${migrationFile} completed successfully`, 'green');
      } else {
        log(`⚠️  Migration ${migrationFile} failed, but continuing...`, 'yellow');
      }
    } else {
      log(`ℹ️  Migration file ${migrationFile} not found, skipping...`, 'blue');
    }
  }

  // Generate Prisma Client
  log('🔨 Generating Prisma Client...', 'blue');
  const genSuccess = runCommand(
    'npx prisma generate',
    'Failed to generate Prisma Client'
  );

  if (genSuccess) {
    log('✅ Prisma Client generated successfully', 'green');
  } else {
    log('❌ Failed to generate Prisma Client', 'red');
    process.exit(1);
  }

  log('✅ Database setup complete!', 'green');
  log('🚀 Ready to start application...', 'blue');
}

main().catch((error) => {
  log(`❌ Unexpected error: ${error.message}`, 'red');
  process.exit(1);
});
