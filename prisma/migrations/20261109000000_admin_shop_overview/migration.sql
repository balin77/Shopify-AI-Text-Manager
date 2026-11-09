-- PLAN_ADMIN_SHOP_OVERVIEW steps 5-6: connection state + durable activity +
-- per-day usage statistics. ONE migration for both parts of the plan.
--
-- Additive and safe on a live database:
--   * every new column is nullable or has a constant default, which PostgreSQL
--     (11+) adds as a metadata-only change -- no table rewrite, only a brief
--     ACCESS EXCLUSIVE lock;
--   * no column is dropped or retyped, no existing data changes except the
--     one-off backfill below;
--   * the new indexes sit on small tables (Session, WebhookLog -- processed
--     rows are deleted after 24 h) or on the new empty table, so the plain
--     CREATE INDEX does not hold writers for long;
--   * every statement is IF NOT EXISTS / guarded, so a re-run is a no-op.
-- Nothing here is read by running code yet; an older container ignores it.

-- AlterTable
ALTER TABLE "ShopInstallState"
    ADD COLUMN IF NOT EXISTS "connectionState" TEXT,
    ADD COLUMN IF NOT EXISTS "connectionStateSince" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "connectionStateReason" TEXT,
    ADD COLUMN IF NOT EXISTS "connectionClearedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "connectionClearedCause" TEXT,
    ADD COLUMN IF NOT EXISTS "resyncRequiredSince" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "droppedWebhookCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "lastWebhookAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "lastProbeAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "uninstallSource" TEXT,
    ADD COLUMN IF NOT EXISTS "reinstallEvidenceAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "lastApiOkAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "lastActivityApprox" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "lastActionAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "lastActionArea" TEXT,
    ADD COLUMN IF NOT EXISTS "lastAuthAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OfflineTokenMigration"
    ADD COLUMN IF NOT EXISTS "failureKind" TEXT,
    ADD COLUMN IF NOT EXISTS "failureKindSince" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ShopUsageDay" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "activeSlots" INTEGER NOT NULL DEFAULT 0,
    "actions" INTEGER NOT NULL DEFAULT 0,
    "tasksStarted" INTEGER NOT NULL DEFAULT 0,
    "tasksFailed" INTEGER NOT NULL DEFAULT 0,
    "aiCostMicros" BIGINT NOT NULL DEFAULT 0,
    "aiTokens" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopUsageDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ShopUsageDay_shop_day_key" ON "ShopUsageDay"("shop", "day");
CREATE INDEX IF NOT EXISTS "ShopUsageDay_day_idx" ON "ShopUsageDay"("day");
CREATE INDEX IF NOT EXISTS "Session_shop_idx" ON "Session"("shop");
CREATE INDEX IF NOT EXISTS "WebhookLog_shop_createdAt_idx" ON "WebhookLog"("shop", "createdAt");

-- One-off, idempotent backfill of the durable "last opened" from the newest
-- Session.lastActivityAt of the shop. APPROXIMATE, and flagged as such in
-- "lastActivityApprox": that column counted open-tab polling as activity, and
-- its @default(now()) stamped every newly created session row. The live writer
-- (a later step) overwrites the value and clears the flag. Only rows that have
-- no value yet are touched, so a re-run -- or a value the live writer already
-- set -- is never overwritten. Shops without an install-state row get none
-- (inserting one would invent install state).
UPDATE "ShopInstallState" AS s
SET "lastActivityAt" = src."latest",
    "lastActivityApprox" = true
FROM (
    SELECT "shop", MAX("lastActivityAt") AS "latest"
    FROM "Session"
    WHERE "lastActivityAt" IS NOT NULL
    GROUP BY "shop"
) AS src
WHERE s."shop" = src."shop"
  AND s."lastActivityAt" IS NULL;
