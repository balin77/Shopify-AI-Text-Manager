-- SEO tab Performance section: cached PageSpeed Insights v5 runs.
-- Shop-scoped; purged in redactShopData. `score` denormalizes
-- result.performanceScore for the history list; `result` is the full parsed
-- PageSpeedAuditResult JSON (see app/services/seo/pagespeed.types.ts).

-- CreateTable
CREATE TABLE "SeoPageSpeedAudit" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "score" INTEGER,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeoPageSpeedAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoPageSpeedAudit_shop_url_strategy_createdAt_idx" ON "SeoPageSpeedAudit"("shop", "url", "strategy", "createdAt");

-- CreateIndex
CREATE INDEX "SeoPageSpeedAudit_shop_createdAt_idx" ON "SeoPageSpeedAudit"("shop", "createdAt");
