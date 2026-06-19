-- Dynamic storefront translation (Phase 2): merchant-managed source→target
-- string pairs applied client-side, plus per-shop settings + cache version.
-- Idempotent so it is safe on every environment.

CREATE TABLE IF NOT EXISTS "DynamicTranslation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "targetText" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "source" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DynamicTranslation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DynamicTranslation_shop_locale_scope_sourceHash_key" ON "DynamicTranslation"("shop", "locale", "scope", "sourceHash");
CREATE INDEX IF NOT EXISTS "DynamicTranslation_shop_locale_idx" ON "DynamicTranslation"("shop", "locale");

CREATE TABLE IF NOT EXISTS "DynamicTranslationSettings" (
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DynamicTranslationSettings_pkey" PRIMARY KEY ("shop")
);
