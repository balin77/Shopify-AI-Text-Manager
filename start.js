import { execSync } from 'child_process';

// Migrations are now handled by Pre-deploy Command (node scripts/run-migration.js)
// This file just starts the server

console.log('Starting Express server...');
execSync('node server.js', { stdio: 'inherit' });
