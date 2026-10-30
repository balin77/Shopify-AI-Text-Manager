-- Durable, encrypted bookkeeping of the non-expiring -> expiring offline token
-- migration (see the model comment in schema.prisma). One row per shop.
CREATE TABLE "OfflineTokenMigration" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "encryptedOldToken" TEXT,
    "tokenFingerprint" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfflineTokenMigration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OfflineTokenMigration_shop_key" ON "OfflineTokenMigration"("shop");
