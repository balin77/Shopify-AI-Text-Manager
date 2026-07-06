-- Theme-Auswahl (Theme Selection): each ThemeContent / ThemeTranslation row now
-- carries the Shopify Theme-GID it belongs to, so the app can edit/translate the
-- content of a merchant-chosen theme instead of implicitly always the MAIN theme.
--
-- Column semantics: "" = Legacy/not-yet-theme-assigned (backfill candidate). The
-- structural change here is verlustfrei — every existing row keeps "" until the
-- backfill (scripts/backfill-theme-id.js) assigns it the extracted theme_id or,
-- as a fallback, the current MAIN theme. The read code treats "" as "belongs to
-- the active theme" (compat OR) until the backfill has run.
--
-- Ordering matters (see PLAN_THEME_SELECTION §9.8): add the column with a ""
-- default FIRST, then swap the unique index. Because every row is "" at this
-- point, the pre-existing (shop, resourceId, groupId[, key, locale]) tuples stay
-- unique even with themeId folded into the key — no collision on the swap.
--
-- Prisma manages @@unique as UNIQUE INDEXes (see baseline migration), so this
-- swaps indexes, not table constraints. Idempotent: IF (NOT) EXISTS throughout,
-- safe to re-run and safe on databases that already have the new shape.

-- 1. Add themeId columns (additive, non-breaking).
ALTER TABLE "ThemeContent"
  ADD COLUMN IF NOT EXISTS "themeId" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ThemeTranslation"
  ADD COLUMN IF NOT EXISTS "themeId" TEXT NOT NULL DEFAULT '';

-- 2. Swap ThemeContent unique index: drop the old (shop, resourceId, groupId)
--    index, add the themeId-bearing one.
DROP INDEX IF EXISTS "ThemeContent_shop_resourceId_groupId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ThemeContent_shop_resourceId_groupId_themeId_key"
  ON "ThemeContent" ("shop", "resourceId", "groupId", "themeId");

-- 3. Swap ThemeTranslation unique index likewise.
DROP INDEX IF EXISTS "ThemeTranslation_shop_resourceId_groupId_key_locale_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ThemeTranslation_shop_resourceId_groupId_key_locale_themeId_key"
  ON "ThemeTranslation" ("shop", "resourceId", "groupId", "key", "locale", "themeId");

-- 4. New supporting indexes for theme-scoped reads.
CREATE INDEX IF NOT EXISTS "ThemeContent_shop_themeId_idx"
  ON "ThemeContent" ("shop", "themeId");

CREATE INDEX IF NOT EXISTS "ThemeTranslation_shop_themeId_idx"
  ON "ThemeTranslation" ("shop", "themeId");

-- 5. AISettings: persist the merchant's theme choice (null = MAIN, backwards
--    compatible). Additive, non-breaking.
ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "selectedThemeId" TEXT;
