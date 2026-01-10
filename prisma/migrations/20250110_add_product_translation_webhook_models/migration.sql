-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "descriptionHtml" TEXT,
    "handle" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "featuredImageUrl" TEXT,
    "featuredImageAlt" TEXT,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Translation" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "digest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Translation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "altText" TEXT,
    "position" INTEGER,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductOption" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "values" TEXT NOT NULL,

    CONSTRAINT "ProductOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMetafield" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "ProductMetafield_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "productId" TEXT,
    "payload" TEXT NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_shop_idx" ON "Product"("shop");

-- CreateIndex
CREATE INDEX "Product_shop_status_idx" ON "Product"("shop", "status");

-- CreateIndex
CREATE INDEX "Product_lastSyncedAt_idx" ON "Product"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shop_id_key" ON "Product"("shop", "id");

-- CreateIndex
CREATE INDEX "Translation_productId_locale_idx" ON "Translation"("productId", "locale");

-- CreateIndex
CREATE INDEX "Translation_locale_idx" ON "Translation"("locale");

-- CreateIndex
CREATE UNIQUE INDEX "Translation_productId_key_locale_key" ON "Translation"("productId", "key", "locale");

-- CreateIndex
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");

-- CreateIndex
CREATE INDEX "ProductOption_productId_idx" ON "ProductOption"("productId");

-- CreateIndex
CREATE INDEX "ProductMetafield_productId_idx" ON "ProductMetafield"("productId");

-- CreateIndex
CREATE INDEX "WebhookLog_shop_topic_idx" ON "WebhookLog"("shop", "topic");

-- CreateIndex
CREATE INDEX "WebhookLog_processed_idx" ON "WebhookLog"("processed");

-- CreateIndex
CREATE INDEX "WebhookLog_createdAt_idx" ON "WebhookLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Translation" ADD CONSTRAINT "Translation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMetafield" ADD CONSTRAINT "ProductMetafield_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
