import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const exec = (sql) => db.$executeRawUnsafe(sql);
const q = (sql) => db.$queryRawUnsafe(sql);

await exec(`ALTER SYSTEM SET max_wal_size = '256MB'`);
await exec(`ALTER SYSTEM SET min_wal_size = '64MB'`);
await q(`SELECT pg_reload_conf()`);
console.log('config reloaded:', await q(
  `SELECT name, setting, unit FROM pg_settings WHERE name IN ('max_wal_size','min_wal_size')`));

// Several checkpoints over time let Postgres recycle segments down toward max_wal_size
for (let i = 1; i <= 4; i++) {
  await exec('CHECKPOINT');
  const wal = await q(`SELECT pg_size_pretty(sum(size)) w, count(*)::int n FROM pg_ls_waldir()`);
  console.log(`after CHECKPOINT ${i}: WAL ${wal[0].w} (${wal[0].n} files)`);
  if (i < 4) await new Promise(r => setTimeout(r, 3000));
}

const size = await q(`SELECT pg_size_pretty(pg_database_size(current_database())) s`);
console.log('DB size:', size[0].s);
process.exit(0);
