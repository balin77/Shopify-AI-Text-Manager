-- CreateTable
CREATE TABLE "ImageOperationCounter" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImageOperationCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImageOperationCounter_shop_idx" ON "ImageOperationCounter"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ImageOperationCounter_shop_period_key" ON "ImageOperationCounter"("shop", "period");
