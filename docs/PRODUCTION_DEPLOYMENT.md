# Production Deployment Guide

## Overview

This guide explains how to deploy the Shopify API Connector to production with all necessary database migrations.

## Database Migrations Required

Since the last production deployment, **12 major migrations** need to be applied:

### 1. Product & Webhook System (2025-01-10)
**Migration:** `20250110_add_product_translation_webhook_models`

Creates core tables for product management:
- `Product` - Main product data
- `Translation` - Product translations by locale
- `ProductImage` - Product images with alt text
- `ProductOption` - Product variants/options
- `ProductMetafield` - Custom metafields
- `WebhookLog` - Webhook event tracking

### 2. Alt-Text AI Instructions (2025-01-11)
**Migration:** `20250111_add_alttext_instructions`

Adds AI instruction fields for alt-text generation:
- `altTextFormat` - Format template
- `altTextInstructions` - AI generation instructions

### 3. Unified Content System (2025-01-11)
**Migration:** `20250111_add_content_models`

Creates unified content management tables:
- `Collection` - Collection data
- `Article` - Blog article data
- `Page` - Page content data
- `ContentTranslation` - Unified translation table for all content types

### 4. Remove Content FK Constraints (2025-01-11)
**Migration:** `20250111143000_remove_content_fk_constraints`

Removes strict foreign key constraints from `ContentTranslation` to make it more flexible across different resource types.

### 5. Theme Translation Indexes (2026-01-13)
**Migration:** `20260113_add_theme_translation_indexes`

Adds performance index:
- `ThemeTranslation(shop, groupId, locale)` - Improves theme translation queries

### 6. Entity-Specific AI Instructions (Comprehensive)
**Migration:** `add_entity_specific_ai_instructions.sql`

**Important:** This is a large, idempotent migration that:
- Adds Grok API key support
- Adds DeepSeek API key support
- Renames generic AI instructions to product-specific fields
- Adds AI instruction fields for:
  - **Collections:** 10 fields (title, description, handle, SEO, meta)
  - **Blogs:** 10 fields (title, description, handle, SEO, meta)
  - **Pages:** 10 fields (title, description, handle, SEO, meta)
  - **Policies:** 2 fields (description)
- Can be run multiple times safely (checks for existing columns)

### 7. Product Image Alt Translations (2026-01-13)
**Migration:** `20260113_add_product_image_alt_translations`

Creates multi-language alt-text support:
- `ProductImageAltTranslation` - Alt text per locale
- Adds `mediaId` to `ProductImage`

### 8. Menu Caching System (2025-01-13)
**Migration:** `20250113_add_menu_model.sql`

Creates menu caching:
- `Menu` - Cached menu data with JSONB items
- Reduces API calls by caching menu structure
- Idempotent migration

### 9. Subscription Plans (2026-01-13)
**Migration:** `20260113_add_subscription_plan`

Adds subscription tier tracking:
- `subscriptionPlan` field in `AISettings`
- Valid values: free, basic, pro, max
- Default: 'basic'

### 10. Task Prompt Logging (2026-01-14)
**Migration:** `20260114_add_prompt_to_task.sql`

Adds transparency for AI operations:
- `prompt` field in `Task` table
- Stores AI prompts for user visibility
- Idempotent migration

### 11. Webhook Retry System (2026-01-16)
**Migration:** `20260116_add_webhook_retry.sql`

Creates automatic webhook retry:
- `WebhookRetry` - Failed webhook storage
- Exponential backoff retry logic
- Max 5 retry attempts

### 12. Duplicate Migrations (Skip These)
These are duplicates and will be skipped:
- `20260111135640_add_alttext_instructions` (duplicate of #2)
- `20260111170930_remove_content_fk_constraints` (duplicate of #4)

## Deployment Methods

### Method 1: Custom Start Command (Recommended for Railway)

Use the new `start:production` command that runs all migrations before starting:

```bash
npm run start:production
```

**Railway Configuration:**
```
Custom Start Command: npm run start:production
```

This command automatically:
1. Generates Prisma Client
2. Runs all Prisma schema migrations (`prisma migrate deploy`)
3. Falls back to `db push` if migrations fail
4. Runs API key encryption migration (if `ENCRYPTION_KEY` set)
5. Runs Session PII encryption migration (if `ENCRYPTION_KEY` set)
6. Runs Webhook payload encryption migration (if `ENCRYPTION_KEY` set)
7. Validates environment variables
8. Starts the Express server

### Method 2: Separate Migration Step

Run migrations separately before deployment:

```bash
# Step 1: Run all migrations
npm run start:with-migrations

# Step 2: Start normally
npm run start
```

### Method 3: Manual Migration

For more control, run migrations manually:

```bash
# 1. Generate Prisma Client
npx prisma generate

# 2. Run schema migrations
npx prisma migrate deploy

# 3. (Optional) Run encryption migrations if ENCRYPTION_KEY is set
npx tsx scripts/migrate-encrypt-api-keys.ts
npx tsx scripts/migrate-encrypt-session-pii.ts
npx tsx scripts/migrate-encrypt-webhook-payloads.ts

# 4. Start the server
npm run start
```

## Environment Variables Required

### Essential
- `DATABASE_URL` - PostgreSQL connection string
- `SHOPIFY_API_KEY` - Shopify app API key
- `SHOPIFY_API_SECRET` - Shopify app secret
- `SCOPES` - Shopify API scopes

### Optional (but recommended)
- `ENCRYPTION_KEY` - For encrypting sensitive data (API keys, PII, webhooks)
- `NODE_ENV=production` - Sets production mode

## Migration Safety Features

All migrations include safety features:

✅ **Idempotent:** Most migrations check if tables/columns exist before creating them
✅ **Fallback:** Script falls back to `db push` if `migrate deploy` fails
✅ **Error Handling:** Continues with warnings if encryption migrations fail
✅ **No Data Loss:** All migrations preserve existing data

## Rollback Instructions

If you need to rollback a migration:

```bash
# Restore from backup
psql $DATABASE_URL < backup_file.sql

# Or use Prisma's migrate resolve to mark migrations as not applied
npx prisma migrate resolve --rolled-back <migration-name>
```

## Testing Migrations Locally

Before deploying to production, test migrations locally:

```bash
# 1. Create a backup
pg_dump $DATABASE_URL > backup_local.sql

# 2. Run migrations
npm run start:production

# 3. Verify everything works
npm run dev

# 4. If issues occur, restore backup
psql $DATABASE_URL < backup_local.sql
```

## Production Checklist

Before deploying:

- [ ] Backup production database
- [ ] Verify `DATABASE_URL` is correct
- [ ] Set `ENCRYPTION_KEY` if encrypting data
- [ ] Test migrations on staging environment
- [ ] Review all 12 migrations in this document
- [ ] Update Railway start command to `npm run start:production`
- [ ] Monitor logs during deployment
- [ ] Verify app functionality after deployment

## Monitoring

After deployment, monitor:

1. **Railway Logs:** Check for migration errors
2. **Database Connections:** Ensure connections are stable
3. **API Responses:** Test key endpoints
4. **Webhook Processing:** Verify webhooks are being processed

## Support

If migrations fail:

1. Check Railway logs for specific error messages
2. Verify all environment variables are set
3. Ensure database has sufficient permissions
4. Contact support with error logs

## Migration Timeline

All migrations were developed between January 10, 2025 and January 16, 2026, as part of:
- Unified Content System refactoring
- Multi-language translation system
- AI-powered content generation
- Webhook reliability improvements
- Security enhancements (encryption)
