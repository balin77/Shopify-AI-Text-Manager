import { spawn as nodeSpawn } from 'child_process';
import { pathToFileURL } from 'url';
import { migrationsAlreadyRun } from './scripts/start-plan.js';

function startServer({ spawn, proc }) {
  console.log('🚀 Starting Express server...');
  const server = spawn('node', ['server.js'], { stdio: 'inherit', shell: true });

  // Forward signals to the server process
  proc.on('SIGTERM', () => {
    console.log('SIGTERM received in start.js, forwarding to server...');
    server.kill('SIGTERM');
  });
  proc.on('SIGINT', () => {
    console.log('SIGINT received in start.js, forwarding to server...');
    server.kill('SIGINT');
  });

  // Exit when server exits
  server.on('exit', (code) => {
    proc.exit(code);
  });
  return server;
}

/**
 * Runs scripts/run-migration.js BEFORE the server, unless the production chain
 * already ran the migrations (MIGRATIONS_ALREADY_RUN=1, see scripts/start-plan.js).
 * Dependencies are injectable for tests.
 */
export function main({ spawn = nodeSpawn, env = process.env, proc = process } = {}) {
  if (migrationsAlreadyRun(env)) {
    console.log('ℹ️  Migrations already ran in this start chain, skipping run-migration.js');
    return startServer({ spawn, proc });
  }

  console.log('🚀 Running migrations...');
  const migration = spawn('node', ['scripts/run-migration.js'], { stdio: 'inherit', shell: true });

  migration.on('exit', (code) => {
    if (code !== 0) {
      console.error('❌ Migration failed with code:', code);
      proc.exit(1);
      return;
    }
    console.log('✅ Migrations complete!');
    startServer({ spawn, proc });
  });
  return migration;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
