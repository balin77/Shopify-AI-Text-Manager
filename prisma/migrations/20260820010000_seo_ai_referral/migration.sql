-- AI referral tracking: aggregate visits that arrived from an AI assistant.
--
-- New table, no backfill. Aggregate only — one row per (shop, source, UTC day,
-- landing path) with a counter, no visitor identifier of any kind. The unique
-- key IS the aggregation, so the collector is a plain upsert.
CREATE TABLE IF NOT EXISTS "SeoAiReferral" (
  "id"          TEXT NOT NULL,
  "shop"        TEXT NOT NULL,
  "source"      TEXT NOT NULL,
  "day"         DATE NOT NULL,
  "path"        TEXT NOT NULL,
  "pathHash"    TEXT NOT NULL,
  "count"       INTEGER NOT NULL DEFAULT 1,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SeoAiReferral_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SeoAiReferral_shop_source_day_pathHash_key"
  ON "SeoAiReferral" ("shop", "source", "day", "pathHash");

CREATE INDEX IF NOT EXISTS "SeoAiReferral_shop_day_idx"
  ON "SeoAiReferral" ("shop", "day");

CREATE INDEX IF NOT EXISTS "SeoAiReferral_shop_source_day_idx"
  ON "SeoAiReferral" ("shop", "source", "day");
