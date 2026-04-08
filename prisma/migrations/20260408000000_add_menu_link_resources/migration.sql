-- Add linkResources column to Menu table.
-- Stores a JSON map of link resource IDs discovered via Shopify's
-- translatableResources API, enabling menu item translation support.
ALTER TABLE "Menu" ADD COLUMN IF NOT EXISTS "linkResources" JSONB;
