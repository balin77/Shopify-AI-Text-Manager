-- Align the DB-level column default with the Prisma schema
-- (`preferredProvider String @default("claude")`).
--
-- New installs should default to Anthropic (internal provider key "claude")
-- instead of Hugging Face. Application code still sets this explicitly on
-- first settings creation; this keeps rows created via other upsert paths
-- (billing, dev plan override) consistent. Existing rows are NOT modified.
ALTER TABLE "AISettings" ALTER COLUMN "preferredProvider" SET DEFAULT 'claude';
