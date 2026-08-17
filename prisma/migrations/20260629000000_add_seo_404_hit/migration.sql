-- SEO tab Phase 3: storefront 404-hit collector (Seo404Hit).
-- Shop-scoped; purged in redactShopData. Mirrors DirectTranslationCandidate.

-- CreateTable
CREATE TABLE "Seo404Hit" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "pathHash" TEXT NOT NULL,
    "referrer" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'new',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Seo404Hit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Seo404Hit_shop_pathHash_key" ON "Seo404Hit"("shop", "pathHash");

-- CreateIndex
CREATE INDEX "Seo404Hit_shop_status_idx" ON "Seo404Hit"("shop", "status");

-- CreateIndex
CREATE INDEX "Seo404Hit_shop_lastSeenAt_idx" ON "Seo404Hit"("shop", "lastSeenAt");

-- CreateIndex
CREATE INDEX "Seo404Hit_shop_count_idx" ON "Seo404Hit"("shop", "count");
