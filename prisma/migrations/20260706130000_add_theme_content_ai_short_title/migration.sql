-- Add AI-generated short nav title to ThemeContent.
-- Nullable: only set for rows whose raw groupName is unusable in a list
-- (currently EMAIL_TEMPLATE, whose groupName is the full localized email subject
-- line). Written once by the title-backfill task and preserved across syncs.
ALTER TABLE "ThemeContent" ADD COLUMN IF NOT EXISTS "aiShortTitle" TEXT;
