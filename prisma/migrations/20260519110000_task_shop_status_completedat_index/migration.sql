-- R3-H5: /api/recently-completed-tasks is polled roughly every 2s by every
-- open admin tab with:
--   WHERE shop = ? AND status IN ('completed','failed')
--   AND completedAt >= ? ORDER BY completedAt DESC LIMIT 5
-- The existing [shop, status] index covers only the equality columns, so the
-- completedAt range + ordering forced a range scan. At thousands of shops
-- this is tens of thousands of scanning requests per minute. This composite
-- index lets Postgres satisfy the filter and the ORDER BY from the index.
-- Idempotent (CONCURRENTLY is not used — Prisma runs migrations in a txn).

CREATE INDEX IF NOT EXISTS "Task_shop_status_completedAt_idx"
  ON "Task"("shop", "status", "completedAt");
