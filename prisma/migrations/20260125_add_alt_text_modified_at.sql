-- Add altTextModifiedAt column to ProductImage table
-- This timestamp tracks when user last modified the alt-text
-- Used to prevent webhook-triggered syncs from overwriting recent user changes

ALTER TABLE "ProductImage" ADD COLUMN IF NOT EXISTS "altTextModifiedAt" TIMESTAMP(3);
