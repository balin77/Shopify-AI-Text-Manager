-- Phase 2b: storefront string collector. Adds an opt-in `collect` flag and a
-- candidate table for untranslated strings discovered on the storefront,
-- pending merchant review. Idempotent so it is safe on every environment.

ALTER TABLE "DynamicTranslationSettings" ADD COLUMN IF NOT EXISTS "collect" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "DynamicTranslationCandidate" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "sourceHash" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DynamicTranslationCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DynamicTranslationCandidate_shop_locale_scope_sourceHash_key" ON "DynamicTranslationCandidate"("shop", "locale", "scope", "sourceHash");
CREATE INDEX IF NOT EXISTS "DynamicTranslationCandidate_shop_locale_idx" ON "DynamicTranslationCandidate"("shop", "locale");
