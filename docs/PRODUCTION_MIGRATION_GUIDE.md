# Production Database Migration Guide

## Overview
This guide describes the exact steps needed to migrate your production database from the old `Translation` table to the new `ContentTranslation` table as part of the Unified Content System migration.

## Prerequisites
- Access to your production environment
- Database backup completed
- Node.js and npm installed
- Prisma CLI available

## Migration Steps

### Step 1: Backup Your Database
```bash
# Create a backup before running any migrations
# This is CRITICAL - always backup first!
# The exact command depends on your database provider
```

### Step 2: Pull the Latest Code
```bash
git checkout main
git pull origin main
```

### Step 3: Install Dependencies
```bash
npm install
```

### Step 4: Run Prisma Migration
```bash
# This will create the new ContentTranslation table
# and migrate all data from Translation to ContentTranslation
npx prisma migrate deploy
```

### Step 5: Verify Migration
```bash
# Connect to your database and verify:
# 1. ContentTranslation table exists
# 2. Data has been migrated from Translation table
# 3. All Product translations are present

# Optional: Run Prisma Studio to inspect data
npx prisma studio
```

### Step 6: Deploy Application
```bash
# Build the application
npm run build

# Deploy to your hosting provider
# (command depends on your hosting setup)
```

## What the Migration Does

### Database Schema Changes
1. **Creates new table**: `ContentTranslation`
   - Polymorphic design supporting all content types (Products, Collections, Pages, Blogs, Articles, Policies)
   - Fields: `id`, `contentType`, `contentId`, `locale`, `fieldKey`, `value`, `createdAt`, `updatedAt`
   - Composite unique constraint: `contentType`, `contentId`, `locale`, `fieldKey`

2. **Migrates data**: All records from `Translation` table to `ContentTranslation`
   - `contentType` = "PRODUCT" for all existing translations
   - `contentId` = original `productId`
   - All other fields copied as-is

3. **Preserves old table**: The `Translation` table is **not deleted** for safety
   - This allows rollback if needed
   - You can manually drop it later after verifying everything works

### Application Changes
- Products route now uses `ContentTranslation` instead of `Translation`
- Unified Content Editor system activated
- All existing functionality preserved (thumbnails, pagination, scrollbars, image rendering)

## Rollback Plan

If something goes wrong:

```bash
# Revert to previous deployment
git checkout <previous-commit-hash>

# Rebuild and redeploy
npm install
npm run build

# The old Translation table still exists, so the old code will work
```

## Post-Migration Verification

Check the following:
1. ✅ Products page loads without errors
2. ✅ Product translations display correctly
3. ✅ Language switching works
4. ✅ AI translation features work
5. ✅ Saving translations works
6. ✅ Thumbnails appear in navigation
7. ✅ Pagination and scrollbars work
8. ✅ Product images render correctly

## Troubleshooting

### Migration Fails
- Check database connection string in `.env`
- Verify database user has CREATE/ALTER permissions
- Check Prisma migration logs

### Data Not Migrated
- Verify `Translation` table has data
- Check Prisma migration status: `npx prisma migrate status`
- Review migration file: `prisma/migrations/*/migration.sql`

### Application Errors After Migration
- Check browser console for errors
- Verify all dependencies installed: `npm install`
- Rebuild application: `npm run build`
- Check server logs for detailed error messages

## Migration SQL (for reference)

The migration automatically executes:

```sql
-- Create ContentTranslation table
CREATE TABLE "ContentTranslation" (
    "id" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContentTranslation_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX "ContentTranslation_contentType_contentId_idx"
    ON "ContentTranslation"("contentType", "contentId");

CREATE UNIQUE INDEX "ContentTranslation_contentType_contentId_locale_fieldKey_key"
    ON "ContentTranslation"("contentType", "contentId", "locale", "fieldKey");

-- Migrate data from Translation to ContentTranslation
INSERT INTO "ContentTranslation" ("id", "contentType", "contentId", "locale", "fieldKey", "value", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    'PRODUCT',
    "productId",
    "locale",
    "fieldKey",
    "value",
    "createdAt",
    "updatedAt"
FROM "Translation";
```

## Support

If you encounter issues during migration:
1. Check this guide's troubleshooting section
2. Review application logs
3. Check the commit history for recent changes
4. Create a GitHub issue with error details

## Cleanup (Optional)

After verifying everything works for at least 1-2 weeks:

```sql
-- Only run this after thoroughly testing the new system
DROP TABLE "Translation";
```

⚠️ **Warning**: Only drop the old table after you're 100% confident the migration was successful!
