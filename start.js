import { execSync } from 'child_process';

// Only run Prisma migration if DATABASE_URL is set
if (process.env.DATABASE_URL) {
  console.log('DATABASE_URL found, running Prisma migration...');
  try {
    execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' });
    console.log('Prisma migration complete!');
  } catch (error) {
    console.error('Prisma migration failed:', error.message);
    process.exit(1);
  }
} else {
  console.log('DATABASE_URL not found, skipping Prisma migration');
}

// Start the Express server (instead of remix-serve)
console.log('Starting Express server...');
execSync('node server.js', { stdio: 'inherit' });
