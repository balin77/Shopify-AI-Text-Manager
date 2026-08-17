-- Rolling monthly IndexNow submission quota (PlanLimits.seo.monthlyIndexNowSubmissions).
--
-- Two defaulted/nullable columns on an existing table: safe to ship with the
-- code, an older container simply never selects them. The counter resets
-- lazily whenever "submitPeriod" no longer matches the current UTC YYYY-MM,
-- so no backfill and no cron are needed.
ALTER TABLE "SeoIndexNowConfig"
  ADD COLUMN IF NOT EXISTS "submitPeriod" TEXT;

ALTER TABLE "SeoIndexNowConfig"
  ADD COLUMN IF NOT EXISTS "submitCount" INTEGER NOT NULL DEFAULT 0;
