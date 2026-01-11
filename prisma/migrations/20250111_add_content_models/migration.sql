-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "descriptionHtml" TEXT,
    "handle" TEXT NOT NULL,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "blogId" TEXT NOT NULL,
    "blogTitle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "handle" TEXT NOT NULL,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Page" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "handle" TEXT NOT NULL,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentTranslation" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "digest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Collection_shop_idx" ON "Collection"("shop");

-- CreateIndex
CREATE INDEX "Collection_lastSyncedAt_idx" ON "Collection"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_shop_id_key" ON "Collection"("shop", "id");

-- CreateIndex
CREATE INDEX "Article_shop_idx" ON "Article"("shop");

-- CreateIndex
CREATE INDEX "Article_shop_blogId_idx" ON "Article"("shop", "blogId");

-- CreateIndex
CREATE INDEX "Article_lastSyncedAt_idx" ON "Article"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Article_shop_id_key" ON "Article"("shop", "id");

-- CreateIndex
CREATE INDEX "Page_shop_idx" ON "Page"("shop");

-- CreateIndex
CREATE INDEX "Page_lastSyncedAt_idx" ON "Page"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Page_shop_id_key" ON "Page"("shop", "id");

-- CreateIndex
CREATE INDEX "ContentTranslation_resourceId_locale_idx" ON "ContentTranslation"("resourceId", "locale");

-- CreateIndex
CREATE INDEX "ContentTranslation_resourceType_idx" ON "ContentTranslation"("resourceType");

-- CreateIndex
CREATE INDEX "ContentTranslation_locale_idx" ON "ContentTranslation"("locale");

-- CreateIndex
CREATE UNIQUE INDEX "ContentTranslation_resourceId_key_locale_key" ON "ContentTranslation"("resourceId", "key", "locale");

-- AddForeignKey
ALTER TABLE "ContentTranslation" ADD CONSTRAINT "ContentTranslation_collection_fkey" FOREIGN KEY ("resourceId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentTranslation" ADD CONSTRAINT "ContentTranslation_article_fkey" FOREIGN KEY ("resourceId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentTranslation" ADD CONSTRAINT "ContentTranslation_page_fkey" FOREIGN KEY ("resourceId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
