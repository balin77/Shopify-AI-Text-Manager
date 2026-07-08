-- Adds a top-level "domain" rubric to the shared ThemeContent / ThemeTranslation
-- tables so the Theme, System, Online-Store-Extras and Selling-Plans rubrics can
-- coexist in the same tables while each route/sync path scopes to its own domain.
-- Existing rows back-fill to "theme" (the historical single use of these tables).

ALTER TABLE "ThemeContent"
  ADD COLUMN IF NOT EXISTS "domain" TEXT NOT NULL DEFAULT 'theme';

ALTER TABLE "ThemeTranslation"
  ADD COLUMN IF NOT EXISTS "domain" TEXT NOT NULL DEFAULT 'theme';

CREATE INDEX IF NOT EXISTS "ThemeContent_shop_domain_idx"
  ON "ThemeContent" ("shop", "domain");

CREATE INDEX IF NOT EXISTS "ThemeTranslation_shop_domain_idx"
  ON "ThemeTranslation" ("shop", "domain");
