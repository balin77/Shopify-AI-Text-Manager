-- Metafields settings tab: per-shop record of product metafield definitions
-- the merchant enabled for translation, plus a last-scan / backfill-guard
-- timestamp on AISettings. Idempotent so it is safe on every environment.

ALTER TABLE "AISettings" ADD COLUMN IF NOT EXISTS "metafieldsLastScanAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "EnabledMetafieldDefinition" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL DEFAULT 'PRODUCT',
    "patchedTranslatable" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnabledMetafieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EnabledMetafieldDefinition_shop_definitionId_key" ON "EnabledMetafieldDefinition"("shop", "definitionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EnabledMetafieldDefinition_shop_ownerType_idx" ON "EnabledMetafieldDefinition"("shop", "ownerType");
