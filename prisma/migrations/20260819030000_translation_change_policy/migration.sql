-- Translation-change policy (Settings → Übersetzungen).
--
-- Two defaulted columns on an existing table: safe to ship with the code, an
-- older container simply never selects them, so there is no deploy ordering
-- requirement and no backfill.
--
--   translationPurgeOnPrimaryChange — default TRUE reproduces the behaviour
--   that was hard-coded until now (a changed/cleared primary value deletes its
--   foreign translations on Shopify and locally). FALSE keeps them.
--
--   autoTranslateExternalChanges — default FALSE because it spends the
--   merchant's AI budget while nobody is looking. Plan-gated to "max" in code
--   on every read, so a stored TRUE from a former Max period stays inert.
ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "translationPurgeOnPrimaryChange" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "autoTranslateExternalChanges" BOOLEAN NOT NULL DEFAULT false;
