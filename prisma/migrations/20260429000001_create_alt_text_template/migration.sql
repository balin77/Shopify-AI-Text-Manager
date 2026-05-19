-- Backfill migration: the AltTextTemplate table was historically created via
-- `prisma db push` and had no migration at all, so it was never created by a
-- fresh `prisma migrate deploy`. Idempotent (IF NOT EXISTS) so it is a safe
-- no-op on existing databases where the table already exists.

CREATE TABLE IF NOT EXISTS "AltTextTemplate" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "positionLabel" TEXT,
    "locale" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AltTextTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AltTextTemplate_shop_productId_position_locale_key" ON "AltTextTemplate"("shop", "productId", "position", "locale");
CREATE INDEX IF NOT EXISTS "AltTextTemplate_shop_productId_idx" ON "AltTextTemplate"("shop", "productId");
