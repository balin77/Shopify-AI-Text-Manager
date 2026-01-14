import { execSync } from 'child_process';

// Run migrations BEFORE starting the server
console.log('🚀 Running migrations...');
try {
  execSync('node scripts/run-migration.js', { stdio: 'inherit' });
  console.log('✅ Migrations complete!');
} catch (error) {
  console.error('❌ Migration failed:', error.message);
  process.exit(1);
}

// Start the Express server
console.log('🚀 Starting Express server...');
execSync('node server.js', { stdio: 'inherit' });
