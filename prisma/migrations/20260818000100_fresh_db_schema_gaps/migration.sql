-- Vier Spalten und ein Indexname, die im Prisma-Schema stehen, aber in KEINER
-- Migration. Sie wurden irgendwann per `prisma db push` auf die bestehenden
-- Datenbanken gebracht und nie als Migration festgehalten.
--
-- Warum das keine Kosmetik ist: auf einer FRISCHEN Datenbank läuft
-- `prisma migrate deploy` durch und die App startet — nur fehlen ihr diese
-- Spalten. `seoTitleSuffixEnabled`/`seoTitleSuffix` liest der SEO-Score
-- (seo-score.ts, SettingsSEOTab), `selectedModel` jeder AI-Aufruf, `aiModel`
-- jede Task-Zeile. Der Fehler käme also nicht beim Deploy, sondern beim ersten
-- Request — die unangenehmere Hälfte.
--
-- Gefunden beim Verifizieren der Content-Creation-Migration: erst nachdem
-- 20260516000004 auf einer frischen DB nicht mehr abbrach, wurde ein
-- `migrate diff` gegen das Schema überhaupt aussagekräftig.
--
-- Alles `IF NOT EXISTS` bzw. bedingt: auf jeder bestehenden Datenbank ist das
-- ein reiner No-Op, weil `db push` die Spalten dort längst angelegt hat.

ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "selectedModel"         TEXT,
  ADD COLUMN IF NOT EXISTS "seoTitleSuffix"        TEXT,
  ADD COLUMN IF NOT EXISTS "seoTitleSuffixEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Task"
  ADD COLUMN IF NOT EXISTS "aiModel" TEXT;

-- Der Unique-Index auf GroupedFieldTranslation trägt auf migrierten DBs den
-- von Postgres bei 63 Zeichen abgeschnittenen Namen, während Prisma selbst
-- kürzt und deshalb einen anderen erwartet. Funktional identisch, aber solange
-- die Namen auseinanderlaufen meldet `migrate diff` dauerhaft Drift — und
-- Drift, die immer da ist, liest irgendwann niemand mehr.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relkind = 'i'
      AND relname = 'GroupedFieldTranslation_shop_fieldKey_sourceLocale_sourceValueN'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relkind = 'i'
      AND relname = 'GroupedFieldTranslation_shop_fieldKey_sourceLocale_sourceVa_key'
  ) THEN
    ALTER INDEX "GroupedFieldTranslation_shop_fieldKey_sourceLocale_sourceValueN"
      RENAME TO "GroupedFieldTranslation_shop_fieldKey_sourceLocale_sourceVa_key";
  END IF;
END $$;
