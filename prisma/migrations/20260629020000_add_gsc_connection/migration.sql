-- SEO tab Phase 6: Google Search Console OAuth connection (per shop).
-- refreshToken stored encrypted; shop-scoped; purged in redactShopData.

-- CreateTable
CREATE TABLE "GoogleSearchConsoleConnection" (
    "shop" TEXT NOT NULL,
    "propertyUrl" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GoogleSearchConsoleConnection_pkey" PRIMARY KEY ("shop")
);
