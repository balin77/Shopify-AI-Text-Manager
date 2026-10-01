-- Weekly automatic storefront crawl (Max plan): merchant switch + backoff stamp.
--
-- Defaulted and nullable columns on an existing table — safe to ship with the
-- code, an older container simply never selects them. Default TRUE matches the
-- sweep's intent (an entitled shop gets the weekly delivery report unless it
-- opts out) and NULL means "never auto-crawled", which the due-query already
-- treats as longest-waiting. No backfill needed.
--
-- The stamp is deliberately NOT shared with lastAutoAuditAt: the audit runs
-- daily and the crawl weekly, and one column cannot hold two cadences.
ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "seoAutoCrawlEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "lastAutoCrawlAt" TIMESTAMP(3);

-- Backs the sweep's due-query (plan filter + oldest-first ordering).
CREATE INDEX IF NOT EXISTS "AISettings_subscriptionPlan_lastAutoCrawlAt_idx"
  ON "AISettings" ("subscriptionPlan", "lastAutoCrawlAt");
