-- SEO tab Performance section, Phase 2: real-user web-vitals (RUM) samples
-- beaconed from the storefront. Shop-scoped, no visitor identifiers. Pruned to
-- 45 days per shop by recordWebVitalSample (app/services/seo/web-vitals.service.ts).

-- CreateTable
CREATE TABLE "SeoWebVitalSample" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "lcpMs" DOUBLE PRECISION,
    "cls" DOUBLE PRECISION,
    "inpMs" DOUBLE PRECISION,
    "fcpMs" DOUBLE PRECISION,
    "ttfbMs" DOUBLE PRECISION,
    "lcpElement" TEXT,
    "clsElement" TEXT,
    "inpElement" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeoWebVitalSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoWebVitalSample_shop_createdAt_idx" ON "SeoWebVitalSample"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "SeoWebVitalSample_shop_template_device_createdAt_idx" ON "SeoWebVitalSample"("shop", "template", "device", "createdAt");
