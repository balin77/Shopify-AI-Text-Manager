/**
 * Decision logic for a failed `prisma migrate deploy` (pure, no I/O).
 *
 * A failed migrate deploy (e.g. P3009 after a killed CREATE INDEX CONCURRENTLY)
 * must stop the deploy: falling back to `prisma db push` leaves INVALID indexes
 * and failed migration rows behind, skips later SQL backfills and builds later
 * indexes without CONCURRENTLY. The fallback exists only behind the explicit
 * env flag ALLOW_DB_PUSH_FALLBACK=true (exact string "true").
 */

export const DB_PUSH_FALLBACK_FLAG = 'ALLOW_DB_PUSH_FALLBACK';

export function isDbPushFallbackAllowed(env = process.env) {
  return env[DB_PUSH_FALLBACK_FLAG] === 'true';
}

/**
 * @param {boolean} migrateSuccess result of `prisma migrate deploy`
 * @param {Record<string, string | undefined>} env
 * @returns {{ action: 'continue' | 'abort' | 'db-push-fallback', message?: string }}
 */
export function decideAfterMigrateDeploy(migrateSuccess, env = process.env) {
  if (migrateSuccess) return { action: 'continue' };
  if (isDbPushFallbackAllowed(env)) {
    return {
      action: 'db-push-fallback',
      message: `MIGRATE_DEPLOY_FAILED: continuing with prisma db push because ${DB_PUSH_FALLBACK_FLAG}=true`,
    };
  }
  return {
    action: 'abort',
    message:
      'MIGRATE_DEPLOY_FAILED: prisma migrate deploy failed. Aborting deploy (exit 1), the old container keeps serving. ' +
      'See RAILWAY-SETUP.md "Fehlgeschlagene Migration beheben". ' +
      `Emergency only: ${DB_PUSH_FALLBACK_FLAG}=true enables the db push fallback.`,
  };
}
