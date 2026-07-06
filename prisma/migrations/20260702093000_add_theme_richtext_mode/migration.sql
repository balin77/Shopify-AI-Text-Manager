-- Merchant-selectable handling of Shopify's richtext top-level-node rule when
-- saving primary theme-settings values (e.g. Brand information → brand_description).
-- Values: "autofix" (default) | "normalize" | "error". See AISettings model docs.
--
-- Idempotent (IF NOT EXISTS): safe to re-run and safe on shops that already have
-- the column. Additive, non-breaking — existing rows get the "autofix" default.

ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "themeRichtextMode" TEXT NOT NULL DEFAULT 'autofix';
