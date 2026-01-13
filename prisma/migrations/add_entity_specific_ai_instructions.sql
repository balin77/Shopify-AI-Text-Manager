-- ============================================
-- Database Migration: Entity-Specific AI Instructions + Grok/DeepSeek Support
-- ============================================
-- This migration:
-- 1. Adds Grok and DeepSeek API key columns to AISettings (if not exists)
-- 2. Transforms generic AI instructions into entity-specific instructions
-- 3. Preserves existing data by renaming columns to product-specific fields
-- 4. Adds new columns for Collections, Blogs, Pages, and Policies
-- ============================================

-- PART 1: Add Grok and DeepSeek support to AISettings
-- --------------------------------------------
DO $$
BEGIN
    -- Add grokApiKey if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AISettings'
        AND column_name = 'grokApiKey'
    ) THEN
        ALTER TABLE "AISettings" ADD COLUMN "grokApiKey" TEXT;
    END IF;

    -- Add deepseekApiKey if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AISettings'
        AND column_name = 'deepseekApiKey'
    ) THEN
        ALTER TABLE "AISettings" ADD COLUMN "deepseekApiKey" TEXT;
    END IF;

    -- Add Grok rate limiting columns if they don't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AISettings'
        AND column_name = 'grokMaxTokensPerMinute'
    ) THEN
        ALTER TABLE "AISettings" ADD COLUMN "grokMaxTokensPerMinute" INTEGER DEFAULT 100000;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AISettings'
        AND column_name = 'grokMaxRequestsPerMinute'
    ) THEN
        ALTER TABLE "AISettings" ADD COLUMN "grokMaxRequestsPerMinute" INTEGER DEFAULT 60;
    END IF;

    -- Add DeepSeek rate limiting columns if they don't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AISettings'
        AND column_name = 'deepseekMaxTokensPerMinute'
    ) THEN
        ALTER TABLE "AISettings" ADD COLUMN "deepseekMaxTokensPerMinute" INTEGER DEFAULT 100000;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AISettings'
        AND column_name = 'deepseekMaxRequestsPerMinute'
    ) THEN
        ALTER TABLE "AISettings" ADD COLUMN "deepseekMaxRequestsPerMinute" INTEGER DEFAULT 60;
    END IF;
END $$;

-- PART 2: Transform AIInstructions to entity-specific structure
-- --------------------------------------------

-- Check if old generic columns exist, then rename them to product-specific
DO $$
BEGIN
    -- Rename generic columns to product-specific (if they exist)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AIInstructions'
        AND column_name = 'titleFormat'
    ) THEN
        ALTER TABLE "AIInstructions" RENAME COLUMN "titleFormat" TO "productTitleFormat";
        ALTER TABLE "AIInstructions" RENAME COLUMN "titleInstructions" TO "productTitleInstructions";
        ALTER TABLE "AIInstructions" RENAME COLUMN "descriptionFormat" TO "productDescriptionFormat";
        ALTER TABLE "AIInstructions" RENAME COLUMN "descriptionInstructions" TO "productDescriptionInstructions";
        ALTER TABLE "AIInstructions" RENAME COLUMN "handleFormat" TO "productHandleFormat";
        ALTER TABLE "AIInstructions" RENAME COLUMN "handleInstructions" TO "productHandleInstructions";
        ALTER TABLE "AIInstructions" RENAME COLUMN "seoTitleFormat" TO "productSeoTitleFormat";
        ALTER TABLE "AIInstructions" RENAME COLUMN "seoTitleInstructions" TO "productSeoTitleInstructions";
        ALTER TABLE "AIInstructions" RENAME COLUMN "metaDescFormat" TO "productMetaDescFormat";
        ALTER TABLE "AIInstructions" RENAME COLUMN "metaDescInstructions" TO "productMetaDescInstructions";
        ALTER TABLE "AIInstructions" RENAME COLUMN "altTextFormat" TO "productAltTextFormat";
        ALTER TABLE "AIInstructions" RENAME COLUMN "altTextInstructions" TO "productAltTextInstructions";
    END IF;
END $$;

-- Add Collections fields (if they don't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AIInstructions'
        AND column_name = 'collectionTitleFormat'
    ) THEN
        ALTER TABLE "AIInstructions" ADD COLUMN "collectionTitleFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "collectionTitleInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "collectionDescriptionFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "collectionDescriptionInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "collectionHandleFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "collectionHandleInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "collectionSeoTitleFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "collectionSeoTitleInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "collectionMetaDescFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "collectionMetaDescInstructions" TEXT;
    END IF;
END $$;

-- Add Blogs fields (if they don't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AIInstructions'
        AND column_name = 'blogTitleFormat'
    ) THEN
        ALTER TABLE "AIInstructions" ADD COLUMN "blogTitleFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "blogTitleInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "blogDescriptionFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "blogDescriptionInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "blogHandleFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "blogHandleInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "blogSeoTitleFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "blogSeoTitleInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "blogMetaDescFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "blogMetaDescInstructions" TEXT;
    END IF;
END $$;

-- Add Pages fields (if they don't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AIInstructions'
        AND column_name = 'pageTitleFormat'
    ) THEN
        ALTER TABLE "AIInstructions" ADD COLUMN "pageTitleFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "pageTitleInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "pageDescriptionFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "pageDescriptionInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "pageHandleFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "pageHandleInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "pageSeoTitleFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "pageSeoTitleInstructions" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "pageMetaDescFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "pageMetaDescInstructions" TEXT;
    END IF;
END $$;

-- Add Policies fields (if they don't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AIInstructions'
        AND column_name = 'policyDescriptionFormat'
    ) THEN
        ALTER TABLE "AIInstructions" ADD COLUMN "policyDescriptionFormat" TEXT;
        ALTER TABLE "AIInstructions" ADD COLUMN "policyDescriptionInstructions" TEXT;
    END IF;
END $$;

-- ============================================
-- Migration Complete
-- ============================================
-- Summary:
-- ✓ Added Grok API key support (if not exists)
-- ✓ Added DeepSeek API key support (if not exists)
-- ✓ Added Grok rate limiting columns (if not exists)
-- ✓ Added DeepSeek rate limiting columns (if not exists)
-- ✓ Renamed generic AI instruction columns to product-specific (if exists)
-- ✓ Added entity-specific instruction columns for:
--   - Collections (10 columns)
--   - Blogs (10 columns)
--   - Pages (10 columns)
--   - Policies (2 columns)
-- ✓ Preserved all existing data
-- ============================================
