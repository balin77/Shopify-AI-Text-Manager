-- Add SEO fields to Page table
-- These are optional (nullable) as pages only have SEO data when explicitly set in Shopify admin
ALTER TABLE "Page" ADD COLUMN IF NOT EXISTS "seoTitle" TEXT;
ALTER TABLE "Page" ADD COLUMN IF NOT EXISTS "seoDescription" TEXT;
