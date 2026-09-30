-- Append-only log of AI processing consent grants and withdrawals.
CREATE TABLE "AiConsentEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "version" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiConsentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiConsentEvent_shop_createdAt_idx" ON "AiConsentEvent"("shop", "createdAt");
