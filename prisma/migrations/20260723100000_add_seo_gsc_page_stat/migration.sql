-- Phase 3 (Content-Freshness audit, PLAN_SEO_SUITE_COMPLETION.md §2/§5.1
-- option b): per-page GSC rollup written daily by the GSC auto-sync
-- (enrichPageStatsFromGsc), read by app/services/seo/freshness.service.ts.
-- Unique (shop, page) overwrites on every sync — no history table.

-- CreateTable
CREATE TABLE "SeoGscPageStat" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "position" DOUBLE PRECISION NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "windowDays" INTEGER NOT NULL DEFAULT 90,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoGscPageStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoGscPageStat_shop_page_key" ON "SeoGscPageStat"("shop", "page");

-- CreateIndex
CREATE INDEX "SeoGscPageStat_shop_resourceType_resourceId_idx" ON "SeoGscPageStat"("shop", "resourceType", "resourceId");

-- Content-Freshness "Ignorieren" list (PLAN_SEO_SUITE_COMPLETION.md §5.3/§5.5):
-- a JSON array of dismissed "<resourceType>:<resourceId>" strings on the
-- existing per-shop settings row — no new model, already purged on
-- shop/redact with the rest of AISettings.
ALTER TABLE "AISettings"
  ADD COLUMN "seoFreshnessDismissed" JSONB;
