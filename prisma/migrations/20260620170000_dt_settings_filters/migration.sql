-- Two opt-in filters on the direct-translation collector:
--  * ignoreTranslateNo — also walk + replace text inside translate="no"
--    elements (3rd-party review/widget apps fence themselves off there).
--  * filterByLanguage  — server-side language-detect (franc) drops collected
--    candidates whose language matches the visitor locale (already-served).
ALTER TABLE "DirectTranslationSettings"
  ADD COLUMN IF NOT EXISTS "ignoreTranslateNo" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "filterByLanguage"  BOOLEAN NOT NULL DEFAULT false;
