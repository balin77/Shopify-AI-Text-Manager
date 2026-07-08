-- SEO tab Phase 5: per-item target keyword (+ GSC enrichment columns for Phase 6).
-- Shop-scoped; purged in redactShopData.

-- CreateTable
CREATE TABLE "SeoKeyword" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT '',
    "gscPosition" DOUBLE PRECISION,
    "gscClicks" INTEGER,
    "gscImpressions" INTEGER,
    "gscCtr" DOUBLE PRECISION,
    "gscUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SeoKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoKeyword_shop_resourceId_locale_key" ON "SeoKeyword"("shop", "resourceId", "locale");

-- CreateIndex
CREATE INDEX "SeoKeyword_shop_keyword_idx" ON "SeoKeyword"("shop", "keyword");

-- CreateIndex
CREATE INDEX "SeoKeyword_shop_idx" ON "SeoKeyword"("shop");
