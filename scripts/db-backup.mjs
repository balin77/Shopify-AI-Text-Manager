/**
 * Postgres backup to Cloudflare R2 (Railway cron service "Db Backup").
 *
 * Railway's own snapshots are a service-level rollback: you cannot pick a
 * point in time, and you cannot pull a single table back out. Before a
 * destructive migration that is not enough — this produces an independent,
 * off-site, restorable dump and proves it is readable before calling it done.
 *
 * Sequence (each step aborts the run on failure — a half-done backup is
 * reported as a failure, never as a success):
 *   1. version check   — pg_dump major must be >= server major
 *   2. pg_dump -Fc     — custom format, so a restore can pick single tables
 *   3. pg_restore -l   — the archive is parsed back; a truncated or empty
 *                        dump fails HERE, in the backup window, not during
 *                        the restore you are attempting under pressure
 *   4. PutObject       — uploaded to R2 under a date-partitioned key
 *   5. retention       — dumps older than BACKUP_RETENTION_DAYS are deleted,
 *                        except the newest BACKUP_KEEP_MINIMUM
 *
 * Modes:
 *   (default)  cron mode — posts to the webhook ONLY on failure, exit 1.
 *   --test     posts a ✅ summary even on success, proving the webhook and
 *              the R2 credentials work. Still takes a real backup.
 *   --dry-run  runs steps 1-3 and skips the upload and retention. Verifies
 *              pg_dump works in this image without touching the bucket.
 *
 * Env:
 *   DATABASE_URL           - Postgres connection (injected by Railway)
 *   R2_ACCOUNT_ID          - Cloudflare account id (builds the endpoint), or
 *   R2_ENDPOINT            - full endpoint URL, overrides R2_ACCOUNT_ID
 *   R2_BUCKET              - target bucket
 *   R2_ACCESS_KEY_ID       - R2 API token access key
 *   R2_SECRET_ACCESS_KEY   - R2 API token secret
 *   BACKUP_PREFIX          - key prefix / filename stem, default "contentpilot"
 *   BACKUP_RETENTION_DAYS  - delete dumps older than this, default 30, 0 = keep all
 *   BACKUP_KEEP_MINIMUM    - never delete the newest N dumps, default 3
 *   ALERT_WEBHOOK_URL      - Slack/Discord webhook (same one the DB space
 *                            checker uses); if unset, failures are only logged
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import {
  MIN_PLAUSIBLE_DUMP_BYTES,
  backupObjectKey,
  formatBytes,
  isDumpClientCompatible,
  parseClientMajor,
  parseServerMajor,
  pgEnvFromUrl,
  redactSecrets,
  selectPrunable,
} from './db-backup.lib.mjs';

const isTest = process.argv.includes('--test') || process.env.BACKUP_TEST === '1';
const isDryRun = process.argv.includes('--dry-run');

const databaseUrl = process.env.DATABASE_URL;
const webhook = process.env.ALERT_WEBHOOK_URL;
const prefix = process.env.BACKUP_PREFIX || 'contentpilot';
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? '30');
const keepMinimum = Number(process.env.BACKUP_KEEP_MINIMUM ?? '3');

// Every secret that must never reach a log line or the webhook.
const secrets = [
  databaseUrl,
  process.env.R2_SECRET_ACCESS_KEY,
  process.env.R2_ACCESS_KEY_ID,
].filter(Boolean);

const log = (msg) => console.log(redactSecrets(msg, secrets));

async function post(text) {
  if (!webhook) {
    console.log('(no ALERT_WEBHOOK_URL set — message not sent)');
    return;
  }
  try {
    // `content` = Discord, `text` = Slack — send both keys for compatibility.
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: redactSecrets(text, secrets),
        text: redactSecrets(text, secrets),
      }),
    });
    console.log('Webhook status:', res.status);
  } catch (e) {
    console.error('Webhook failed:', redactSecrets(e.message, secrets));
  }
}

/** Run a command, capture stdout/stderr, reject with a redacted message. */
function run(cmd, args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (e) =>
      reject(new Error(`${cmd} could not be started: ${e.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = redactSecrets(stderr.trim() || stdout.trim(), secrets);
      reject(new Error(`${cmd} exited with code ${code}: ${detail}`));
    });
  });
}

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`missing environment variable(s): ${missing.join(', ')}`);
  }
}

function r2Client() {
  const endpoint =
    process.env.R2_ENDPOINT ||
    `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: 'auto', // R2 ignores region but the SDK requires one.
    endpoint,
    // The SDK defaults to virtual-hosted-style, which turns the endpoint into
    // <bucket>.<account>.r2.cloudflarestorage.com. Path-style keeps the bucket
    // in the path, which is what R2's account endpoint expects and what also
    // survives a bucket name containing dots (those break wildcard TLS).
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function main() {
  requireEnv(['DATABASE_URL']);
  if (!isDryRun) {
    requireEnv(['R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
    if (!process.env.R2_ENDPOINT && !process.env.R2_ACCOUNT_ID) {
      throw new Error('set either R2_ACCOUNT_ID or R2_ENDPOINT');
    }
  }

  // A cron container that hangs on connect runs (and bills) until someone
  // notices. libpq's own connect timeout is the cheap bound; the URL may
  // override it, so it goes in first.
  const pgEnv = { PGCONNECT_TIMEOUT: '15', ...pgEnvFromUrl(databaseUrl) };

  // ── 1. version check ────────────────────────────────────────────
  const { stdout: dumpBanner } = await run('pg_dump', ['--version']);
  const clientMajor = parseClientMajor(dumpBanner);

  // -X: ignore ~/.psqlrc. A startup file that sets a pager or extra output
  // would end up inside the string we parse the server version out of.
  const { stdout: serverRaw } = await run(
    'psql',
    ['-X', '-tAc', 'SHOW server_version_num'],
    { env: pgEnv },
  );
  const serverMajor = parseServerMajor(serverRaw);

  if (!isDumpClientCompatible(clientMajor, serverMajor)) {
    throw new Error(
      `pg_dump ${clientMajor ?? 'unknown'} cannot dump from server ` +
        `${serverMajor ?? 'unknown'}. Pin a matching client in the Dockerfile ` +
        `(apk add postgresql${serverMajor ?? 'NN'}-client) and redeploy.`,
    );
  }
  log(`pg_dump ${clientMajor} vs server ${serverMajor} — compatible`);

  // ── 2. dump ─────────────────────────────────────────────────────
  const workDir = await mkdtemp(path.join(tmpdir(), 'cp-backup-'));
  const dumpPath = path.join(workDir, 'db.dump');

  try {
    const startedAt = Date.now();
    await run(
      'pg_dump',
      [
        '--format=custom',
        '--compress=9',
        // Restores usually land in a fresh Railway database whose role has a
        // different name; carrying owners/grants over would make every
        // statement fail on a role that does not exist there.
        '--no-owner',
        '--no-privileges',
        `--file=${dumpPath}`,
      ],
      { env: pgEnv },
    );

    const { size } = await stat(dumpPath);
    if (size < MIN_PLAUSIBLE_DUMP_BYTES) {
      throw new Error(
        `dump is only ${size} bytes — treating as a failed dump, not an empty database`,
      );
    }
    const dumpSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`dump written: ${formatBytes(size)} in ${dumpSeconds}s`);

    // ── 3. verify the archive is readable ─────────────────────────
    const { stdout: toc } = await run('pg_restore', ['--list', dumpPath]);
    const entries = toc
      .split('\n')
      .filter((l) => l.trim() && !l.trimStart().startsWith(';')).length;
    if (entries === 0) {
      throw new Error('pg_restore --list found no entries — archive unusable');
    }
    log(`archive verified: ${entries} restorable entries`);

    if (isDryRun) {
      log('--dry-run: skipping upload and retention');
      return { size, entries, key: null, pruned: [], serverMajor };
    }

    // ── 4. upload ─────────────────────────────────────────────────
    const bucket = process.env.R2_BUCKET;
    const key = backupObjectKey(prefix, new Date());
    const client = r2Client();

    // lib-storage's Upload, not a plain PutObjectCommand: it uploads in parts
    // and retries a FAILED PART. A PutObject whose Body is a ReadStream cannot
    // be retried at all — the SDK's second attempt would find the stream
    // already consumed and upload nothing. It also lifts the 5 GiB single-PUT
    // ceiling, so the dump size needs no guard.
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: createReadStream(dumpPath),
        ContentType: 'application/octet-stream',
        Metadata: {
          'server-major': String(serverMajor),
          'pgdump-major': String(clientMajor),
          'toc-entries': String(entries),
        },
      },
      queueSize: 3,
      partSize: 64 * 1024 * 1024,
    });
    await upload.done();
    log(`uploaded s3://${bucket}/${key}`);

    // ── 5. retention ──────────────────────────────────────────────
    const listed = [];
    let token;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: token,
        }),
      );
      listed.push(...(page.Contents ?? []));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    const prunable = selectPrunable(listed, {
      now: new Date(),
      retentionDays,
      keepMinimum,
    });

    // DeleteObjects takes at most 1000 keys per call.
    for (let i = 0; i < prunable.length; i += 1000) {
      const chunk = prunable.slice(i, i + 1000);
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
    }
    log(
      prunable.length
        ? `retention: deleted ${prunable.length} dump(s) older than ${retentionDays} days ` +
            `(${listed.length} in bucket before pruning)`
        : `retention: nothing to delete (${listed.length} dump(s) in bucket)`,
    );

    return { size, entries, key, pruned: prunable, serverMajor };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

try {
  const result = await main();
  const summary =
    `✅ ContentPilot DB-Backup ok — ${formatBytes(result.size)}, ` +
    `${result.entries} Objekte, Server PG ${result.serverMajor}` +
    (result.key ? `\nZiel: ${result.key}` : ' (dry run, kein Upload)') +
    (result.pruned.length ? `\nRetention: ${result.pruned.length} alte Dumps gelöscht` : '');
  log(summary);
  if (isTest) await post(summary);
  process.exit(0);
} catch (e) {
  const message = redactSecrets(e?.message || String(e), secrets);
  console.error(`❌ DB-Backup fehlgeschlagen: ${message}`);
  // Failures always alert — a backup nobody notices is missing is the whole
  // failure mode this service exists to prevent.
  await post(`🚨 ContentPilot DB-Backup FEHLGESCHLAGEN: ${message}`);
  process.exit(1);
}
