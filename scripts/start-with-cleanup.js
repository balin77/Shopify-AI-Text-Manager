/**
 * Start script with automatic database cleanup
 *
 * This runs the cleanup before starting the server
 * Use in Railway: npm run start:cleanup
 */

import { execSync } from 'child_process';

console.log('🧹 Running database cleanup before starting server...\n');

try {
  // Run cleanup script
  execSync('tsx scripts/cleanup-railway.ts', {
    stdio: 'inherit',
    env: process.env
  });

  console.log('\n✅ Cleanup complete! Starting server...\n');

  // Start the server
  execSync('node scripts/validate-env.js && node start.js', {
    stdio: 'inherit',
    env: process.env
  });

} catch (error) {
  console.error('❌ Error during startup:', error.message);

  // If cleanup fails, try to start server anyway
  console.log('\n⚠️  Cleanup failed, but attempting to start server anyway...\n');

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
