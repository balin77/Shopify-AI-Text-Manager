CREATE TABLE "ShopInstallState" (
    "shop" TEXT NOT NULL,
    "uninstalledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopInstallState_pkey" PRIMARY KEY ("shop")
);

CREATE INDEX "ShopInstallState_uninstalledAt_idx" ON "ShopInstallState"("uninstalledAt");
