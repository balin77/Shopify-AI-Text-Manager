/**
 * Lesepfad für die Bildbibliothek des Shops (MediaImage-Cache).
 *
 * Der Bulk-Editor zeigt Bilder mit übersetzbarem Alt-Text an. Produktmedien
 * kommen aus dem Produkt-Cache (`ProductImage`); ALLE übrigen Bilder des Shops
 * — Dateien-Bibliothek, Metaobjekt-Referenzen, Theme-Bilder — kommen aus
 * diesem Cache (`MediaLibraryImage`, gefüllt von sync.server.ts).
 *
 * Diese Datei liest ausschliesslich. Das Schreiben von Alt-Texten und deren
 * Übersetzungen gehört NICHT hierher.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

export type MediaImageUsageKind =
  | "product" | "collection" | "article" | "page"
  | "metaobject" | "theme" | "unused" | "unknown";

export interface MediaLibraryImageRow {
  /** gid://shopify/MediaImage/… — zugleich die Übersetzungs-Ressource. */
  mediaId: string;
  url: string;
  /** Primärsprachlicher Alt-Text, "" wenn nicht gesetzt. */
  altText: string;
  /** Dateiname ohne Query-String, "" wenn unbekannt. */
  filename: string;
  /** Wo das Bild verwendet wird — best effort, siehe unten. */
  usageKind: MediaImageUsageKind;
  /** GID des Besitzers, "" wenn unbekannt. */
  usageOwnerId: string;
  /** Anzeigename des Besitzers ("Vase Ascera"), "" wenn unbekannt. */
  usageLabel: string;
}

export interface LoadMediaLibraryOptions {
  search: string;
  skip: number;
  take: number;
  /** true = Bilder überspringen, für die es eine ProductImage-Zeile gibt —
   *  die lädt der Bulk-Editor aus dem Produkt-Cache. */
  excludeProductMedia: boolean;
  /** nur Bilder ohne primären Alt-Text. */
  missingAltOnly?: boolean;
  /** Nur Bilder EINES Besitzers (GID eines Produkts, einer Kollektion …). */
  ownerId?: string;
  /** Nur diese MediaImage-GIDs (CSV-Import löst Zeilen über ihre id auf). */
  mediaIds?: string[];
  /**
   * Diese GIDs auslassen. Der Bulk-Editor braucht das, um exakt zu bleiben:
   * ein Nachfiltern der geladenen SEITE würde `total` überzählen und die
   * Export-/Scan-Schleifen zu früh abbrechen lassen.
   */
  excludeMediaIds?: string[];
  /** Sortierung; ohne Angabe die Sync-Reihenfolge (neueste zuerst). */
  sort?: { field: "altText" | "filename" | "usageLabel"; direction: "asc" | "desc" };
}

/** Obergrenze pro Seite — schützt vor einem `take=100000` aus der Query-String. */
const MAX_TAKE = 250;

const USAGE_KINDS: readonly MediaImageUsageKind[] = [
  "product", "collection", "article", "page",
  "metaobject", "theme", "unused", "unknown",
];

/**
 * Die usageKind-Spalte ist ein String (flach, filter- und sortierbar). Beim
 * Lesen wird sie auf das Union zurückgeführt; ein unbekannter Wert (z.B. aus
 * einer künftigen Sync-Version) wird zu "unknown" statt den Typ zu brechen.
 */
export function toUsageKind(value: string): MediaImageUsageKind {
  return (USAGE_KINDS as readonly string[]).includes(value)
    ? (value as MediaImageUsageKind)
    : "unknown";
}

/**
 * Lädt eine Seite der Bildbibliothek aus dem lokalen Cache.
 *
 * `neverSynced: true` heisst: für diesen Shop ist noch NIE ein Media-Sync bis
 * zum Ende gelaufen (kein MediaLibrarySyncState-Marker). Nur so ist "der Shop
 * hat keine Bilder" von "wir haben noch nicht geschaut" zu unterscheiden —
 * beide liefern sonst `total: 0`.
 *
 * Mandantentrennung: jede Query filtert auf `shop`, ohne Ausnahme.
 */
export async function loadMediaLibraryImages(
  db: PrismaClient,
  shop: string,
  opts: LoadMediaLibraryOptions,
): Promise<{ rows: MediaLibraryImageRow[]; total: number; neverSynced: boolean }> {
  const take = Math.min(Math.max(Math.trunc(opts.take) || 0, 0), MAX_TAKE);
  const skip = Math.max(Math.trunc(opts.skip) || 0, 0);

  const and: Prisma.MediaLibraryImageWhereInput[] = [];

  if (opts.excludeProductMedia) {
    // Filtert auf der flachen usageKind-Spalte (indiziert) statt über eine
    // ID-Liste aus ProductImage — genau dafür ist die Spalte da. Sie wird bei
    // jedem Media-Sync neu aufgelöst; ein Bild, das SEIT dem letzten Media-Sync
    // an ein Produkt gehängt wurde, gilt bis zum nächsten Lauf noch nicht als
    // Produktmedium.
    and.push({ usageKind: { not: "product" } });
  }

  if (opts.missingAltOnly) {
    and.push({ OR: [{ altText: null }, { altText: "" }] });
  }

  // Nur die Bilder EINES Objekts (Produkt, Kollektion, …). usageOwnerId wird
  // beim Media-Sync aufgelöst und ist "" wenn unbekannt oder mehrdeutig — ein
  // Filter darauf liefert dann korrekterweise nichts.
  if (opts.ownerId) and.push({ usageOwnerId: opts.ownerId });

  if (opts.mediaIds) and.push({ id: { in: opts.mediaIds } });
  if (opts.excludeMediaIds && opts.excludeMediaIds.length > 0) {
    and.push({ id: { notIn: opts.excludeMediaIds } });
  }

  const search = opts.search.trim();
  if (search) {
    and.push({
      OR: [
        { filename: { contains: search, mode: "insensitive" } },
        { altText: { contains: search, mode: "insensitive" } },
        { usageLabel: { contains: search, mode: "insensitive" } },
      ],
    });
  }

  const where: Prisma.MediaLibraryImageWhereInput = { shop, ...(and.length ? { AND: and } : {}) };

  const [records, total, syncState] = await Promise.all([
    take === 0
      ? Promise.resolve([])
      : db.mediaLibraryImage.findMany({
          where,
          // position stammt aus der Sync-Reihenfolge (neueste zuerst); id als
          // Tiebreaker, damit Paginierung deterministisch bleibt.
          orderBy: opts.sort
            ? [{ [opts.sort.field]: opts.sort.direction }, { id: "asc" }]
            : [{ position: "asc" }, { id: "asc" }],
          skip,
          take,
          select: {
            id: true,
            url: true,
            altText: true,
            filename: true,
            usageKind: true,
            usageOwnerId: true,
            usageLabel: true,
          },
        }),
    db.mediaLibraryImage.count({ where }),
    db.mediaLibrarySyncState.findUnique({ where: { shop }, select: { lastSyncedAt: true } }),
  ]);

  const rows: MediaLibraryImageRow[] = records.map((r) => ({
    mediaId: r.id,
    url: r.url,
    altText: r.altText ?? "",
    filename: r.filename ?? "",
    usageKind: toUsageKind(r.usageKind),
    usageOwnerId: r.usageOwnerId ?? "",
    usageLabel: r.usageLabel ?? "",
  }));

  return { rows, total, neverSynced: syncState === null };
}
