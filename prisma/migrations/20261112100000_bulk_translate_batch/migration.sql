-- Additive: state of one Batch-API run of "add missing translations"
-- (PLAN_BULK_TRANSLATE_BATCHING 19.4). New table, nothing reads it before this
-- release: no deploy ordering requirement, no backfill. Task statuses are free
-- strings, so the new Task states need no schema change.
CREATE TABLE IF NOT EXISTS "BulkTranslateBatch" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'submitting',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'default',
    "period" TEXT NOT NULL DEFAULT '',
    "pool" TEXT NOT NULL DEFAULT '',
    "poolPeriod" TEXT NOT NULL DEFAULT '',
    "batchIds" JSONB NOT NULL DEFAULT '[]',
    "fileIds" JSONB NOT NULL DEFAULT '[]',
    "idPrefix" TEXT NOT NULL DEFAULT '',
    "intentAt" TIMESTAMP(3),
    "reservedMicros" INTEGER NOT NULL DEFAULT 0,
    "reservedPoolMicros" INTEGER NOT NULL DEFAULT 0,
    "reservationState" TEXT NOT NULL DEFAULT 'none',
    "manifest" TEXT NOT NULL DEFAULT '',
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "failedTicks" INTEGER NOT NULL DEFAULT 0,
    "cancelRequestedAt" TIMESTAMP(3),
    "consentWithdrawnAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkTranslateBatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BulkTranslateBatch_taskId_key" ON "BulkTranslateBatch"("taskId");
CREATE INDEX IF NOT EXISTS "BulkTranslateBatch_state_idx" ON "BulkTranslateBatch"("state");
CREATE INDEX IF NOT EXISTS "BulkTranslateBatch_shop_idx" ON "BulkTranslateBatch"("shop");
