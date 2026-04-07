-- CreateTable
CREATE TABLE "GdprAuditLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "customerId" BIGINT,
    "customerEmail" TEXT,
    "status" TEXT NOT NULL,
    "dataExported" TEXT,
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GdprAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GdprAuditLog_shop_idx" ON "GdprAuditLog"("shop");

-- CreateIndex
CREATE INDEX "GdprAuditLog_shop_requestType_idx" ON "GdprAuditLog"("shop", "requestType");

-- CreateIndex
CREATE INDEX "GdprAuditLog_requestedAt_idx" ON "GdprAuditLog"("requestedAt");
