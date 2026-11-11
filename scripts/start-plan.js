/**
 * Marker contract between the production start chain and start.js.
 * `npm run start:production` runs scripts/run-all-migrations.js and then
 * `MIGRATIONS_ALREADY_RUN=1 node start.js` (set in the package.json script itself:
 * `&&`-chained node processes do not share env, so run-all-migrations.js cannot
 * set it). With the marker start.js must not run scripts/run-migration.js a
 * second time, which could otherwise reach `db push` against an older schema.
 */
export const MIGRATIONS_ALREADY_RUN_VAR = 'MIGRATIONS_ALREADY_RUN';

export function migrationsAlreadyRun(env = process.env) {
  return env[MIGRATIONS_ALREADY_RUN_VAR] === '1';
}
