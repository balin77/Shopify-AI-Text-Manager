-- H3 fix: align the DB-level column default with the Prisma schema
-- (`subscriptionPlan String @default("free")`).
--
-- The baseline migration created the column with DEFAULT 'basic'. A row
-- inserted via raw SQL / outside the application `upsert` paths would silently
-- receive Basic features without payment. This makes 'free' the safe default
-- at the database level too. Existing rows are NOT modified — application code
-- always sets the plan explicitly from the Shopify-verified subscription.
ALTER TABLE "AISettings" ALTER COLUMN "subscriptionPlan" SET DEFAULT 'free';
