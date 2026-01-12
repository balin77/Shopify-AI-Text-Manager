-- ============================================
-- Railway Database Cleanup Script
-- ============================================
-- Removes all cached sync data that caused DB overflow
-- Preserves: Sessions, Products, AI Settings, Webhook Logs, Tasks
--
-- How to use in Railway:
-- 1. Go to Railway Dashboard → PostgreSQL
-- 2. Click on "Data" tab
-- 3. Find the "Query" option in the toolbar
-- 4. Copy and paste this entire script
-- 5. Click "Execute" or "Run"
-- ============================================

BEGIN;

-- Show current table sizes BEFORE cleanup
SELECT
  'BEFORE CLEANUP' as status,
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
  pg_total_relation_size(schemaname||'.'||tablename) as size_bytes
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('ThemeTranslation', 'ThemeContent', 'ContentTranslation', 'Page', 'ShopPolicy', 'Collection', 'Article')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Count records BEFORE deletion
SELECT 'Records BEFORE cleanup:' as info;
SELECT 'ThemeTranslation' as table_name, COUNT(*) as records FROM "ThemeTranslation"
UNION ALL SELECT 'ThemeContent', COUNT(*) FROM "ThemeContent"
UNION ALL SELECT 'ContentTranslation', COUNT(*) FROM "ContentTranslation"
UNION ALL SELECT 'Page', COUNT(*) FROM "Page"
UNION ALL SELECT 'ShopPolicy', COUNT(*) FROM "ShopPolicy"
UNION ALL SELECT 'Collection', COUNT(*) FROM "Collection"
UNION ALL SELECT 'Article', COUNT(*) FROM "Article";

-- ============================================
-- DELETE OPERATIONS
-- ============================================

-- 1. Delete Theme Translations (usually the biggest)
DELETE FROM "ThemeTranslation";
SELECT 'Deleted ThemeTranslation records' as step;

-- 2. Delete Theme Content
DELETE FROM "ThemeContent";
SELECT 'Deleted ThemeContent records' as step;

-- 3. Delete Content Translations
DELETE FROM "ContentTranslation";
SELECT 'Deleted ContentTranslation records' as step;

-- 4. Delete Pages
DELETE FROM "Page";
SELECT 'Deleted Page records' as step;

-- 5. Delete Shop Policies
DELETE FROM "ShopPolicy";
SELECT 'Deleted ShopPolicy records' as step;

-- 6. Delete Collections
DELETE FROM "Collection";
SELECT 'Deleted Collection records' as step;

-- 7. Delete Articles
DELETE FROM "Article";
SELECT 'Deleted Article records' as step;

-- ============================================
-- VACUUM to reclaim disk space
-- ============================================
COMMIT;

-- Run VACUUM to actually free up the disk space
VACUUM FULL "ThemeTranslation";
VACUUM FULL "ThemeContent";
VACUUM FULL "ContentTranslation";
VACUUM FULL "Page";
VACUUM FULL "ShopPolicy";
VACUUM FULL "Collection";
VACUUM FULL "Article";

-- Show final result
SELECT 'CLEANUP COMPLETE!' as status;

-- Count records AFTER deletion (should all be 0)
SELECT 'Records AFTER cleanup:' as info;
SELECT 'ThemeTranslation' as table_name, COUNT(*) as records FROM "ThemeTranslation"
UNION ALL SELECT 'ThemeContent', COUNT(*) FROM "ThemeContent"
UNION ALL SELECT 'ContentTranslation', COUNT(*) FROM "ContentTranslation"
UNION ALL SELECT 'Page', COUNT(*) FROM "Page"
UNION ALL SELECT 'ShopPolicy', COUNT(*) FROM "ShopPolicy"
UNION ALL SELECT 'Collection', COUNT(*) FROM "Collection"
UNION ALL SELECT 'Article', COUNT(*) FROM "Article";

-- Show table sizes AFTER cleanup
SELECT
  'AFTER CLEANUP' as status,
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
  pg_total_relation_size(schemaname||'.'||tablename) as size_bytes
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('ThemeTranslation', 'ThemeContent', 'ContentTranslation', 'Page', 'ShopPolicy', 'Collection', 'Article')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Show total database size
SELECT pg_size_pretty(pg_database_size(current_database())) as total_database_size;
