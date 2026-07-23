-- Phase 2 (Internal Linking, PLAN_SEO_SUITE_COMPLETION.md §2/§4): suggested
-- internal links between DB-cached content, upserted idempotently by
-- app/services/seo/internal-links.service.ts and read by
-- app/routes/app.seo.internal-links.tsx.

-- CreateTable
CREATE TABLE "SeoInternalLinkSuggestion" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT '',
    "fromResourceType" TEXT NOT NULL,
    "fromResourceId" TEXT NOT NULL,
    "anchorText" TEXT NOT NULL,
    "toResourceType" TEXT NOT NULL,
    "toResourceId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "dismissedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoInternalLinkSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Explicit short name (schema.prisma `map:`) — the Prisma-default name would
-- be 101 chars, over Postgres' 63-byte identifier limit.
CREATE UNIQUE INDEX "SeoInternalLinkSuggestion_shop_from_to_locale_key" ON "SeoInternalLinkSuggestion"("shop", "fromResourceType", "fromResourceId", "toResourceType", "toResourceId", "locale");

-- CreateIndex
CREATE INDEX "SeoInternalLinkSuggestion_shop_status_idx" ON "SeoInternalLinkSuggestion"("shop", "status");
