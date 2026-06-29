-- SEO tab Phase 8: IndexNow config + debounced submit queue.
-- Both shop-scoped; purged in redactShopData. The IndexNow key is a public
-- token by design (served at keyLocation), stored plaintext — not a secret.

-- CreateTable
CREATE TABLE "SeoIndexNowConfig" (
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "keyLocation" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSubmittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SeoIndexNowConfig_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "SeoIndexNowQueue" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeoIndexNowQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoIndexNowQueue_shop_urlHash_key" ON "SeoIndexNowQueue"("shop", "urlHash");

-- CreateIndex
CREATE INDEX "SeoIndexNowQueue_shop_idx" ON "SeoIndexNowQueue"("shop");
