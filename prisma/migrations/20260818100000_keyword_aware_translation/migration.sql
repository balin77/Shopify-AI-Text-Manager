-- Keyword-aware translation opt-out.
--
-- Adding a defaulted column is safe to ship with its code: an older container
-- simply never selects it. (Contrast the intent DROP, which had to wait for a
-- follow-up deploy.)
ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "keywordAwareTranslation" BOOLEAN NOT NULL DEFAULT true;
