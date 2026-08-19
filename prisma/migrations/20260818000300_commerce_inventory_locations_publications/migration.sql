-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "commerceSyncedAt" TIMESTAMP(3),
ADD COLUMN     "cost" DECIMAL(12,2),
ADD COLUMN     "countryCodeOfOrigin" TEXT,
ADD COLUMN     "harmonizedSystemCode" TEXT,
ADD COLUMN     "inventoryItemId" TEXT,
ADD COLUMN     "inventoryPolicy" TEXT,
ADD COLUMN     "inventoryTracked" BOOLEAN,
ADD COLUMN     "requiresShipping" BOOLEAN,
ADD COLUMN     "taxable" BOOLEAN,
ADD COLUMN     "weight" DECIMAL(12,3),
ADD COLUMN     "weightUnit" TEXT;

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLevel" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "onHand" INTEGER,
    "available" INTEGER,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPublication" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "publicationName" TEXT NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishDate" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPublication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Location_shop_idx" ON "Location"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Location_shop_id_key" ON "Location"("shop", "id");

-- CreateIndex
CREATE INDEX "InventoryLevel_shop_idx" ON "InventoryLevel"("shop");

-- CreateIndex
CREATE INDEX "InventoryLevel_inventoryItemId_idx" ON "InventoryLevel"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLevel_variantId_locationId_key" ON "InventoryLevel"("variantId", "locationId");

-- CreateIndex
CREATE INDEX "ProductPublication_shop_idx" ON "ProductPublication"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPublication_productId_publicationId_key" ON "ProductPublication"("productId", "publicationId");

-- AddForeignKey
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPublication" ADD CONSTRAINT "ProductPublication_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
