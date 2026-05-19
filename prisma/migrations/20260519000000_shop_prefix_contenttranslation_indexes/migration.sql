-- Replace non-tenant-scoped ContentTranslation hot-path indexes with
-- shop-prefixed equivalents. Without the shop prefix, lookups by
-- (resourceId, locale) or (resourceType, resourceId) scan index ranges
-- spanning ALL shops' rows. Idempotent so it is safe on every environment
-- (CONCURRENTLY is not used because Prisma runs migrations in a transaction).

CREATE INDEX IF NOT EXISTS "ContentTranslation_shop_resourceId_locale_idx"
  ON "ContentTranslation"("shop", "resourceId", "locale");

CREATE INDEX IF NOT EXISTS "ContentTranslation_shop_resourceType_resourceId_idx"
  ON "ContentTranslation"("shop", "resourceType", "resourceId");

DROP INDEX IF EXISTS "ContentTranslation_resourceId_locale_idx";
DROP INDEX IF EXISTS "ContentTranslation_resourceType_resourceId_idx";
