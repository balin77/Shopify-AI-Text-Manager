import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const q = (sql) => db.$queryRawUnsafe(sql);

console.log('--- replication slots (stuck slot = WAL never freed) ---');
console.log(await q(`SELECT slot_name, slot_type, active, wal_status,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
  FROM pg_replication_slots`));

console.log('--- wal settings ---');
console.log(await q(`SELECT name, setting, unit FROM pg_settings
  WHERE name IN ('max_wal_size','min_wal_size','wal_keep_size','checkpoint_timeout','archive_mode')`));

console.log('--- ThemeTranslation rows per shop ---');
console.log(await q(`SELECT shop, count(*)::int AS rows
  FROM "ThemeTranslation" GROUP BY shop ORDER BY rows DESC`));

console.log('--- total ThemeTranslation rows + payload size ---');
console.log(await q(`SELECT count(*)::int AS rows,
  pg_size_pretty(sum(pg_column_size(value))) AS value_bytes
  FROM "ThemeTranslation"`));

console.log('--- WebhookLog / Task / GdprAuditLog age ---');
console.log(await q(`SELECT 'WebhookLog' t, count(*)::int n, min("createdAt") oldest, max("createdAt") newest FROM "WebhookLog"
  UNION ALL SELECT 'Task', count(*)::int, min("createdAt"), max("createdAt") FROM "Task"
  UNION ALL SELECT 'GdprAuditLog', count(*)::int, min("createdAt"), max("createdAt") FROM "GdprAuditLog"`));

process.exit(0);
