-- Phase 1 (Storefront crawler / site audit, PLAN_SEO_SUITE_COMPLETION.md
-- §2/§3): SeoCrawlSnapshot (one row per "Jetzt scannen" run) + its two
-- children SeoCrawlPage / SeoCrawlBrokenLink. Children cascade on
-- snapshotId but also carry their own `shop` column for the GDPR
-- schema-coverage guard (tests/unit/gdpr.service.test.ts).

-- CreateTable
CREATE TABLE "SeoCrawlSnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "error" TEXT,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "totalDiscovered" INTEGER NOT NULL DEFAULT 0,
    "pagesOk" INTEGER NOT NULL DEFAULT 0,
    "pagesBroken" INTEGER NOT NULL DEFAULT 0,
    "orphanCount" INTEGER NOT NULL DEFAULT 0,
    "headDriftCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SeoCrawlSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoCrawlPage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "redirectedTo" TEXT,
    "responseMs" INTEGER NOT NULL,
    "title" TEXT,
    "metaDesc" TEXT,
    "canonical" TEXT,
    "h1Count" INTEGER NOT NULL DEFAULT 0,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "locale" TEXT NOT NULL DEFAULT '',
    "inboundCount" INTEGER NOT NULL DEFAULT 0,
    "outboundCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SeoCrawlPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoCrawlBrokenLink" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "fromUrl" TEXT NOT NULL,
    "toUrl" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "anchor" TEXT,

    CONSTRAINT "SeoCrawlBrokenLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoCrawlSnapshot_shop_startedAt_idx" ON "SeoCrawlSnapshot"("shop", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SeoCrawlPage_snapshotId_url_key" ON "SeoCrawlPage"("snapshotId", "url");

-- CreateIndex
CREATE INDEX "SeoCrawlPage_shop_snapshotId_idx" ON "SeoCrawlPage"("shop", "snapshotId");

-- CreateIndex
CREATE INDEX "SeoCrawlPage_shop_snapshotId_statusCode_idx" ON "SeoCrawlPage"("shop", "snapshotId", "statusCode");

-- CreateIndex
CREATE INDEX "SeoCrawlBrokenLink_shop_snapshotId_idx" ON "SeoCrawlBrokenLink"("shop", "snapshotId");

-- AddForeignKey
ALTER TABLE "SeoCrawlPage" ADD CONSTRAINT "SeoCrawlPage_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "SeoCrawlSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoCrawlBrokenLink" ADD CONSTRAINT "SeoCrawlBrokenLink_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "SeoCrawlSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
