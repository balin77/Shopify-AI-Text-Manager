import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

const dbSize = await db.$queryRawUnsafe(
  `SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`
);
console.log('DB SIZE:', dbSize);

const tables = await db.$queryRawUnsafe(`
  SELECT c.relname AS table,
         pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
         pg_size_pretty(pg_relation_size(c.oid))       AS data,
         s.n_live_tup                                  AS rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE c.relkind = 'r' AND n.nspname = 'public'
  ORDER BY pg_total_relation_size(c.oid) DESC
  LIMIT 25
`);
console.table(tables);

const wal = await db.$queryRawUnsafe(
  `SELECT pg_size_pretty(sum(size)) AS wal_total, count(*) AS wal_files FROM pg_ls_waldir()`
);
console.log('WAL:', wal);

process.exit(0);
