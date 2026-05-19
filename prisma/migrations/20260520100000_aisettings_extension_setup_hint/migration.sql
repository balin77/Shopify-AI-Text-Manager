-- First-run theme-extension setup hint for Pro/Max shops.
-- One-shot marker: set the first time the hint infobox is shown so it does
-- not re-appear on every app load. Nullable (legacy rows have none). Lives
-- on the shop-scoped AISettings row, so it is cleared on shop/redact, which
-- is intentional. Idempotent so it is safe on every environment.

ALTER TABLE "AISettings" ADD COLUMN IF NOT EXISTS "extensionSetupHintShownAt" TIMESTAMP(3);
