/**
 * Disk-usage alarm for the Railway Postgres volume.
 *
 * Postgres does not know its own volume size, so we measure
 *   used = pg_database_size(current_database()) + sum(WAL segment sizes)
 * and compare it against VOLUME_LIMIT_MB (the size you provisioned the
 * Railway volume at). If usage crosses ALERT_PCT, a message is POSTed to
 * ALERT_WEBHOOK_URL (Slack / Discord incoming-webhook compatible).
 *
 * Env:
 *   DATABASE_URL        - Postgres connection (injected by Railway)
 *   VOLUME_LIMIT_MB     - provisioned Railway volume size in MB (e.g. 5120 for 5 GB)
 *   ALERT_PCT           - threshold in percent, default 70
 *   ALERT_WEBHOOK_URL   - Slack/Discord webhook; if unset, only logs + exit code
 *
 * Exit code 2 when over threshold (so cron logs/alerts even without a webhook).
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const q = (sql) => db.$queryRawUnsafe(sql);

const limitMb = Number(process.env.VOLUME_LIMIT_MB);
if (!Number.isFinite(limitMb) || limitMb <= 0) {
  console.error('VOLUME_LIMIT_MB not set or invalid — cannot compute usage %.');
  process.exit(1);
}
const alertPct = Number(process.env.ALERT_PCT || '70');
const webhook = process.env.ALERT_WEBHOOK_URL;

const [{ bytes }] = await q(`
  SELECT pg_database_size(current_database())
       + COALESCE((SELECT sum(size) FROM pg_ls_waldir()), 0) AS bytes
`);

const usedMb = Number(bytes) / (1024 * 1024);
const pct = (usedMb / limitMb) * 100;
const line =
  `DB volume: ${usedMb.toFixed(0)} MB / ${limitMb} MB (${pct.toFixed(1)}%)` +
  ` — threshold ${alertPct}%`;

console.log(line);

if (pct >= alertPct) {
  const text =
    `🚨 ContentPilot Postgres volume at ${pct.toFixed(1)}% ` +
    `(${usedMb.toFixed(0)}/${limitMb} MB). Resize the Railway volume soon.`;

  if (webhook) {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `content` works for Discord, `text` for Slack — send both keys.
        body: JSON.stringify({ content: text, text }),
      });
      console.log('Alert webhook status:', res.status);
    } catch (e) {
      console.error('Alert webhook failed:', e.message);
    }
  }
  process.exit(2);
}

process.exit(0);
