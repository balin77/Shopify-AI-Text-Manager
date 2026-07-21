-- Ranking history for SeoKeyword: one row per (keyword, sync day).
-- Shop-scoped; purged in redactShopData. Cascades on SeoKeyword delete.

-- CreateTable
CREATE TABLE "SeoKeywordSnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "position" DOUBLE PRECISION,
    "clicks" INTEGER,
    "impressions" INTEGER,
    "ctr" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeoKeywordSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoKeywordSnapshot_keywordId_capturedAt_key" ON "SeoKeywordSnapshot"("keywordId", "capturedAt");

-- CreateIndex
CREATE INDEX "SeoKeywordSnapshot_shop_idx" ON "SeoKeywordSnapshot"("shop");

-- AddForeignKey
ALTER TABLE "SeoKeywordSnapshot" ADD CONSTRAINT "SeoKeywordSnapshot_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "SeoKeyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;
