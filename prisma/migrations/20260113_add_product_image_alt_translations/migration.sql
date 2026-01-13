-- CreateTable
CREATE TABLE "ProductImageAltTranslation" (
    "id" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "altText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductImageAltTranslation_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN "mediaId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ProductImageAltTranslation_imageId_locale_key" ON "ProductImageAltTranslation"("imageId", "locale");

-- CreateIndex
CREATE INDEX "ProductImageAltTranslation_imageId_idx" ON "ProductImageAltTranslation"("imageId");

-- CreateIndex
CREATE INDEX "ProductImageAltTranslation_locale_idx" ON "ProductImageAltTranslation"("locale");

-- AddForeignKey
ALTER TABLE "ProductImageAltTranslation" ADD CONSTRAINT "ProductImageAltTranslation_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "ProductImage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
