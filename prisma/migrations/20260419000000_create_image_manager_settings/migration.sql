-- Backfill migration: the ImageManagerSettings table was historically created
-- via `prisma db push` and never had a CREATE TABLE migration, so a fresh
-- `prisma migrate deploy` failed at 20260420000000 (ALTER TABLE
-- "ImageManagerSettings" ADD COLUMN "enabled"). Idempotent (IF NOT EXISTS) so
-- it is a safe no-op on existing databases where the table already exists.
-- The "enabled" column is intentionally omitted here — it is added by the
-- later 20260420000000_add_image_manager_enabled migration.

CREATE TABLE IF NOT EXISTS "ImageManagerSettings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "firstImageBig" BOOLEAN NOT NULL DEFAULT false,
    "showAltTags" BOOLEAN NOT NULL DEFAULT false,
    "autoAltText" BOOLEAN NOT NULL DEFAULT false,
    "thumbSize" INTEGER NOT NULL DEFAULT 80,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageManagerSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ImageManagerSettings_shopId_key" ON "ImageManagerSettings"("shopId");
