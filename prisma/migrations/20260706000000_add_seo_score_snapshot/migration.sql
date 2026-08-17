-- SEO Audit Dashboard: point-in-time snapshots of analyzeStore()'s result, so
-- the dashboard reads a cached history instead of re-scanning the full
-- content cache on every visit. Shop-scoped; purged in redactShopData.

-- CreateTable
CREATE TABLE "SeoScoreSnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "averageScore" INTEGER NOT NULL,
    "totalScanned" INTEGER NOT NULL,
    "totalAvailable" INTEGER NOT NULL,
    "capped" BOOLEAN NOT NULL,
    "payload" TEXT NOT NULL,
    CONSTRAINT "SeoScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoScoreSnapshot_shop_createdAt_idx" ON "SeoScoreSnapshot"("shop", "createdAt");
