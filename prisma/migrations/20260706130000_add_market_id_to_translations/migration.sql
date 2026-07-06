-- Market-specific translations (Shopify "Translate & Adapt").
--
-- Adds a `marketId` dimension to every translation table. The sentinel value
-- "" means "global" (applies to all markets) and reproduces the legacy
-- behaviour, so every existing row is implicitly migrated to global by the
-- DEFAULT ''. A non-empty value is a gid://shopify/Market/<id> and represents a
-- market-specific override of the global translation for the same locale.
--
-- The composite unique key is extended by `marketId`. We use the sentinel ""
-- rather than NULL because SQL treats NULLs as distinct in unique constraints,
-- which would allow multiple "global" rows for the same (shop, resource, key,
-- locale) — exactly what we must forbid.
--
-- Idempotent (IF NOT EXISTS / IF EXISTS) and additive: existing rows keep their
-- data and become global. The unique index is rebuilt to include the new
-- column; on large tables run this in a maintenance window.

-- ============================================================
-- ContentTranslation (Phase 1 — active save path)
-- ============================================================
ALTER TABLE "ContentTranslation"
  ADD COLUMN IF NOT EXISTS "marketId" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ContentTranslation"
  DROP CONSTRAINT IF EXISTS "ContentTranslation_shop_resourceId_key_locale_key";
DROP INDEX IF EXISTS "ContentTranslation_shop_resourceId_key_locale_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ContentTranslation_shop_resourceId_key_locale_marketId_key"
  ON "ContentTranslation"("shop", "resourceId", "key", "locale", "marketId");

DROP INDEX IF EXISTS "ContentTranslation_shop_resourceId_locale_idx";
CREATE INDEX IF NOT EXISTS "ContentTranslation_shop_resourceId_locale_marketId_idx"
  ON "ContentTranslation"("shop", "resourceId", "locale", "marketId");

-- ============================================================
-- ThemeTranslation (Phase 2 — model kept consistent now)
-- ============================================================
ALTER TABLE "ThemeTranslation"
  ADD COLUMN IF NOT EXISTS "marketId" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ThemeTranslation"
  DROP CONSTRAINT IF EXISTS "ThemeTranslation_shop_resourceId_groupId_key_locale_key";
DROP INDEX IF EXISTS "ThemeTranslation_shop_resourceId_groupId_key_locale_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ThemeTranslation_shop_res_group_key_locale_market_key"
  ON "ThemeTranslation"("shop", "resourceId", "groupId", "key", "locale", "marketId");

-- ============================================================
-- MetaobjectTranslation (Phase 2)
-- ============================================================
ALTER TABLE "MetaobjectTranslation"
  ADD COLUMN IF NOT EXISTS "marketId" TEXT NOT NULL DEFAULT '';

ALTER TABLE "MetaobjectTranslation"
  DROP CONSTRAINT IF EXISTS "MetaobjectTranslation_shop_metaobjectId_key_locale_key";
DROP INDEX IF EXISTS "MetaobjectTranslation_shop_metaobjectId_key_locale_key";

CREATE UNIQUE INDEX IF NOT EXISTS "MetaobjectTranslation_shop_metaobjectId_key_locale_marketId_key"
  ON "MetaobjectTranslation"("shop", "metaobjectId", "key", "locale", "marketId");

-- ============================================================
-- ProductImageAltTranslation (Phase 2)
-- ============================================================
ALTER TABLE "ProductImageAltTranslation"
  ADD COLUMN IF NOT EXISTS "marketId" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ProductImageAltTranslation"
  DROP CONSTRAINT IF EXISTS "ProductImageAltTranslation_imageId_locale_key";
DROP INDEX IF EXISTS "ProductImageAltTranslation_imageId_locale_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ProductImageAltTranslation_imageId_locale_marketId_key"
  ON "ProductImageAltTranslation"("imageId", "locale", "marketId");

-- ============================================================
-- DirectTranslation (Phase 2)
-- ============================================================
ALTER TABLE "DirectTranslation"
  ADD COLUMN IF NOT EXISTS "marketId" TEXT NOT NULL DEFAULT '';

ALTER TABLE "DirectTranslation"
  DROP CONSTRAINT IF EXISTS "DirectTranslation_itemId_locale_key";
DROP INDEX IF EXISTS "DirectTranslation_itemId_locale_key";

CREATE UNIQUE INDEX IF NOT EXISTS "DirectTranslation_itemId_locale_marketId_key"
  ON "DirectTranslation"("itemId", "locale", "marketId");
