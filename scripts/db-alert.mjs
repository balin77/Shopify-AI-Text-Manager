/**
 * Disk-usage alarm for the Railway Postgres volume.
 *
 * Postgres does not know its own volume size, so we measure
 *   used = pg_database_size(current_database()) + sum(WAL segment sizes)
 * and compare it against VOLUME_LIMIT_MB (the size you provisioned the
 * Railway volume at). If usage crosses ALERT_PCT, a message is POSTed to
 * ALERT_WEBHOOK_URL (Slack / Discord incoming-webhook compatible).
 *
 * Modes:
 *   (default)   cron mode  - posts ONLY when usage >= ALERT_PCT (no spam),
 *                            exit 2 when over threshold, else exit 0.
 *   --test      heartbeat  - ALWAYS posts a ✅ status message with the
 *                            current breakdown (DB / WAL / total / %),
 *                            proves the webhook works, exit 0.
 *
 * Env:
 *   DATABASE_URL        - Postgres connection (injected by Railway)
 *   VOLUME_LIMIT_MB     - provisioned Railway volume size in MB (e.g. 5120 for 5 GB)
 *   ALERT_PCT           - threshold in percent, default 70
 *   ALERT_WEBHOOK_URL   - Slack/Discord webhook; if unset, only logs
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const q = (sql) => db.$queryRawUnsafe(sql);

const isTest = process.argv.includes('--test') || process.env.ALERT_TEST === '1';

const limitMb = Number(process.env.VOLUME_LIMIT_MB);
if (!Number.isFinite(limitMb) || limitMb <= 0) {
  console.error('VOLUME_LIMIT_MB not set or invalid — cannot compute usage %.');
  process.exit(1);
}
const alertPct = Number(process.env.ALERT_PCT || '70');
const webhook = process.env.ALERT_WEBHOOK_URL;

const [{ db_bytes, wal_bytes }] = await q(`
  SELECT pg_database_size(current_database())                       AS db_bytes,
         COALESCE((SELECT sum(size) FROM pg_ls_waldir()), 0)::bigint AS wal_bytes
`);

const MB = 1024 * 1024;
const dbMb = Number(db_bytes) / MB;
const walMb = Number(wal_bytes) / MB;
const usedMb = dbMb + walMb;
const pct = (usedMb / limitMb) * 100;

const fmt = (n) => `${n.toFixed(0)} MB`;
const breakdown =
  `Daten ${fmt(dbMb)} + WAL ${fmt(walMb)} = ${fmt(usedMb)} / ${limitMb} MB ` +
  `(${pct.toFixed(1)}%, Schwelle ${alertPct}%)`;

console.log(breakdown);

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
      body: JSON.stringify({ content: text, text }),
    });
    console.log('Webhook status:', res.status);
  } catch (e) {
    console.error('Webhook failed:', e.message);
  }
}

if (isTest) {
  await post(
    `✅ ContentPilot DB-Alarm Testlauf — Webhook funktioniert.\n` +
    `Aktuelle Belegung: ${breakdown}`
  );
  process.exit(0);
}

if (pct >= alertPct) {
  await post(
    `🚨 ContentPilot Postgres-Volume bei ${pct.toFixed(1)}% — ` +
    `${breakdown}. Railway-Volume bald vergrößern.`
  );
  process.exit(2);
}

process.exit(0);
