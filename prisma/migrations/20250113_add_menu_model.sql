-- ============================================
-- Migration: Add Menu Model for Caching
-- Date: 2025-01-13
-- ============================================
-- Description:
-- - Adds Menu table to cache menu data from Shopify
-- - Stores menu items structure as JSON
-- - Improves performance by reducing API calls
-- ============================================

-- Create Menu table (idempotent - checks if exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'Menu'
    ) THEN
        CREATE TABLE "Menu" (
            "id" TEXT NOT NULL,
            "shop" TEXT NOT NULL,
            "title" TEXT NOT NULL,
            "handle" TEXT NOT NULL,
            "items" JSONB NOT NULL,
            "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT "Menu_pkey" PRIMARY KEY ("id")
        );

        RAISE NOTICE '✅ Created Menu table';
    ELSE
        RAISE NOTICE 'ℹ️  Menu table already exists, skipping...';
    END IF;
END $$;

-- Create unique index on shop and id (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'Menu'
        AND indexname = 'Menu_shop_id_key'
    ) THEN
        CREATE UNIQUE INDEX "Menu_shop_id_key" ON "Menu"("shop", "id");
        RAISE NOTICE '✅ Created unique index Menu_shop_id_key';
    ELSE
        RAISE NOTICE 'ℹ️  Index Menu_shop_id_key already exists, skipping...';
    END IF;
END $$;

-- Create index on shop (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'Menu'
        AND indexname = 'Menu_shop_idx'
    ) THEN
        CREATE INDEX "Menu_shop_idx" ON "Menu"("shop");
        RAISE NOTICE '✅ Created index Menu_shop_idx';
    ELSE
        RAISE NOTICE 'ℹ️  Index Menu_shop_idx already exists, skipping...';
    END IF;
END $$;

-- Create index on lastSyncedAt (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'Menu'
        AND indexname = 'Menu_lastSyncedAt_idx'
    ) THEN
        CREATE INDEX "Menu_lastSyncedAt_idx" ON "Menu"("lastSyncedAt");
        RAISE NOTICE '✅ Created index Menu_lastSyncedAt_idx';
    ELSE
        RAISE NOTICE 'ℹ️  Index Menu_lastSyncedAt_idx already exists, skipping...';
    END IF;
END $$;

-- ============================================
-- ROLLBACK (if needed):
-- DROP TABLE IF EXISTS "Menu" CASCADE;
-- ============================================
