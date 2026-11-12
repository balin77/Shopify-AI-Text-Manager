-- Additive: cache token volume per ledger row (PLAN_BULK_TRANSLATE_BATCHING 3.6).
ALTER TABLE "AiUsageCounter"
  ADD COLUMN IF NOT EXISTS "cacheReadTokens" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cacheWriteTokens" BIGINT NOT NULL DEFAULT 0;
