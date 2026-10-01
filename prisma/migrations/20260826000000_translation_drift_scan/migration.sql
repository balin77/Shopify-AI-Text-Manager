-- The change event Shopify does not send.
--
-- Products and collections have an update webhook; pages, articles, blogs and
-- shop policies have none at all, so until now the only moment this app knew
-- one of their texts had moved was a save it made itself. A periodic sweep
-- plays that missing webhook, and this is its backoff stamp.
--
-- Its OWN column rather than a shared one: the audit runs nightly, the crawl
-- weekly and this one on its own cadence, and a single stamp cannot express
-- three. Nullable with no default, so every existing shop is due immediately
-- and the first sweep is harmless by construction (no stored digest is no
-- evidence, so nothing is considered stale on a first look).
ALTER TABLE "AISettings" ADD COLUMN "lastTranslationScanAt" TIMESTAMP(3);

CREATE INDEX "AISettings_subscriptionPlan_lastTranslationScanAt_idx"
  ON "AISettings"("subscriptionPlan", "lastTranslationScanAt");
