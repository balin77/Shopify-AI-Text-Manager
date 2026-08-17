/**
 * Pure helpers for scripts/db-backup.mjs.
 *
 * Split out so the parts that decide WHAT HAPPENS TO EXISTING BACKUPS are
 * unit-testable without a Postgres server and without an R2 bucket. The
 * retention logic in particular deletes data — it must be provable in a test,
 * not "looked right when I ran it once".
 */

/**
 * Major version out of a `pg_dump --version` / `psql --version` banner, e.g.
 *   "pg_dump (PostgreSQL) 17.2"                      -> 17
 *   "psql (PostgreSQL) 16.13 (Ubuntu 16.13-0ubuntu)" -> 16
 * Returns null when the banner does not parse — the caller must treat that as
 * "unknown", never as "compatible".
 */
export function parseClientMajor(banner) {
  if (typeof banner !== 'string') return null;
  const m = banner.match(/\(PostgreSQL\)\s+(\d+)/i) || banner.match(/\b(\d+)\.\d+/);
  if (!m) return null;
  const major = Number(m[1]);
  return Number.isInteger(major) && major > 0 ? major : null;
}

/**
 * Major version out of `SHOW server_version_num` (an integer like 170004).
 * Pre-10 servers encode 9.6 as 90600; those report major 9, which is
 * conservative for our >= comparison (any modern client beats it).
 */
export function parseServerMajor(versionNum) {
  const n = Number(String(versionNum).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n / 10000);
}

/**
 * pg_dump refuses to dump from a server NEWER than itself, and a dump taken by
 * a mismatched client is the kind of failure you discover during a restore.
 * So the check is >=, and an unknown version on either side is a hard stop.
 */
export function isDumpClientCompatible(clientMajor, serverMajor) {
  if (!Number.isInteger(clientMajor) || !Number.isInteger(serverMajor)) return false;
  return clientMajor >= serverMajor;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/**
 * Object key for one dump, date-partitioned so the bucket stays browsable:
 *   contentpilot/2026/08/17/contentpilot-20260817T114205Z.dump
 * Always UTC — a cron container's local zone is not a thing to depend on, and
 * a DST jump must not make two backups sort out of order.
 */
export function backupObjectKey(prefix, date) {
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const stamp =
    `${y}${mo}${d}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}` +
    `${pad(date.getUTCSeconds())}Z`;
  return `${prefix}/${y}/${mo}/${d}/${prefix}-${stamp}.dump`;
}

export const DUMP_SUFFIX = '.dump';

/**
 * Which stored objects retention may delete.
 *
 * Three deliberate safety properties, because this is the only destructive
 * thing the service does:
 *  1. `keepMinimum` newest dumps are NEVER deleted, whatever their age. If the
 *     cron silently stopped months ago, the next run must not interpret "all
 *     backups are old" as "delete all backups".
 *  2. Only keys ending in .dump are considered. The bucket prefix may hold
 *     other things (a README, a manual export); retention does not own them.
 *  3. An entry without a usable LastModified is skipped, not guessed at.
 *
 * retentionDays <= 0 disables pruning entirely.
 */
export function selectPrunable(objects, { now, retentionDays, keepMinimum = 3 }) {
  if (!Array.isArray(objects)) return [];
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];

  const dumps = objects
    .filter((o) => typeof o?.Key === 'string' && o.Key.endsWith(DUMP_SUFFIX))
    .map((o) => ({ key: o.Key, at: o.LastModified ? new Date(o.LastModified) : null }))
    .filter((o) => o.at instanceof Date && !Number.isNaN(o.at.getTime()));

  // Newest first, so the protected window is a plain slice.
  dumps.sort((a, b) => b.at.getTime() - a.at.getTime());

  const protectedCount = Math.max(0, keepMinimum);
  const candidates = dumps.slice(protectedCount);

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return candidates.filter((o) => o.at.getTime() < cutoff).map((o) => o.key);
}

/**
 * Strip credentials before anything reaches a log line or a chat webhook.
 * pg_dump/psql echo the connection string back in several error messages, and
 * DATABASE_URL carries the Postgres password — so the raw text of a failure is
 * not safe to forward as-is.
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join('«redacted»');
    }
  }
  // Catch any postgres URL that was built up rather than passed through.
  out = out.replace(/(postgres(?:ql)?:\/\/[^:@\s]+:)[^@\s]+@/gi, '$1«redacted»@');
  return out;
}

/**
 * Turn a DATABASE_URL into libpq PG* environment variables.
 *
 * The point is that the password never becomes a command-line argument:
 * `pg_dump "postgres://user:pw@host/db"` puts the credentials in argv, where
 * any other process in the container can read them off /proc and where they
 * land in a crash dump verbatim. libpq reads PGPASSWORD et al. from the
 * environment instead, so the child process gets no connection argv at all.
 *
 * Userinfo is percent-encoded in a URL (Railway passwords routinely contain
 * `/`, `+` and `@`), so both halves go through decodeURIComponent — skipping
 * that yields an authentication failure that looks like a wrong password.
 */
export function pgEnvFromUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!/^postgres(ql)?:$/i.test(url.protocol)) {
    throw new Error(`DATABASE_URL has unsupported protocol "${url.protocol}"`);
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL contains no database name');

  // Annotated because the keys below are set conditionally: without it the
  // type is inferred from this literal alone and PGUSER/PGPASSWORD/PGSSLMODE
  // become "does not exist on type" for every consumer.
  /** @type {Record<string, string>} */
  const env = {
    PGHOST: decodeURIComponent(url.hostname),
    PGPORT: url.port || '5432',
    PGDATABASE: database,
  };
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);

  // Honour the connection parameters that actually change whether we connect.
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  const schema = url.searchParams.get('schema');
  if (schema) env.PGOPTIONS = `--search_path=${schema}`;

  return env;
}

/** Bytes -> human size, for log lines and the webhook summary. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** A dump smaller than this is treated as a failed dump, not an empty database. */
export const MIN_PLAUSIBLE_DUMP_BYTES = 1024;
