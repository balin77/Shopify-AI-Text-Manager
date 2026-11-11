/**
 * Reads the state decideAfterMigrateDeploy needs after a failed `prisma migrate
 * deploy`: the migration folders of THIS image and the rows of _prisma_migrations.
 * Shared by run-all-migrations.js and run-migration.js so both judge a failed
 * deploy by the same evidence. Returns null when it cannot be read (= "cannot
 * tell", which the decision treats as abort).
 */
import { readdirSync, statSync } from 'fs';

export async function readSchemaState({
  makePrisma = async () => {
    const { PrismaClient } = await import('@prisma/client');
    return new PrismaClient();
  },
  listDir = readdirSync,
  isDir = (p) => statSync(p).isDirectory(),
  log = () => {},
} = {}) {
  try {
    const localMigrations = listDir('prisma/migrations').filter((n) => isDir(`prisma/migrations/${n}`));
    const prisma = await makePrisma();
    try {
      const dbRows = await prisma.$queryRawUnsafe(
        'SELECT "migration_name", "finished_at", "rolled_back_at" FROM "_prisma_migrations"');
      // INVALID indexes (failed or still-running CREATE INDEX CONCURRENTLY). A failed
      // read is null = "cannot tell", which the decision treats as abort.
      let invalidIndexes = null;
      try {
        const idx = await prisma.$queryRawUnsafe(
          'SELECT indexrelid::regclass::text AS index_name FROM pg_index WHERE NOT indisvalid');
        invalidIndexes = idx.map((r) => String(r.index_name));
      } catch (e) {
        log(`  ↳ pg_index check failed: ${e.message?.substring(0, 120)}`);
      }
      return { localMigrations, dbRows, invalidIndexes };
    } finally {
      await prisma.$disconnect();
    }
  } catch (e) {
    log(`  ↳ Schema state check failed: ${e.message?.substring(0, 120)}`);
    return null;
  }
}
