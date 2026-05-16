-- Add per-shop "initial full sync completed" marker to ShopInstallState.
-- Additiv/idempotent. Backfill so ALLE bestehenden Shops als bereits
-- eingerichtet gelten (kein Re-Onboarding, kein überraschender Voll-Re-Sync) —
-- der Fix zielt nur auf Neuinstallationen ab dieser Migration.
ALTER TABLE "ShopInstallState"
  ADD COLUMN IF NOT EXISTS "initialSyncCompletedAt" TIMESTAMP(3);

-- Bestehende Install-State-Zeilen: alle bereits installierten Shops = "set up".
UPDATE "ShopInstallState"
  SET "initialSyncCompletedAt" = NOW()
  WHERE "initialSyncCompletedAt" IS NULL;

-- Legacy-Shops mit Produkten, aber ohne Install-State-Zeile: ebenfalls "set up".
INSERT INTO "ShopInstallState" ("shop", "uninstalledAt", "initialSyncCompletedAt", "updatedAt")
SELECT DISTINCT p."shop", NULL, NOW(), NOW()
FROM "Product" p
LEFT JOIN "ShopInstallState" s ON s."shop" = p."shop"
WHERE s."shop" IS NULL;
