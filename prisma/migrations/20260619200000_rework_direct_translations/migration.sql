-- Rework the (not-yet-in-production) dynamic storefront translation feature into
-- the "Direktübersetzungen" content type: an item (identity) + its translations
-- by FK, plus candidates with a status. `enabled` and `scope` are dropped (the
-- theme app embed is the on/off switch; direct translations are always global).
-- Idempotent + destructive-safe: the old tables hold no production data.

DROP TABLE IF EXISTS "DynamicTranslationCandidate";
DROP TABLE IF EXISTS "DynamicTranslation";
DROP TABLE IF EXISTS "DynamicTranslationSettings";

CREATE TABLE IF NOT EXISTS "DirectTranslationItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DirectTranslationItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DirectTranslationItem_shop_sourceHash_key" ON "DirectTranslationItem"("shop", "sourceHash");
CREATE INDEX IF NOT EXISTS "DirectTranslationItem_shop_idx" ON "DirectTranslationItem"("shop");

CREATE TABLE IF NOT EXISTS "DirectTranslation" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "targetText" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DirectTranslation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DirectTranslation_itemId_locale_key" ON "DirectTranslation"("itemId", "locale");

ALTER TABLE "DirectTranslation"
    ADD CONSTRAINT "DirectTranslation_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "DirectTranslationItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "DirectTranslationCandidate" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'new',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DirectTranslationCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DirectTranslationCandidate_shop_sourceHash_key" ON "DirectTranslationCandidate"("shop", "sourceHash");
CREATE INDEX IF NOT EXISTS "DirectTranslationCandidate_shop_status_idx" ON "DirectTranslationCandidate"("shop", "status");

CREATE TABLE IF NOT EXISTS "DirectTranslationSettings" (
    "shop" TEXT NOT NULL,
    "collect" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DirectTranslationSettings_pkey" PRIMARY KEY ("shop")
);
