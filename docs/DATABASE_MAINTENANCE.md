# Database Maintenance Guide

## Problem Overview

The background sync system was accumulating data, particularly theme translations, which caused the PostgreSQL database to run out of disk space on Railway.

## Root Causes

1. **Theme Sync Overflow**: The theme sync feature was creating massive amounts of data (thousands of theme translations per sync cycle)
2. **No Automatic Cleanup**: Old data was never removed, causing continuous growth
3. **Limited Railway Volume**: The Railway database volume was too small for the data accumulation rate

## Solutions Implemented

### 1. Theme Sync Disabled ✅

Theme synchronization has been **permanently disabled** in [app/services/background-sync.service.ts:639-651](app/services/background-sync.service.ts#L639-L651) because:
- It creates too much data (1000+ records per sync)
- Theme content rarely changes
- It's not critical for the app's main functionality

### 2. Automatic Periodic Cleanup ✅

The sync scheduler now includes automatic database cleanup that runs **every hour** when the app is active:

**What gets cleaned up:**
- ✅ **All theme data** (since theme sync is disabled)
- ✅ **Expired tasks** (older than 3 days)
- ✅ **Old webhook logs** (older than 7 days)

**Implementation:** [app/services/sync-scheduler.service.ts:184-245](app/services/sync-scheduler.service.ts#L184-L245)

### 3. Manual Cleanup Script ✅

For one-time cleanup or emergency situations, use:

```bash
node scripts/cleanup-database.js
```

**What it does:**
- Removes all theme data
- Removes expired tasks
- Removes old webhook logs
- Removes orphaned translations
- Runs `VACUUM FULL` to reclaim disk space

## What Actually Gets Synced Now

### ✅ Active Sync (every 40 seconds while shop is active):
- **Pages** - upsert existing, remove old translations
- **Shop Policies** - upsert existing, remove old translations

### ❌ Disabled:
- **Themes** - Disabled to prevent database overflow

## How the Sync Works Correctly

### Pages & Policies (Working Correctly)
1. Fetch all pages/policies from Shopify
2. **Upsert** each page/policy (creates new or updates existing)
3. **Delete** old translations for that resource
4. **Insert** new translations

This ensures no accumulation - old data is always replaced!

### Why Theme Sync Was Problematic

The theme sync was working correctly (upsert + delete old + insert new), but:
- Each theme has **hundreds of translatable keys**
- With 5 resource types × 20+ groups = **100+ database records per sync**
- Syncing every 40 seconds = **9,000 records per hour**
- This overwhelmed the Railway volume

## Railway Configuration

### Current Setup
- Background sync runs every **40 seconds** when shop is active
- Automatic cleanup runs every **1 hour**
- Sync stops after **5 minutes** of inactivity

### Recommended Railway Settings

1. **Volume Size**: At least **1GB** (preferably 2GB for safety margin)
2. **Monitor Disk Usage**: Check Railway dashboard regularly
3. **Connection Limits**: Current Prisma settings should be fine

### If Database Runs Out of Space Again

1. **Immediate Fix**: Delete the Railway volume and recreate it (all data will be lost)
2. **Run Manual Cleanup**:
   ```bash
   railway run node scripts/cleanup-database.js
   ```
3. **Increase Volume Size**: Go to Railway dashboard → PostgreSQL service → Volumes → Increase size

## Monitoring

### Check Sync Status

The app logs show:
```
[SyncScheduler] Running sync cycle for {shop}
[SyncScheduler] Sync complete for {shop}: X items in Yms
[SyncScheduler] Running periodic database cleanup...
[SyncScheduler] Cleanup complete: X tasks, Y logs, Z theme translations, W theme content
```

### Check Database Size

Connect to Railway database:
```bash
railway connect postgres
```

Then run:
```sql
-- Check database size
SELECT pg_database.datname, pg_size_pretty(pg_database_size(pg_database.datname))
FROM pg_database;

-- Check table sizes
SELECT
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Count records in key tables
SELECT 'Pages' as table_name, COUNT(*) FROM "Page"
UNION ALL
SELECT 'Shop Policies', COUNT(*) FROM "ShopPolicy"
UNION ALL
SELECT 'Content Translations', COUNT(*) FROM "ContentTranslation"
UNION ALL
SELECT 'Theme Content', COUNT(*) FROM "ThemeContent"
UNION ALL
SELECT 'Theme Translations', COUNT(*) FROM "ThemeTranslation"
UNION ALL
SELECT 'Tasks', COUNT(*) FROM "Task"
UNION ALL
SELECT 'Webhook Logs', COUNT(*) FROM "WebhookLog";
```

## Future Improvements

If you need to re-enable theme sync in the future:

1. **Implement Incremental Sync**: Only sync themes that have changed since last sync
2. **Add Smarter Grouping**: Reduce the number of groups created
3. **Increase Sync Interval**: Change from 40 seconds to 5-10 minutes for themes
4. **Separate Sync Schedules**: Pages/Policies every 40s, Themes every 10 minutes
5. **Add Compression**: Store theme content as compressed JSON

## Summary

✅ **Problem solved** - Database no longer accumulates unnecessary data
✅ **Automatic cleanup** - Runs every hour to prevent future issues
✅ **Theme sync disabled** - Main source of data overflow eliminated
✅ **Manual cleanup available** - For emergency situations

The app now maintains a stable database size and should not overflow Railway's volume anymore.
