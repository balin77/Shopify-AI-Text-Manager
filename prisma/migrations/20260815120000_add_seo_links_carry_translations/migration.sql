-- Merchant-facing switch for "Übersetzungen mitführen" on SEO → interne
-- Verlinkung. Accepting a link suggestion changes only the markup of the
-- primary text, so the usual stale-translation purge would discard correct
-- translations; with this on (the default, matching the behaviour that shipped
-- before the switch was persisted) the accept skips the purge and carries the
-- link into every translation with its localized URL instead.
ALTER TABLE "AISettings"
  ADD COLUMN "seoLinksCarryTranslations" BOOLEAN NOT NULL DEFAULT true;
