-- ============================================
-- Migration: Add prompt field to Task table
-- Date: 2026-01-14
-- ============================================
-- Description:
-- - Adds prompt column to store AI prompts/requests
-- - Allows users to see what prompt was sent to the AI
-- ============================================

-- Idempotent: Prüft ob Spalte bereits existiert
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Task'
        AND column_name = 'prompt'
    ) THEN
        ALTER TABLE "Task" ADD COLUMN "prompt" TEXT;
        RAISE NOTICE '✅ Added prompt column to Task table';
    ELSE
        RAISE NOTICE 'ℹ️  prompt column already exists, skipping...';
    END IF;
END $$;

-- ROLLBACK (falls nötig):
-- ALTER TABLE "Task" DROP COLUMN IF EXISTS "prompt";
