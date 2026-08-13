/**
 * Sync der Shopify-Bildbibliothek (MediaImage) in den lokalen Cache.
 *
 * Quelle ist `files(query: "media_type:IMAGE")` — dieselbe Feldform, die
 * app/routes/api.files.tsx in dieser API-Version (2025-10) benutzt:
 * `... on MediaImage { id alt image { url } mimeType }`. Nur MediaImage wird
 * übernommen; Video / Model3d / GenericFile haben keinen übersetzbaren
 * Alt-Text und sind für den Bulk-Editor irrelevant.
 *
 * Der Cache ergänzt `ProductImage` (Produktmedien, vom Produkt-Sync gepflegt)
 * um alles, was an keinem Produkt hängt. `ProductImage` wird hier nicht
 * angefasst — nur gelesen, um die Verwendung aufzulösen (usage.server.ts).
 *
 * VORAUSSETZUNG: `files()` braucht den Scope `read_files`. Derselbe Scope
 * trägt schon den Datei-Picker in app/routes/api.files.tsx — fehlt er in der
 * App-Installation, scheitern beide gleichermassen mit einem
 * Access-Denied-GraphQL-Fehler (der hier den Lauf abbricht, bevor irgendetwas
 * gelöscht wird). In [access_scopes] von shopify.app.prod.toml steht er nicht;
 * die Laufzeit-Scopes kommen aus SHOPIFY_SCOPES (app/shopify.server.ts:88).
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { PrismaClient } from "@prisma/client";
import { logger } from "~/utils/logger.server";
import { getPlanLimits, isValidPlan } from "~/utils/planUtils";
import { resolveMediaUsage, UNKNOWN_USAGE } from "./usage.server";

/** Shopify erlaubt maximal 250 Knoten pro Seite. */
const PAGE_SIZE = 250;
/**
 * Reissleine gegen eine endlose Paginierung (defekter Cursor, gigantische
 * Bibliothek): 200 Seiten ≈ 50 000 Bilder. Wird sie erreicht, gilt der Lauf als
 * UNVOLLSTÄNDIG — es wird dann nichts gelöscht.
 */
const MAX_PAGES = 200;
/**
 * Wie viele Upserts gleichzeitig laufen. Bewusst klein: db.server.ts setzt kein
 * `connection_limit`, der Prisma-Default-Pool ist entsprechend knapp, und ein
 * Lauf über eine grosse Bibliothek darf ihn nicht so weit belegen, dass andere
 * Requests in den pool_timeout (P2024) laufen.
 */
const UPSERT_CONCURRENCY = 5;
/** Wie viele IDs pro `in`-Filter — hält die Statements weit unter dem Postgres-Parameterlimit. */
const ID_CHUNK = 500;

const MEDIA_LIBRARY_QUERY = `#graphql
  query mediaLibraryImages($first: Int!, $after: String, $query: String) {
    files(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          __typename
          id
          alt
          createdAt
          ... on MediaImage {
            image { url }
            mimeType
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface FetchedImage {
  id: string;
  url: string;
  altText: string | null;
  filename: string;
  mimeType: string | null;
  createdAt: Date | null;
}

interface FilesNode {
  __typename?: string;
  id?: string;
  alt?: string | null;
  createdAt?: string | null;
  image?: { url?: string | null } | null;
  mimeType?: string | null;
}

/**
 * Antwortform der Query. Explizit annotiert, weil `after` aus der Antwort
 * stammt und gleichzeitig in die nächsten Variablen fliesst — ohne Annotation
 * dreht sich die Typinferenz im Kreis (TS7022).
 */
interface FilesQueryResponse {
  data?: {
    files?: {
      edges?: Array<{ node?: FilesNode }>;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    } | null;
  } | null;
  errors?: Array<{ message?: string }>;
}

/** Dateiname aus der CDN-URL, ohne Query-String ("" wenn nicht ableitbar). */
export function filenameFromUrl(url: string): string {
  const withoutQuery = url.split("?")[0] ?? "";
  const last = withoutQuery.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Paginiert die komplette Bildbibliothek durch.
 *
 * `complete: false` heisst: die Liste ist möglicherweise abgeschnitten (Seiten-
 * Limit erreicht) — der Aufrufer darf dann keine Stale-Deletes fahren. Ein
 * echter Fehler (Netzwerk / GraphQL) wirft, so dass der ganze Lauf abbricht,
 * bevor irgendetwas gelöscht wird.
 */
async function fetchAllImages(
  admin: AdminApiContext,
  shop: string,
): Promise<{ images: FetchedImage[]; skippedIds: string[]; complete: boolean }> {
  const images: FetchedImage[] = [];
  const skippedIds: string[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  let pages = 0;

  for (;;) {
    const response = await admin.graphql(MEDIA_LIBRARY_QUERY, {
      variables: { first: PAGE_SIZE, after, query: "media_type:IMAGE" },
    });
    const data = (await response.json()) as FilesQueryResponse;

    if (data?.errors?.length) {
      throw new Error(`GraphQL error in syncMediaLibrary: ${data.errors[0]?.message ?? "unknown"}`);
    }

    const files = data?.data?.files;

    // Antwort ohne `files`-Feld UND ohne errors-Array: kaputte/unerwartete
    // Form (z.B. Throttling-Teilantwort). Das darf NICHT als "Shopify hat
    // nichts mehr" durchgehen — sonst hielte der Sweep alle noch nicht
    // abgerufenen Bilder für gelöscht. Bereits Gesammeltes behalten, Lauf als
    // unvollständig melden.
    if (!files) {
      logger.warn(
        `[MediaLibrarySync] Response without a files payload — treating run as incomplete, no stale-delete`,
        { context: "MediaLibrarySync", shop, page: pages + 1 },
      );
      return { images, skippedIds, complete: false };
    }

    const edges: Array<{ node?: FilesNode }> = files.edges ?? [];

    for (const edge of edges) {
      const node = edge?.node;
      if (!node?.id || node.__typename !== "MediaImage") continue;
      if (seen.has(node.id)) continue;
      seen.add(node.id);

      // Bilder, die noch verarbeitet werden oder fehlgeschlagen sind, haben
      // keine URL. Ohne URL ist die Zeile für den Editor wertlos — sie wird
      // nicht geschrieben. Shopify kennt sie aber sehr wohl, deshalb wandern
      // sie nach `skippedIds` und werden vom Stale-Delete ausgenommen.
      const url = node.image?.url ?? "";
      if (!url) {
        skippedIds.push(node.id);
        continue;
      }

      images.push({
        id: node.id,
        url,
        altText: node.alt ?? null,
        filename: filenameFromUrl(url),
        mimeType: node.mimeType ?? null,
        createdAt: parseDate(node.createdAt),
      });
    }

    pages++;
    if (!files.pageInfo?.hasNextPage) return { images, skippedIds, complete: true };
    if (pages >= MAX_PAGES) {
      logger.warn(
        `[MediaLibrarySync] Page limit reached (${MAX_PAGES} pages) — treating run as incomplete, no stale-delete`,
        { context: "MediaLibrarySync", shop },
      );
      return { images, skippedIds, complete: false };
    }
    after = files.pageInfo.endCursor ?? null;
    // Kein Cursor trotz hasNextPage: nicht weiterblättern, aber auch nicht so
    // tun, als wäre die Liste vollständig — sonst löscht der Sweep echte Bilder.
    if (!after) return { images, skippedIds, complete: false };
  }
}

async function runInBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

/**
 * Vollständiger Sync der Bildbibliothek eines Shops.
 *
 * Ablauf:
 *  1. Plan-Gate (dasselbe Flag wie die Produktbilder: cacheEnabled.productImages).
 *  2. Alle MediaImages paginiert holen.
 *  3. Verwendung best effort auflösen (nur lokale Caches, keine Zusatzabfragen).
 *  4. Upsert pro Bild, mandantengetrennt über den (shop, id)-Compound-Key.
 *  5. Stale-Delete NUR nach einem vollständig durchgelaufenen Sync.
 *  6. Sync-Marker schreiben (Grundlage für `neverSynced` im Loader).
 *
 * Punkt 5 folgt dem Muster der Stale-Deletes in content-sync.service.ts: ein
 * abgebrochener oder abgeschnittener Lauf löscht nichts. Statt einer riesigen
 * `notIn`-Liste dient `lastSyncedAt < cutoff` als Kriterium — `cutoff` wird VOR
 * dem Abruf gesetzt, damit auch parallele Schreiber (z.B. ein künftiger
 * files/update-Webhook) nie versehentlich weggeräumt werden.
 */
async function runMediaLibrarySync(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
): Promise<{ synced: number; removed: number }> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  const rawPlan = settings?.subscriptionPlan ?? "free";
  const plan = isValidPlan(rawPlan) ? rawPlan : "free";

  if (!getPlanLimits(plan).cacheEnabled.productImages) {
    logger.debug(`[MediaLibrarySync] Skipped — image cache not enabled on plan "${plan}"`, {
      context: "MediaLibrarySync",
      shop,
    });
    return { synced: 0, removed: 0 };
  }

  const cutoff = new Date();
  const { images, skippedIds, complete } = await fetchAllImages(admin, shop);

  logger.debug(`[MediaLibrarySync] Fetched ${images.length} images (complete=${complete})`, {
    context: "MediaLibrarySync",
    shop,
  });

  // Health-Check: eine leere Antwort bei vorhandenen lokalen Zeilen ist weit
  // wahrscheinlicher eine Störung als ein leergeräumter Shop. Dann lieber gar
  // nichts tun, als den Cache zu löschen (Muster: content-sync.service.ts).
  if (images.length === 0 && skippedIds.length === 0) {
    const localCount = await db.mediaLibraryImage.count({ where: { shop } });
    if (localCount > 0) {
      logger.warn(
        `[MediaLibrarySync] Shopify returned 0 images but ${localCount} are cached — skipping delete`,
        { context: "MediaLibrarySync", shop },
      );
      return { synced: 0, removed: 0 };
    }
  }

  const usage = await resolveMediaUsage(db, shop, images.map((i) => i.id));

  let position = 0;
  const rows = images.map((image) => ({ image, position: position++ }));

  await runInBatches(rows, UPSERT_CONCURRENCY, async ({ image, position: pos }) => {
    const resolved = usage.get(image.id) ?? UNKNOWN_USAGE;
    const data = {
      url: image.url,
      altText: image.altText,
      filename: image.filename,
      mimeType: image.mimeType,
      position: pos,
      shopifyCreatedAt: image.createdAt,
      usageKind: resolved.kind,
      usageOwnerId: resolved.ownerId,
      usageLabel: resolved.label,
      lastSyncedAt: new Date(),
    };
    await db.mediaLibraryImage.upsert({
      where: { shop_id: { shop, id: image.id } },
      create: { id: image.id, shop, ...data },
      update: data,
    });
  });

  // Nur-gesehen-aber-nicht-geschrieben (keine URL): Zeitstempel anfassen, damit
  // der Sweep unten sie nicht für verschwunden hält. In Blöcken, damit die
  // `in`-Liste auch bei einem grossen laufenden Upload beschränkt bleibt.
  for (let i = 0; i < skippedIds.length; i += ID_CHUNK) {
    await db.mediaLibraryImage.updateMany({
      where: { shop, id: { in: skippedIds.slice(i, i + ID_CHUNK) } },
      data: { lastSyncedAt: new Date() },
    });
  }

  let removed = 0;
  if (complete) {
    const deleted = await db.mediaLibraryImage.deleteMany({
      where: { shop, lastSyncedAt: { lt: cutoff } },
    });
    removed = deleted.count;
    if (removed > 0) {
      logger.debug(`[MediaLibrarySync] 🗑️ Deleted ${removed} images that no longer exist in Shopify`, {
        context: "MediaLibrarySync",
        shop,
      });
    }
  }

  // Marker für `neverSynced`: gesetzt, sobald ein Lauf bis zum Ende gekommen
  // ist — auch wenn die Liste am Seitenlimit abgeschnitten wurde. Sonst bliebe
  // eine sehr grosse Bibliothek dauerhaft "nie synchronisiert", obwohl der
  // Editor längst Zeilen anzeigt. `truncated` hält fest, dass der Cache in dem
  // Fall unvollständig ist (und deshalb auch nicht stale-bereinigt wurde).
  const now = new Date();
  await db.mediaLibrarySyncState.upsert({
    where: { shop },
    create: { shop, lastSyncedAt: now, imageCount: images.length, truncated: !complete },
    update: { lastSyncedAt: now, imageCount: images.length, truncated: !complete },
  });

  logger.info(`[MediaLibrarySync] Complete`, {
    context: "MediaLibrarySync",
    shop,
    synced: images.length,
    removed,
    truncated: !complete,
  });

  return { synced: images.length, removed };
}

/**
 * Läuft pro Shop höchstens einmal gleichzeitig.
 *
 * Der Sync ist ein manueller Trigger; ein Doppelklick oder ein Browser-Retry
 * nach einer langen Antwortzeit würde sonst einen zweiten kompletten Durchlauf
 * starten (Shopify-Rate-Limit + doppelte Upserts). Der zweite Aufruf bekommt
 * stattdessen das Ergebnis des laufenden.
 *
 * Bewusst nur prozesslokal: das ist der Fall, der in der Praxis auftritt (ein
 * Merchant, ein Klick, eine Instanz). Ein instanzübergreifendes Lock wäre ein
 * eigener Mechanismus (DB-Lease) und ist hier nicht nötig — zwei parallele
 * Läufe wären wegen der idempotenten Upserts und des `cutoff`-vor-Abruf
 * korrekt, nur verschwenderisch.
 */
const inFlight = new Map<string, Promise<{ synced: number; removed: number }>>();

export function syncMediaLibrary(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
): Promise<{ synced: number; removed: number }> {
  const running = inFlight.get(shop);
  if (running) {
    logger.debug(`[MediaLibrarySync] Sync already running for this shop — joining it`, {
      context: "MediaLibrarySync",
      shop,
    });
    return running;
  }

  const run = runMediaLibrarySync(admin, db, shop).finally(() => {
    inFlight.delete(shop);
  });
  inFlight.set(shop, run);
  return run;
}
