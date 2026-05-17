-- Server-side initial-sync progress columns on ShopInstallState.
-- Additiv/idempotent. Alle nullable (Abwesenheit = "kein laufender Initial-Sync");
-- initialSyncForceRequested mit Default false. Kein Backfill nötig: bestehende
-- Shops haben initialSyncCompletedAt bereits gesetzt (vorherige Migration) und
-- laufen damit auf dem inkrementellen Pfad — diese Spalten bleiben für sie leer.
ALTER TABLE "ShopInstallState"
  ADD COLUMN IF NOT EXISTS "initialSyncStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "initialSyncPhase" TEXT,
  ADD COLUMN IF NOT EXISTS "initialSyncPercent" INTEGER,
  ADD COLUMN IF NOT EXISTS "initialSyncStats" JSONB,
  ADD COLUMN IF NOT EXISTS "initialSyncError" TEXT,
  ADD COLUMN IF NOT EXISTS "initialSyncForceRequested" BOOLEAN NOT NULL DEFAULT false;
