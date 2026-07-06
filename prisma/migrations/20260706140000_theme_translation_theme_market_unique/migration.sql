-- Reconcile ThemeTranslation's unique index after the theme-id and market-id
-- migrations landed independently on separate branches.
--
-- Ordering: both prior migrations share the 20260706130000 timestamp, so Prisma
-- applies them lexicographically:
--   1. ..._add_market_id_to_translations  -> creates a unique on (…, locale, marketId)   [no themeId]
--   2. ..._add_theme_id                    -> creates a unique on (…, locale, themeId)    [no marketId]
-- Each is correct in isolation but neither matches the merged schema, which
-- folds BOTH dimensions into one key. This migration drops the two transient
-- one-sided indexes and creates the combined (…, themeId, marketId) unique so
-- the DB matches schema.prisma (no drift).
--
-- Idempotent (IF (NOT) EXISTS) and non-destructive: it only reshapes indexes,
-- no row data changes.

DROP INDEX IF EXISTS "ThemeTranslation_shop_res_group_key_locale_market_key";
DROP INDEX IF EXISTS "ThemeTranslation_shop_resourceId_groupId_key_locale_themeId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ThemeTranslation_shop_res_grp_key_loc_theme_market_key"
  ON "ThemeTranslation" ("shop", "resourceId", "groupId", "key", "locale", "themeId", "marketId");
