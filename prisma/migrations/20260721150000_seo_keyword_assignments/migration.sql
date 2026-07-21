-- Keywords expansion (PLAN_KEYWORDS_EXPANSION.md §2): split the old
-- one-row-per-(item, locale) SeoKeyword into
--   SeoKeyword            (standalone keyword: shop/keyword/locale/priority/intent)
--   SeoKeywordAssignment  (keyword ↔ item link with role + the GSC columns)
-- plus the Phase-3 group tables. SeoKeywordSnapshot is repointed from the old
-- keyword row to the assignment (GSC data is per (query, page), so history
-- belongs to the assignment). Every legacy row becomes keyword + one
-- role='primary' assignment; duplicate (shop, keyword, locale) combinations
-- collapse into one keyword with several assignments.
--
-- Atomicity: Prisma Migrate wraps this whole file in a single transaction on
-- PostgreSQL — a failure anywhere rolls everything back, nothing is left half
-- migrated. gen_random_uuid() requires PostgreSQL 13+ (built-in there).

-- 1. Park the old table under a legacy name. Its indexes are renamed too so
--    the new table can reuse the canonical names (index names are
--    schema-global in Postgres).
ALTER TABLE "SeoKeyword" RENAME TO "SeoKeywordLegacy";
ALTER INDEX "SeoKeyword_pkey" RENAME TO "SeoKeywordLegacy_pkey";
ALTER INDEX "SeoKeyword_shop_resourceId_locale_key" RENAME TO "SeoKeywordLegacy_shop_resourceId_locale_key";
ALTER INDEX "SeoKeyword_shop_keyword_idx" RENAME TO "SeoKeywordLegacy_shop_keyword_idx";
ALTER INDEX "SeoKeyword_shop_idx" RENAME TO "SeoKeywordLegacy_shop_idx";

-- 2. New tables

-- CreateTable
CREATE TABLE "SeoKeyword" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT '',
    "priority" INTEGER NOT NULL DEFAULT 2,
    "intent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SeoKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoKeywordAssignment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "gscPosition" DOUBLE PRECISION,
    "gscClicks" INTEGER,
    "gscImpressions" INTEGER,
    "gscCtr" DOUBLE PRECISION,
    "gscUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeoKeywordAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoKeywordGroup" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SeoKeywordGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoKeywordGroupMembership" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeoKeywordGroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoKeyword_shop_keyword_locale_key" ON "SeoKeyword"("shop", "keyword", "locale");
CREATE INDEX "SeoKeyword_shop_priority_idx" ON "SeoKeyword"("shop", "priority");
CREATE INDEX "SeoKeyword_shop_keyword_idx" ON "SeoKeyword"("shop", "keyword");

-- CreateIndex
CREATE UNIQUE INDEX "SeoKeywordAssignment_shop_keywordId_resourceId_key" ON "SeoKeywordAssignment"("shop", "keywordId", "resourceId");
CREATE INDEX "SeoKeywordAssignment_shop_resourceType_resourceId_idx" ON "SeoKeywordAssignment"("shop", "resourceType", "resourceId");
CREATE INDEX "SeoKeywordAssignment_shop_resourceId_idx" ON "SeoKeywordAssignment"("shop", "resourceId");
CREATE INDEX "SeoKeywordAssignment_shop_keywordId_idx" ON "SeoKeywordAssignment"("shop", "keywordId");

-- CreateIndex
CREATE UNIQUE INDEX "SeoKeywordGroup_shop_name_key" ON "SeoKeywordGroup"("shop", "name");
CREATE INDEX "SeoKeywordGroup_shop_idx" ON "SeoKeywordGroup"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "SeoKeywordGroupMembership_groupId_keywordId_key" ON "SeoKeywordGroupMembership"("groupId", "keywordId");
CREATE INDEX "SeoKeywordGroupMembership_shop_idx" ON "SeoKeywordGroupMembership"("shop");

-- AddForeignKey
ALTER TABLE "SeoKeywordAssignment" ADD CONSTRAINT "SeoKeywordAssignment_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "SeoKeyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeoKeywordGroupMembership" ADD CONSTRAINT "SeoKeywordGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SeoKeywordGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeoKeywordGroupMembership" ADD CONSTRAINT "SeoKeywordGroupMembership_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "SeoKeyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Backfill keywords: collapse duplicate (shop, keyword, locale) rows into
--    one keyword (earliest createdAt, latest updatedAt survive).
INSERT INTO "SeoKeyword" ("id", "shop", "keyword", "locale", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, l."shop", l."keyword", l."locale", MIN(l."createdAt"), MAX(l."updatedAt")
FROM "SeoKeywordLegacy" l
GROUP BY l."shop", l."keyword", l."locale";

-- 4. Backfill assignments — the assignment REUSES the legacy row's id, so the
--    SeoKeywordSnapshot FK values stay valid across the column rename in
--    step 5 (a legacy row ≈ one primary assignment, 1:1). GSC columns move
--    along unchanged.
INSERT INTO "SeoKeywordAssignment"
    ("id", "shop", "keywordId", "resourceType", "resourceId", "role",
     "gscPosition", "gscClicks", "gscImpressions", "gscCtr", "gscUpdatedAt", "createdAt")
SELECT l."id", l."shop", k."id", l."resourceType", l."resourceId", 'primary',
       l."gscPosition", l."gscClicks", l."gscImpressions", l."gscCtr", l."gscUpdatedAt", l."createdAt"
FROM "SeoKeywordLegacy" l
JOIN "SeoKeyword" k
  ON k."shop" = l."shop" AND k."keyword" = l."keyword" AND k."locale" = l."locale";

-- 5. Repoint snapshots: keywordId → assignmentId (values already correct,
--    see step 4).
ALTER TABLE "SeoKeywordSnapshot" DROP CONSTRAINT "SeoKeywordSnapshot_keywordId_fkey";
ALTER TABLE "SeoKeywordSnapshot" RENAME COLUMN "keywordId" TO "assignmentId";
ALTER INDEX "SeoKeywordSnapshot_keywordId_capturedAt_key" RENAME TO "SeoKeywordSnapshot_assignmentId_capturedAt_key";
ALTER TABLE "SeoKeywordSnapshot" ADD CONSTRAINT "SeoKeywordSnapshot_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "SeoKeywordAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Drop the parked legacy table.
DROP TABLE "SeoKeywordLegacy";
