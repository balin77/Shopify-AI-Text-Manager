import { spawn } from 'child_process';

// Run migrations BEFORE starting the server
console.log('🚀 Running migrations...');
const migration = spawn('node', ['scripts/run-migration.js'], {
  stdio: 'inherit',
  shell: true
});

migration.on('exit', (code) => {
  if (code !== 0) {
    console.error('❌ Migration failed with code:', code);
    process.exit(1);
  }

  console.log('✅ Migrations complete!');

  // Start the Express server
  console.log('🚀 Starting Express server...');
  const server = spawn('node', ['server.js'], {
    stdio: 'inherit',
    shell: true
  });

  // Forward signals to the server process
  process.on('SIGTERM', () => {
    console.log('SIGTERM received in start.js, forwarding to server...');
    server.kill('SIGTERM');
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received in start.js, forwarding to server...');
    server.kill('SIGINT');
  });

  // Exit when server exits
  server.on('exit', (code) => {
    process.exit(code);
  });
});
