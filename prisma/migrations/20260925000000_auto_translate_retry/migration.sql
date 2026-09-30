-- Optional daily limit on first automatic translations, and the retry list.
--
-- The limit is a nullable column on an existing table: NULL means "no limit",
-- which is also what every existing shop gets, and an older container never
-- selects it. The retry list is a new table; nothing reads it before this
-- release. No deploy ordering requirement, no backfill.
ALTER TABLE "AISettings" ADD COLUMN IF NOT EXISTS "autoTranslateDailyLimit" INTEGER;

CREATE TABLE IF NOT EXISTS "AutoTranslateRetry" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "contentKind" TEXT NOT NULL,
    "resourceTitle" TEXT,
    "pairs" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoTranslateRetry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AutoTranslateRetry_shop_resourceId_key"
  ON "AutoTranslateRetry"("shop", "resourceId");
CREATE INDEX IF NOT EXISTS "AutoTranslateRetry_shop_status_idx"
  ON "AutoTranslateRetry"("shop", "status");
