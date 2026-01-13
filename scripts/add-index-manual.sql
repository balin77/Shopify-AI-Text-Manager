-- Manual Index Creation Script
-- Run this directly in your production database if migration fails

-- Check if index already exists
SELECT indexname
FROM pg_indexes
WHERE tablename = 'ThemeTranslation'
  AND indexname = 'ThemeTranslation_shop_groupId_locale_idx';

-- Create index if it doesn't exist (this is idempotent)
CREATE INDEX IF NOT EXISTS "ThemeTranslation_shop_groupId_locale_idx"
ON "ThemeTranslation"("shop", "groupId", "locale");

-- Verify the index was created
SELECT indexname
FROM pg_indexes
WHERE tablename = 'ThemeTranslation';
