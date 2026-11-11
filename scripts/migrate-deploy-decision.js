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

const TRANSIENT_DB_PATTERN = /P1001|P1002|P1017|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Can't reach database server|the database system is (starting up|shutting down)/i;

/** True when the output of a failed migrate deploy looks like "database not reachable yet". */
export function isTransientDbError(output) {
  return TRANSIENT_DB_PATTERN.test(String(output ?? ''));
}

/** Backoff in ms before retry number `attempt` (1-based), capped. */
export function retryDelayMs(attempt) {
  return Math.min(5000 * 2 ** (attempt - 1), 30000);
}

/**
 * Is every migration folder of THIS image applied cleanly?
 * dbRows: [{ migration_name, finished_at, rolled_back_at }]. A failed row of a
 * migration this image does not contain (a newer deploy) does not count.
 * @returns {{ current: boolean, missing: string[], failedForeign: string[] }}
 */
export function assessSchema(localMigrations, dbRows) {
  const ok = new Set();
  const bad = new Set();
  for (const r of dbRows) {
    if (r.finished_at && !r.rolled_back_at) ok.add(r.migration_name);
    else if (!r.rolled_back_at) bad.add(r.migration_name);
  }
  const local = new Set(localMigrations);
  const missing = localMigrations.filter((n) => !ok.has(n));
  const failedForeign = [...bad].filter((n) => !local.has(n));
  return { current: missing.length === 0, missing, failedForeign };
}

/**
 * @param {boolean} migrateSuccess result of `prisma migrate deploy`
 * @param {Record<string, string | undefined>} env
 * @param {{ localMigrations: string[], dbRows: object[], invalidIndexes?: string[] | null } | null} [schemaState]
 *   null/undefined = the state could not be read, which always aborts; so does
 *   a missing/null invalidIndexes (pg_index unreadable) or a non-empty one.
 * @returns {{ action: 'continue' | 'continue-schema-current' | 'abort' | 'db-push-fallback', message?: string }}
 */
export function decideAfterMigrateDeploy(migrateSuccess, env = process.env, schemaState = null) {
  if (migrateSuccess) return { action: 'continue' };
  if (schemaState && Array.isArray(schemaState.localMigrations) && Array.isArray(schemaState.dbRows)) {
    const a = assessSchema(schemaState.localMigrations, schemaState.dbRows);
    if (a.current) {
      // Rows alone prove too little: a row set to --applied by hand can sit on
      // top of an INVALID index. No pg_index answer (null/missing) = cannot tell.
      // Refuse in both cases and regardless of the db push flag (db push does not
      // repair an invalid index). An index another container is building RIGHT NOW
      // also reads as invalid: refusing is the safe direction, the restart retries.
      if (!Array.isArray(schemaState.invalidIndexes)) {
        return {
          action: 'abort',
          message:
            'MIGRATE_DEPLOY_FAILED: every migration of this image is applied, but pg_index could not be read, so INVALID indexes cannot be ruled out. ' +
            'Aborting deploy (exit 1), the old container keeps serving; the restart retries. See RAILWAY-SETUP.md "Fehlgeschlagene Migration beheben".',
        };
      }
      if (schemaState.invalidIndexes.length > 0) {
        return {
          action: 'abort',
          message:
            `MIGRATE_DEPLOY_FAILED_INVALID_INDEX: every migration of this image is applied, but INVALID index(es) exist: ${schemaState.invalidIndexes.join(', ')}. ` +
            'This is either a broken index left by a failed CREATE INDEX CONCURRENTLY, or an index another container is building right now; ' +
            'aborting is the safe direction (exit 1, the old container keeps serving, the restart retries). See RAILWAY-SETUP.md "Fehlgeschlagene Migration beheben".',
        };
      }
      return {
        action: 'continue-schema-current',
        message:
          'MIGRATE_DEPLOY_FAILED_BUT_SCHEMA_CURRENT: prisma migrate deploy failed, but every migration of this image is applied and no INVALID index exists. ' +
          `Failed migration(s) not in this image: ${a.failedForeign.join(', ') || 'none found'}. Starting anyway. ` +
          'Fix per RAILWAY-SETUP.md "Fehlgeschlagene Migration beheben".',
      };
    }
  }
  if (isDbPushFallbackAllowed(env)) {
    return {
      action: 'db-push-fallback',
      message: `MIGRATE_DEPLOY_FAILED: continuing with prisma db push because ${DB_PUSH_FALLBACK_FLAG}=true`,
    };
  }
  return {
    action: 'abort',
    message:
      'MIGRATE_DEPLOY_FAILED: prisma migrate deploy failed and this image has unapplied migrations (or the state could not be read). ' +
      'Aborting deploy (exit 1), the old container keeps serving. ' +
      'See RAILWAY-SETUP.md "Fehlgeschlagene Migration beheben". ' +
      `Emergency only: ${DB_PUSH_FALLBACK_FLAG}=true enables the db push fallback.`,
  };
}
