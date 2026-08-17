-- Phase 4 (Sitemap / indexation control, PLAN_SEO_SUITE_COMPLETION.md §2/§6):
-- SeoSitemapExclusion — merchant-facing sitemap-exclusion suggestions and
-- applied/reverted decisions, upserted idempotently by
-- app/services/seo/sitemap.service.ts and read by
-- app/routes/app.seo.sitemap.tsx.

-- CreateTable
CREATE TABLE "SeoSitemapExclusion" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoSitemapExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoSitemapExclusion_shop_resourceType_resourceId_key" ON "SeoSitemapExclusion"("shop", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "SeoSitemapExclusion_shop_status_idx" ON "SeoSitemapExclusion"("shop", "status");
