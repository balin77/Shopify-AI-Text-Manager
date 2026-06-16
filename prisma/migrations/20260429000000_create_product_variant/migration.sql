-- Backfill migration: the ProductVariant table was historically created via
-- `prisma db push` and never had a CREATE TABLE migration, so a fresh
-- `prisma migrate deploy` failed at 20260430000000 (ALTER TABLE
-- "ProductVariant" ADD COLUMN "imageKey"). Idempotent (IF NOT EXISTS) so it is
-- a safe no-op on existing databases where the table already exists.
-- The "imageKey" column is intentionally omitted here — it is added by the
-- later 20260430000000_add_image_key_to_variant migration.

CREATE TABLE IF NOT EXISTS "ProductVariant" (
    "id" TEXT NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "position" INTEGER NOT NULL,
    "galleryJson" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductVariant_shopifyGid_key" ON "ProductVariant"("shopifyGid");
CREATE INDEX IF NOT EXISTS "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS; guard so this is a no-op on
-- databases where the FK already exists (production via earlier db push).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ProductVariant_productId_fkey'
    ) THEN
        ALTER TABLE "ProductVariant"
            ADD CONSTRAINT "ProductVariant_productId_fkey"
            FOREIGN KEY ("productId") REFERENCES "Product"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
