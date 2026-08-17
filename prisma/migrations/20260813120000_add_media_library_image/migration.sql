-- Media-Bibliothek (Shopify Files) Cache für den Bulk-Editor.
--
-- Rein additiv: zwei neue Tabellen, keine bestehende Tabelle wird angefasst.
-- `ProductImage` (Produktmedien-Cache des Produkt-Syncs) bleibt unverändert —
-- MediaLibraryImage deckt die Bilder ab, die an keinem Produkt hängen.
--
-- Idempotent (IF NOT EXISTS durchgehend), damit ein erneuter Lauf auf einer
-- bereits migrierten Datenbank folgenlos ist.

-- 1. Bild-Cache. `id` ist die MediaImage-GID (zugleich Übersetzungs-Ressource);
--    zusätzlich (shop, id) UNIQUE, damit jede Schreib-/Leseoperation
--    mandantengetrennt über den Compound-Key laufen kann.
CREATE TABLE IF NOT EXISTS "MediaLibraryImage" (
  "id"               TEXT NOT NULL,
  "shop"             TEXT NOT NULL,
  "url"              TEXT NOT NULL,
  "altText"          TEXT,
  "filename"         TEXT NOT NULL DEFAULT '',
  "mimeType"         TEXT,
  "position"         INTEGER NOT NULL DEFAULT 0,
  "shopifyCreatedAt" TIMESTAMP(3),
  "usageKind"        TEXT NOT NULL DEFAULT 'unknown',
  "usageOwnerId"     TEXT NOT NULL DEFAULT '',
  "usageLabel"       TEXT NOT NULL DEFAULT '',
  "lastSyncedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MediaLibraryImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MediaLibraryImage_shop_id_key"
  ON "MediaLibraryImage" ("shop", "id");

CREATE INDEX IF NOT EXISTS "MediaLibraryImage_shop_idx"
  ON "MediaLibraryImage" ("shop");

-- Trägt den usageKind-Filter des Bulk-Editors (z.B. "alles ausser Produktmedien").
CREATE INDEX IF NOT EXISTS "MediaLibraryImage_shop_usageKind_idx"
  ON "MediaLibraryImage" ("shop", "usageKind");

-- Trägt die Default-Sortierung (Sync-Reihenfolge = neueste zuerst).
CREATE INDEX IF NOT EXISTS "MediaLibraryImage_shop_position_idx"
  ON "MediaLibraryImage" ("shop", "position");

-- 2. Sync-Marker: unterscheidet "Shop hat keine Bilder" von "nie synchronisiert".
--    `truncated` markiert einen Cache, der am Seitenlimit abgeschnitten wurde.
CREATE TABLE IF NOT EXISTS "MediaLibrarySyncState" (
  "shop"         TEXT NOT NULL,
  "lastSyncedAt" TIMESTAMP(3) NOT NULL,
  "imageCount"   INTEGER NOT NULL DEFAULT 0,
  "truncated"    BOOLEAN NOT NULL DEFAULT false,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MediaLibrarySyncState_pkey" PRIMARY KEY ("shop")
);
