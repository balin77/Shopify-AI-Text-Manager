import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const exec = (sql) => db.$executeRawUnsafe(sql);
const q = (sql) => db.$queryRawUnsafe(sql);

const before = await q(`SELECT pg_size_pretty(pg_database_size(current_database())) s`);
console.log('DB size before:', before[0].s);

console.log('CHECKPOINT...');
await exec('CHECKPOINT');

for (const t of ['ThemeTranslation', 'ThemeContent', 'ContentTranslation', 'ProductMetafield', 'ProductImage', 'Product']) {
  process.stdout.write(`VACUUM FULL "${t}"... `);
  await exec(`VACUUM FULL "${t}"`);
  await exec(`ANALYZE "${t}"`);
  console.log('done');
}

console.log('CHECKPOINT (recycle WAL)...');
await exec('CHECKPOINT');

const after = await q(`SELECT pg_size_pretty(pg_database_size(current_database())) s`);
const wal = await q(`SELECT pg_size_pretty(sum(size)) w, count(*)::int n FROM pg_ls_waldir()`);
console.log('DB size after :', after[0].s);
console.log('WAL after     :', wal[0].w, `(${wal[0].n} files)`);

process.exit(0);
