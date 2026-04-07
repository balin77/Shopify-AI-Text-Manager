-- Add shop column as nullable first (for safe migration with existing data)
ALTER TABLE "ContentTranslation" ADD COLUMN "shop" TEXT;

-- Backfill shop from related resource tables using resourceId
UPDATE "ContentTranslation" ct
SET shop = COALESCE(
  (SELECT p.shop FROM "Product" p WHERE p.id = ct."resourceId"),
  (SELECT c.shop FROM "Collection" c WHERE c.id = ct."resourceId"),
  (SELECT a.shop FROM "Article" a WHERE a.id = ct."resourceId"),
  (SELECT pg.shop FROM "Page" pg WHERE pg.id = ct."resourceId"),
  (SELECT sp.shop FROM "ShopPolicy" sp WHERE sp.id = ct."resourceId"),
  ''
);

-- Make non-nullable after backfill
ALTER TABLE "ContentTranslation" ALTER COLUMN "shop" SET NOT NULL;

-- Drop old unique index (was created as index, not constraint)
DROP INDEX IF EXISTS "ContentTranslation_resourceId_key_locale_key";

-- Add new unique constraint including shop
ALTER TABLE "ContentTranslation" DROP CONSTRAINT IF EXISTS "ContentTranslation_shop_resourceId_key_locale_key";
ALTER TABLE "ContentTranslation" ADD CONSTRAINT "ContentTranslation_shop_resourceId_key_locale_key" UNIQUE ("shop", "resourceId", "key", "locale");

-- Add new index for shop+resourceType lookups
DROP INDEX IF EXISTS "ContentTranslation_shop_resourceType_idx";
CREATE INDEX "ContentTranslation_shop_resourceType_idx" ON "ContentTranslation"("shop", "resourceType");
