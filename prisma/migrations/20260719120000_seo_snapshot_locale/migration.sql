-- Add per-locale audit snapshots (SEO overview language buttons).
-- Existing snapshots become primary-locale snapshots (locale = '' sentinel,
-- same convention ContentTranslation.marketId uses for "global").

ALTER TABLE "SeoScoreSnapshot" ADD COLUMN "locale" TEXT NOT NULL DEFAULT '';

-- Replace the (shop, createdAt) index with one that includes locale so the
-- latest-snapshot / trend reads (both scoped by locale) stay index-only.
DROP INDEX IF EXISTS "SeoScoreSnapshot_shop_createdAt_idx";
CREATE INDEX "SeoScoreSnapshot_shop_locale_createdAt_idx" ON "SeoScoreSnapshot"("shop", "locale", "createdAt");
