/**
 * One-time Database Cleanup Script
 *
 * Run this ONCE to clean up the database, then switch back to normal start command
 *
 * Usage in Railway:
 * 1. Change start command to: npm run cleanup:once
 * 2. Wait for deployment to finish (cleanup runs)
 * 3. Change start command back to: npm start
 * 4. Redeploy
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const lockFile = join(__dirname, '.cleanup-done');

console.log('🔍 Checking if cleanup was already run...\n');

if (existsSync(lockFile)) {
  console.log('✅ Cleanup was already performed. Starting server normally...\n');

  // Just start the server
  execSync('node scripts/validate-env.js && node start.js', {
    stdio: 'inherit',
    env: process.env
  });

} else {
  console.log('🧹 First run detected. Running database cleanup...\n');

  try {
    // Run cleanup
    execSync('tsx scripts/cleanup-railway.ts', {
      stdio: 'inherit',
      env: process.env
    });

    console.log('\n✅ Cleanup complete! Creating lock file...\n');

    // Create lock file so we don't run cleanup again
    writeFileSync(lockFile, new Date().toISOString());

    console.log('🚀 Starting server...\n');

    // Start the server
    execSync('node scripts/validate-env.js && node start.js', {
      stdio: 'inherit',
      env: process.env
    });

  } catch (error) {
    console.error('❌ Cleanup failed:', error.message);
    console.log('\n⚠️  Attempting to start server anyway...\n');

    // Try to start server even if cleanup fails
    try {
      execSync('node scripts/validate-env.js && node start.js', {
        stdio: 'inherit',
        env: process.env
      });
    } catch (startError) {
      console.error('❌ Server start failed:', startError.message);
      process.exit(1);
    }
  }
}
