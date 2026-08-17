-- Merchant switch for the nightly SEO audit (Settings → SEO).
--
-- Defaulted column on an existing table: safe to ship with the code, an older
-- container simply never selects it. Default TRUE matches the sweep's intent —
-- an entitled (Max) shop gets the nightly trend unless it opts out — and needs
-- no backfill.
ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "seoAutoAuditEnabled" BOOLEAN NOT NULL DEFAULT true;
