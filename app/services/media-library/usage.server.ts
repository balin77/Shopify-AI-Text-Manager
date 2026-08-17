/**
 * Verwendungs-Auflösung für MediaImages ("wo wird dieses Bild benutzt?").
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WARUM DAS ÜBERHAUPT NÖTIG IST
 * ────────────────────────────────────────────────────────────────────────────
 * Shopifys `files()`-Query liefert die Datei, aber NICHT ihre Verwendung — es
 * gibt keine "usedIn"-Facette (derselbe Befund steht im Kommentar von
 * app/routes/api.files.tsx: die Datei-Bibliothek kennt keinen "wird verwendet
 * von"-Filter, deshalb schaltet der Picker dort auf product(id).media um).
 *
 * Diese Datei leitet die Verwendung deshalb aus LOKALEN Caches ab — ohne eine
 * einzige zusätzliche Shopify-Abfrage:
 *
 *   • `product`     ← ProductImage.mediaId (vom regulären Produkt-Sync
 *                     gepflegt) + Product.title als Label.
 *   • `metaobject`  ← Metaobject.fields (JSON-Cache des Metaobjekt-Syncs);
 *                     nur Felder vom Typ file_reference / list.file_reference,
 *                     deren Wert eine MediaImage-GID ist.
 *
 * Alles andere bleibt bewusst `unknown`:
 *   • collection / article / page — Kollektions- und Artikel-Titelbilder haben
 *     eigene GID-Typen (…/CollectionImage/…, …/ArticleImage/…) und sind gar
 *     keine MediaImages; Bilder in Rich-Text-Bodies stehen dort nur als
 *     CDN-<img src>, und eine URL-Heuristik wäre genau das Raten, das hier
 *     verboten ist.
 *   • theme — Theme-Settings referenzieren Bilder als `shopify://shop_images/…`,
 *     nicht als MediaImage-GID; nicht ohne Zusatzabfragen auflösbar.
 *   • unused — Nicht-Verwendung ist mit den vorhandenen Daten NICHT beweisbar
 *     (ein Bild kann in einem nicht gecachten Theme/Metaobjekt hängen). Ein
 *     falsches "unused" wäre die gefährlichste Falschaussage von allen, deshalb
 *     wird dieser Wert nie vergeben.
 *
 * Grundregel: ein ehrliches `unknown` ist besser als eine falsche Zuordnung.
 */

import type { PrismaClient } from "@prisma/client";
import type { MediaImageUsageKind } from "./load.server";

export interface MediaUsage {
  kind: MediaImageUsageKind;
  /** GID des Besitzers, "" wenn unbekannt oder mehrdeutig. */
  ownerId: string;
  /** Anzeigename des Besitzers, "" wenn unbekannt oder mehrdeutig. */
  label: string;
}

export const UNKNOWN_USAGE: MediaUsage = { kind: "unknown", ownerId: "", label: "" };

/** Wie viele IDs pro `in`-Filter — hält die SQL-Statements handhabbar. */
const ID_CHUNK = 500;

/** Seitengrösse beim Durchsehen des Metaobjekt-Caches (JSON-Spalte `fields`). */
const METAOBJECT_PAGE = 500;

const MEDIA_IMAGE_GID = /^gid:\/\/shopify\/MediaImage\/\d+$/;

export function isMediaImageGid(value: unknown): value is string {
  return typeof value === "string" && MEDIA_IMAGE_GID.test(value);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Sammelt Besitzer pro MediaImage-GID. Mehrere Besitzer werden bewusst NICHT
 * zu einem "Gewinner" verdichtet — siehe {@link finalizeOwners}.
 */
type OwnerIndex = Map<string, Map<string, string>>; // mediaId → (ownerId → label)

function addOwner(index: OwnerIndex, mediaId: string, ownerId: string, label: string): void {
  let owners = index.get(mediaId);
  if (!owners) {
    owners = new Map();
    index.set(mediaId, owners);
  }
  owners.set(ownerId, label);
}

/**
 * Verdichtet die Besitzer eines Bildes zu genau einer Aussage.
 *
 * Genau ein Besitzer  → kind + ownerId + label (der Normalfall).
 * Mehrere Besitzer    → kind bleibt (DASS es z.B. Produktmedium ist, steht
 *                       fest), ownerId/label werden aber leer gelassen. Einen
 *                       der Besitzer herauszupicken würde dem Merchant ein
 *                       konkretes, möglicherweise falsches Produkt anzeigen.
 */
function finalizeOwners(kind: MediaImageUsageKind, owners: Map<string, string>): MediaUsage {
  if (owners.size === 1) {
    const [ownerId, label] = [...owners.entries()][0];
    return { kind, ownerId, label: label || "" };
  }
  return { kind, ownerId: "", label: "" };
}

/**
 * Produktverwendung aus dem ProductImage-Cache.
 *
 * `ProductImage` hat keine eigene shop-Spalte — die Mandantentrennung läuft
 * über die Relation (`product: { shop }`), exakt wie in planCacheCleanup.
 */
export async function collectProductUsage(
  db: Pick<PrismaClient, "productImage">,
  shop: string,
  mediaIds: string[],
): Promise<OwnerIndex> {
  const index: OwnerIndex = new Map();
  if (mediaIds.length === 0) return index;

  for (const ids of chunk(mediaIds, ID_CHUNK)) {
    const rows = await db.productImage.findMany({
      where: { mediaId: { in: ids }, product: { shop } },
      select: { mediaId: true, product: { select: { id: true, title: true } } },
    });
    for (const row of rows) {
      if (!row.mediaId || !row.product) continue;
      addOwner(index, row.mediaId, row.product.id, row.product.title ?? "");
    }
  }
  return index;
}

interface MetaobjectField {
  key?: unknown;
  value?: unknown;
  type?: unknown;
}

/**
 * Zieht alle MediaImage-GIDs aus EINEM Metaobjekt-Feldsatz.
 *
 * Nur Felder, deren `type` file_reference / list.file_reference ist, werden
 * angefasst — ein beliebiges Textfeld, das zufällig wie eine GID aussieht,
 * zählt nicht. Listenfelder speichern ihre Referenzen als JSON-Array-String.
 */
export function extractFileReferenceGids(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];

  const gids: string[] = [];
  for (const raw of fields as MetaobjectField[]) {
    if (!raw || typeof raw !== "object") continue;
    const type = typeof raw.type === "string" ? raw.type : "";
    if (!type.includes("file_reference")) continue;

    const value = raw.value;
    if (typeof value !== "string" || value === "") continue;

    // list.file_reference → '["gid://shopify/MediaImage/1", …]'
    if (value.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) if (isMediaImageGid(entry)) gids.push(entry);
        }
      } catch {
        // Kein gültiges JSON → keine Aussage möglich, Bild bleibt "unknown".
      }
      continue;
    }

    if (isMediaImageGid(value)) gids.push(value);
  }
  return gids;
}

/**
 * Metaobjekt-Verwendung aus dem lokalen Metaobjekt-Cache (Json-Spalte `fields`).
 * Kostet keine Shopify-Abfrage; ist der Metaobjekt-Cache leer (Plan ohne
 * Metaobjekte oder noch nie synchronisiert), bleibt das Ergebnis einfach leer.
 */
export async function collectMetaobjectUsage(
  db: Pick<PrismaClient, "metaobject">,
  shop: string,
  wanted: Set<string>,
): Promise<OwnerIndex> {
  const index: OwnerIndex = new Map();
  if (wanted.size === 0) return index;

  // Seitenweise statt in einem Rutsch: `fields` ist eine JSON-Spalte, die pro
  // Metaobjekt beliebig gross sein kann — ein Shop mit vielen Metaobjekten
  // sonst der ganze Cache gleichzeitig im Heap. Cursor-Paginierung über die
  // (stabile) id, damit kein Eintrag doppelt oder gar nicht gesehen wird.
  let cursor: string | undefined;
  for (;;) {
    const batch = await db.metaobject.findMany({
      where: { shop },
      select: { id: true, displayName: true, fields: true },
      orderBy: { id: "asc" },
      take: METAOBJECT_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) return index;

    for (const mo of batch) {
      for (const gid of extractFileReferenceGids(mo.fields)) {
        if (!wanted.has(gid)) continue;
        addOwner(index, gid, mo.id, mo.displayName ?? "");
      }
    }

    if (batch.length < METAOBJECT_PAGE) return index;
    cursor = batch[batch.length - 1].id;
  }
}

/**
 * Auflösung für einen ganzen Sync-Lauf.
 *
 * Priorität bei Mehrfachverwendung: `product` schlägt `metaobject`. Produktmedien
 * sind die stärkste Aussage (eigener First-Class-Sync, Titel als Label) und der
 * Bulk-Editor filtert genau darauf (`excludeProductMedia`), also darf ein
 * zusätzlicher Metaobjekt-Treffer sie nicht überschreiben.
 *
 * Bilder ohne Treffer tauchen im Ergebnis NICHT auf — der Aufrufer setzt dafür
 * {@link UNKNOWN_USAGE}.
 */
export async function resolveMediaUsage(
  db: Pick<PrismaClient, "productImage" | "metaobject">,
  shop: string,
  mediaIds: string[],
): Promise<Map<string, MediaUsage>> {
  const resolved = new Map<string, MediaUsage>();
  if (mediaIds.length === 0) return resolved;

  const productOwners = await collectProductUsage(db, shop, mediaIds);
  for (const [mediaId, owners] of productOwners) {
    resolved.set(mediaId, finalizeOwners("product", owners));
  }

  const stillOpen = new Set(mediaIds.filter((id) => !resolved.has(id)));
  const metaobjectOwners = await collectMetaobjectUsage(db, shop, stillOpen);
  for (const [mediaId, owners] of metaobjectOwners) {
    resolved.set(mediaId, finalizeOwners("metaobject", owners));
  }

  return resolved;
}
