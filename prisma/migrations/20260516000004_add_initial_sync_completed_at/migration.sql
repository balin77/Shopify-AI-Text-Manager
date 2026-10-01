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
--
-- KORREKTUR 2026-08-16: das nackte NULL in der Spaltenliste war ein Fehler.
-- Postgres typt ein untypisiertes NULL in einer INSERT ... SELECT als `text`,
-- was gegen `uninstalledAt TIMESTAMP(3)` mit `42804` abbricht — auf JEDER
-- Datenbank, auf der diese Migration noch läuft. Auf bestehenden Installationen
-- fiel das nie auf, weil sie längst angewendet ist; eine FRISCHE Datenbank
-- (neuer Railway-Service, lokales Setup) kam damit nicht hoch.
--
-- `uninstalledAt` ist nullable und wird hier gar nicht gesetzt, also gehört es
-- nicht in die Spaltenliste. Das ist der ehrlichere Fix als ein NULL::timestamp:
-- es steht kein Wert drin, statt dass einer als NULL behauptet wird.
--
-- Die Prüfsumme dieser Datei ändert sich dadurch. Das ist gemessen unkritisch:
-- `prisma migrate deploy` verifiziert die Prüfsummen bereits angewendeter
-- Migrationen NICHT — es meldet "No pending migrations to apply" und wendet
-- nachfolgende Migrationen normal an (gegen Postgres 16 / Prisma 6.19 geprüft).
-- Nur `migrate dev` würde Drift monieren, und das läuft in keinem Deploy-Pfad.
INSERT INTO "ShopInstallState" ("shop", "initialSyncCompletedAt", "updatedAt")
SELECT DISTINCT p."shop", NOW(), NOW()
FROM "Product" p
LEFT JOIN "ShopInstallState" s ON s."shop" = p."shop"
WHERE s."shop" IS NULL;
