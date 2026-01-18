-- CreateTable: WebhookRetry
-- Purpose: Store failed webhooks for automatic retry with exponential backoff
-- Date: 2026-01-16

CREATE TABLE IF NOT EXISTS "WebhookRetry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextRetry" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WebhookRetry_shop_idx" ON "WebhookRetry"("shop");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WebhookRetry_nextRetry_idx" ON "WebhookRetry"("nextRetry");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WebhookRetry_attempt_idx" ON "WebhookRetry"("attempt");
