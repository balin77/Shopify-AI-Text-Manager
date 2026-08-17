-- CreateTable
CREATE TABLE "ContentTemplate" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentTemplate_shop_idx" ON "ContentTemplate"("shop");

-- CreateIndex
CREATE INDEX "ContentTemplate_shop_contentType_fieldType_idx" ON "ContentTemplate"("shop", "contentType", "fieldType");

-- Enforce the single-default invariant at the DB level (at most one
-- auto-applied template per shop+contentType+fieldType). Prisma cannot express
-- a partial unique index, so it is raw SQL only; the service keeps the
-- invariant transactionally and this index makes a concurrent double-create a
-- catchable unique violation rather than silent data corruption.
CREATE UNIQUE INDEX "ContentTemplate_default_uniq"
  ON "ContentTemplate"("shop", "contentType", "fieldType")
  WHERE "isDefault" = true;
