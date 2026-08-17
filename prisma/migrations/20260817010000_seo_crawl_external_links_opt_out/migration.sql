-- PLAN_SEO_CRAWL_EXPANSION §6.5 — opt-out for the external-link check.
--
-- Default TRUE: without the check the "external links" report is empty and the
-- feature does not exist for anyone who never finds the switch. It stays
-- switchable because this is the only part of the app that sends requests to
-- servers neither the merchant nor we control, and it lengthens the crawl.
ALTER TABLE "AISettings"
  ADD COLUMN "seoCrawlExternalLinks" BOOLEAN NOT NULL DEFAULT true;
