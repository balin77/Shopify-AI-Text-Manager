-- Nightly SEO audit sweep (Max plan): backoff stamp per shop.
--
-- Nullable column on an existing table — safe to ship with the code, an older
-- container simply never selects it. NULL means "never auto-scanned", which is
-- exactly what the sweep's due-query treats as longest-waiting, so no backfill
-- is needed.
ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "lastAutoAuditAt" TIMESTAMP(3);

-- Backs the sweep's due-query (plan filter + oldest-first ordering).
CREATE INDEX IF NOT EXISTS "AISettings_subscriptionPlan_lastAutoAuditAt_idx"
  ON "AISettings" ("subscriptionPlan", "lastAutoAuditAt");
