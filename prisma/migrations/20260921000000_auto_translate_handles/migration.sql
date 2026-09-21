-- "Auch URL-Handles übersetzen" — the opt-in sub-decision under
-- autoTranslateExternalChanges (Settings -> AI instructions -> Translations).
--
-- One defaulted column on an existing table: safe to ship with the code, an
-- older container simply never selects it, so there is no deploy ordering
-- requirement and no backfill.
--
-- Default FALSE reproduces the behaviour that was hard-coded until now: a
-- stale `handle` translation is deleted and never re-translated, because a
-- slug is a URL. With the column TRUE the re-translation may refresh one, but
-- only where a redirect can be created for the old foreign URL first.
--
-- Plan-gated to "max" in code on every read (the same gate the parent switch
-- carries), and ANDed with the parent switch, so a stored TRUE is inert
-- wherever the automation itself is off.
ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "autoTranslateHandles" BOOLEAN NOT NULL DEFAULT false;
