-- Add persistent per-shop trial-consumption marker to AISettings.
-- Additive, nullable, no backfill: bestehende Shops gelten als "Trial noch nicht
-- konsumiert" (akzeptabel — sie haben höchstens eine aktive Sub; der Marker wird
-- beim nächsten verifizierten Trial-Aktivierungs-Sync gesetzt). Kein Datenverlust.
ALTER TABLE "AISettings" ADD COLUMN IF NOT EXISTS "trialConsumedAt" TIMESTAMP(3);
