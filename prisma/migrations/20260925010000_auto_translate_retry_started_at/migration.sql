-- When a retry's current attempt started. The stale-"running" recovery reads
-- this rather than "updatedAt", which every enqueue on the row bumps — a row
-- whose runner died and that keeps receiving refusals was otherwise never
-- picked up again. Nullable, no backfill.
ALTER TABLE "AutoTranslateRetry" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
