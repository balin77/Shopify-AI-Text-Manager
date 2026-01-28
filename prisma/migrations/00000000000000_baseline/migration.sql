-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AISettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "huggingfaceApiKey" TEXT,
    "geminiApiKey" TEXT,
    "claudeApiKey" TEXT,
    "openaiApiKey" TEXT,
    "grokApiKey" TEXT,
    "deepseekApiKey" TEXT,
    "preferredProvider" TEXT NOT NULL DEFAULT 'huggingface',
    "appLanguage" TEXT NOT NULL DEFAULT 'de',
    "subscriptionPlan" TEXT NOT NULL DEFAULT 'basic',
    "hfMaxTokensPerMinute" INTEGER DEFAULT 1000000,
    "hfMaxRequestsPerMinute" INTEGER DEFAULT 100,
    "geminiMaxTokensPerMinute" INTEGER DEFAULT 1000000,
    "geminiMaxRequestsPerMinute" INTEGER DEFAULT 15,
    "claudeMaxTokensPerMinute" INTEGER DEFAULT 40000,
    "claudeMaxRequestsPerMinute" INTEGER DEFAULT 5,
    "openaiMaxTokensPerMinute" INTEGER DEFAULT 200000,
    "openaiMaxRequestsPerMinute" INTEGER DEFAULT 500,
    "grokMaxTokensPerMinute" INTEGER DEFAULT 100000,
    "grokMaxRequestsPerMinute" INTEGER DEFAULT 60,
    "deepseekMaxTokensPerMinute" INTEGER DEFAULT 100000,
    "deepseekMaxRequestsPerMinute" INTEGER DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AISettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIInstructions" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "formatPreserveInstructions" TEXT,
    "translateInstructions" TEXT,
    "productTitleFormat" TEXT,
    "productTitleInstructions" TEXT,
    "productDescriptionFormat" TEXT,
    "productDescriptionInstructions" TEXT,
    "productHandleFormat" TEXT,
    "productHandleInstructions" TEXT,
    "productSeoTitleFormat" TEXT,
    "productSeoTitleInstructions" TEXT,
    "productMetaDescFormat" TEXT,
    "productMetaDescInstructions" TEXT,
    "productAltTextFormat" TEXT,
    "productAltTextInstructions" TEXT,
    "collectionTitleFormat" TEXT,
    "collectionTitleInstructions" TEXT,
    "collectionDescriptionFormat" TEXT,
    "collectionDescriptionInstructions" TEXT,
    "collectionHandleFormat" TEXT,
    "collectionHandleInstructions" TEXT,
    "collectionSeoTitleFormat" TEXT,
    "collectionSeoTitleInstructions" TEXT,
    "collectionMetaDescFormat" TEXT,
    "collectionMetaDescInstructions" TEXT,
    "blogTitleFormat" TEXT,
    "blogTitleInstructions" TEXT,
    "blogDescriptionFormat" TEXT,
    "blogDescriptionInstructions" TEXT,
    "blogHandleFormat" TEXT,
    "blogHandleInstructions" TEXT,
    "blogSeoTitleFormat" TEXT,
    "blogSeoTitleInstructions" TEXT,
    "blogMetaDescFormat" TEXT,
    "blogMetaDescInstructions" TEXT,
    "pageTitleFormat" TEXT,
    "pageTitleInstructions" TEXT,
    "pageDescriptionFormat" TEXT,
    "pageDescriptionInstructions" TEXT,
    "pageHandleFormat" TEXT,
    "pageHandleInstructions" TEXT,
    "pageSeoTitleFormat" TEXT,
    "pageSeoTitleInstructions" TEXT,
    "pageMetaDescFormat" TEXT,
    "pageMetaDescInstructions" TEXT,
    "policyDescriptionFormat" TEXT,
    "policyDescriptionInstructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIInstructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resourceType" TEXT,
    "resourceId" TEXT,
    "resourceTitle" TEXT,
    "fieldType" TEXT,
    "targetLocale" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "prompt" TEXT,
    "result" TEXT,
    "error" TEXT,
    "queuePosition" INTEGER,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "estimatedTokens" INTEGER,
    "provider" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "descriptionHtml" TEXT,
    "handle" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "productType" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "featuredImageUrl" TEXT,
    "featuredImageAlt" TEXT,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "altText" TEXT,
    "mediaId" TEXT,
    "position" INTEGER,
    "altTextModifiedAt" TIMESTAMP(3),

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "WebhookRetry" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextRetry" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookRetry_pkey" PRIMARY KEY ("id")
);

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
CREATE TABLE "ShopPolicy" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "type" TEXT NOT NULL,
    "url" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Menu" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Menu_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "ThemeContent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceTypeLabel" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "groupIcon" TEXT NOT NULL,
    "translatableContent" JSONB NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThemeContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThemeTranslation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "outdated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThemeTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AISettings_shop_key" ON "AISettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "AIInstructions_shop_key" ON "AIInstructions"("shop");

-- CreateIndex
CREATE INDEX "Task_shop_status_idx" ON "Task"("shop", "status");

-- CreateIndex
CREATE INDEX "Task_shop_createdAt_idx" ON "Task"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "Task_shop_queuePosition_idx" ON "Task"("shop", "queuePosition");

-- CreateIndex
CREATE INDEX "Task_expiresAt_idx" ON "Task"("expiresAt");

-- CreateIndex
CREATE INDEX "Product_shop_idx" ON "Product"("shop");

-- CreateIndex
CREATE INDEX "Product_shop_status_idx" ON "Product"("shop", "status");

-- CreateIndex
CREATE INDEX "Product_lastSyncedAt_idx" ON "Product"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shop_id_key" ON "Product"("shop", "id");

-- CreateIndex
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");

-- CreateIndex
CREATE INDEX "ProductImageAltTranslation_imageId_idx" ON "ProductImageAltTranslation"("imageId");

-- CreateIndex
CREATE INDEX "ProductImageAltTranslation_locale_idx" ON "ProductImageAltTranslation"("locale");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImageAltTranslation_imageId_locale_key" ON "ProductImageAltTranslation"("imageId", "locale");

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

-- CreateIndex
CREATE INDEX "WebhookRetry_shop_idx" ON "WebhookRetry"("shop");

-- CreateIndex
CREATE INDEX "WebhookRetry_nextRetry_idx" ON "WebhookRetry"("nextRetry");

-- CreateIndex
CREATE INDEX "WebhookRetry_attempt_idx" ON "WebhookRetry"("attempt");

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
CREATE INDEX "ShopPolicy_shop_idx" ON "ShopPolicy"("shop");

-- CreateIndex
CREATE INDEX "ShopPolicy_shop_type_idx" ON "ShopPolicy"("shop", "type");

-- CreateIndex
CREATE INDEX "ShopPolicy_lastSyncedAt_idx" ON "ShopPolicy"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopPolicy_shop_id_key" ON "ShopPolicy"("shop", "id");

-- CreateIndex
CREATE INDEX "Menu_shop_idx" ON "Menu"("shop");

-- CreateIndex
CREATE INDEX "Menu_lastSyncedAt_idx" ON "Menu"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Menu_shop_id_key" ON "Menu"("shop", "id");

-- CreateIndex
CREATE INDEX "ContentTranslation_resourceId_locale_idx" ON "ContentTranslation"("resourceId", "locale");

-- CreateIndex
CREATE INDEX "ContentTranslation_resourceType_idx" ON "ContentTranslation"("resourceType");

-- CreateIndex
CREATE INDEX "ContentTranslation_locale_idx" ON "ContentTranslation"("locale");

-- CreateIndex
CREATE UNIQUE INDEX "ContentTranslation_resourceId_key_locale_key" ON "ContentTranslation"("resourceId", "key", "locale");

-- CreateIndex
CREATE INDEX "ThemeContent_shop_idx" ON "ThemeContent"("shop");

-- CreateIndex
CREATE INDEX "ThemeContent_shop_groupId_idx" ON "ThemeContent"("shop", "groupId");

-- CreateIndex
CREATE INDEX "ThemeContent_lastSyncedAt_idx" ON "ThemeContent"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ThemeContent_shop_resourceId_groupId_key" ON "ThemeContent"("shop", "resourceId", "groupId");

-- CreateIndex
CREATE INDEX "ThemeTranslation_shop_resourceId_groupId_idx" ON "ThemeTranslation"("shop", "resourceId", "groupId");

-- CreateIndex
CREATE INDEX "ThemeTranslation_shop_groupId_locale_idx" ON "ThemeTranslation"("shop", "groupId", "locale");

-- CreateIndex
CREATE INDEX "ThemeTranslation_locale_idx" ON "ThemeTranslation"("locale");

-- CreateIndex
CREATE UNIQUE INDEX "ThemeTranslation_shop_resourceId_groupId_key_locale_key" ON "ThemeTranslation"("shop", "resourceId", "groupId", "key", "locale");

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImageAltTranslation" ADD CONSTRAINT "ProductImageAltTranslation_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "ProductImage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMetafield" ADD CONSTRAINT "ProductMetafield_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

