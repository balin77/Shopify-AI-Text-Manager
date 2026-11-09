-- Session(shop): the activity tracker and the /admin overview look sessions up
-- by shop; without an index each lookup scans the table.
--
-- Additive: an index only. Built CONCURRENTLY so it does not block writes to the
-- hot Session table. CONCURRENTLY cannot run inside a transaction block, and
-- Prisma runs a one-statement migration file without an implicit transaction --
-- so this file MUST stay a single statement (same rule and reasoning as
-- 20261002000000_productimage_mediaid_index). IF NOT EXISTS keeps a re-run
-- idempotent.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Session_shop_idx" ON "Session"("shop");
