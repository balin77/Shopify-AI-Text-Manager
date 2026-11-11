/**
 * Reads the state decideAfterMigrateDeploy needs after a failed `prisma migrate
 * deploy`: the migration folders of THIS image and the rows of _prisma_migrations.
 * Shared by run-all-migrations.js and run-migration.js so both judge a failed
 * deploy by the same evidence. Returns null when it cannot be read (= "cannot
 * tell", which the decision treats as abort).
 */
import { readdirSync, readFileSync, statSync } from 'fs';

const CREATE_INDEX_RE =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z0-9_]+))/gi;

/** Lower-case names of all indexes the given migration.sql texts create. */
export function indexNamesFromSql(texts) {
  const names = new Set();
  for (const t of texts) {
    // Strip line comments first: prose like "CREATE INDEX CONCURRENTLY for ..." is not an index.
    const sql = String(t).replace(/--.*$/gm, '');
    for (const m of sql.matchAll(CREATE_INDEX_RE)) names.add((m[1] ?? m[2]).toLowerCase());
  }
  return [...names];
}

export async function readSchemaState({
  makePrisma = async () => {
    const { PrismaClient } = await import('@prisma/client');
    return new PrismaClient();
  },
  listDir = readdirSync,
  isDir = (p) => statSync(p).isDirectory(),
  readText = (p) => readFileSync(p, 'utf8'),
  log = () => {},
} = {}) {
  try {
    const localMigrations = listDir('prisma/migrations').filter((n) => isDir(`prisma/migrations/${n}`));
    const localIndexNames = indexNamesFromSql(
      localMigrations.map((n) => readText(`prisma/migrations/${n}/migration.sql`)));
    const prisma = await makePrisma();
    try {
      const dbRows = await prisma.$queryRawUnsafe(
        'SELECT "migration_name", "finished_at", "rolled_back_at" FROM "_prisma_migrations"');
      // INVALID indexes (failed or still-running CREATE INDEX CONCURRENTLY). A failed
      // read is null = "cannot tell", which the decision treats as abort.
      let invalidIndexes = null;
      try {
        const idx = await prisma.$queryRawUnsafe(
          'SELECT c.relname AS index_name FROM pg_index i ' +
          'JOIN pg_class c ON c.oid = i.indexrelid ' +
          'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
          'WHERE NOT i.indisvalid AND n.nspname = current_schema()');
        invalidIndexes = idx.map((r) => String(r.index_name));
      } catch (e) {
        log(`  ↳ pg_index check failed: ${e.message?.substring(0, 120)}`);
      }
      return { localMigrations, dbRows, invalidIndexes, localIndexNames };
    } finally {
      await prisma.$disconnect();
    }
  } catch (e) {
    log(`  ↳ Schema state check failed: ${e.message?.substring(0, 120)}`);
    return null;
  }
}
