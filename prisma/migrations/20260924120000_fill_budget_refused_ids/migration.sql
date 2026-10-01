-- Repair for 20260924000000_primary_digest_baseline, which was EDITED after it
-- had been pushed: its first version created "AutoTranslateFillBudget" with a
-- "refused" INTEGER column, the second with "refusedIds" TEXT[]. A database
-- that applied the first version has the migration recorded as done and keeps
-- the old shape for good — CREATE TABLE IF NOT EXISTS never revisits it — so
-- every refusal report would fail on the missing column, caught and logged,
-- i.e. silently never shown.
--
-- Idempotent on both shapes. The old "refused" column is deliberately left in
-- place: it has a default, Prisma ignores columns the schema does not name,
-- and dropping it could break a container of the previous build that is still
-- draining during the deploy.
ALTER TABLE "AutoTranslateFillBudget"
  ADD COLUMN IF NOT EXISTS "refusedIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
