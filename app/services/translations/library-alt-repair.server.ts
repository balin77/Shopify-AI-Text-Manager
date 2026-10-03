/**
 * What a changed PRIMARY alt text of a media-LIBRARY image does to its foreign
 * translations: they are DELETED.
 *
 * A library image is a file with NO `ProductImage` row (e.g. a file picked into
 * a variant gallery). Its alt is written through `fileUpdate` by the image
 * manager's per-image save (`saveImageAltTextPrimary`, also the SEO performance
 * page's generator), the SKU generator and the alt-text template apply. None of
 * them touched its translations, so they went on describing text that no longer
 * exists, on the storefront and in every editor. (The bulk editor's library
 * rows already invalidate through its generic §6.6 path.) A library file has no
 * product to hang a re-translation run on, so the answer is the owner's
 * decision: delete.
 *
 * - Whether to delete is the merchant's setting, asked the way every
 *   UNRECONCILED surface asks it: `isPurgeOnPrimaryChangeEnabled(..., { reconciled: false })`.
 *   Switched off, the translations are kept.
 * - Only a CHANGED alt counts (trimmed, against the cache as it stood BEFORE the
 *   write -- `snapshotLibraryAlts` must run first). An image the cache does not
 *   know has no "before", so nothing is deleted for it.
 * - On Shopify the removal is ECHO-VERIFIED through the shared helpers
 *   (`removeAndVerifyAcrossLocales`, then the single-locale re-read for a local
 *   row the echo skipped); this module sends no mutation of its own. The MARKET
 *   layer goes through `purgeMarketOverrides`.
 * - A local `ContentTranslation("MediaImage")` row is deleted only for a
 *   confirmed removal.
 * - It never throws: every caller runs after a write that already succeeded.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger.server";
import type { ShopifyApiGateway } from "../shopify-api-gateway.service";

export interface LibraryAltSnapshotEntry {
  altText: string | null;
}

/**
 * Is this MediaImage a media-LIBRARY file: no `ProductImage` row anywhere in
 * the shop AND a library cache row that does not say "product" (a "product"
 * row is a product medium whose ProductImage row is merely missing). Unknown
 * to both caches is NOT library -- the caller keeps the product behaviour.
 * The ONE answer for "which store owns this image's alt"; throws on a DB error.
 */
export async function isLibraryOnlyMedia(
  db: Pick<PrismaClient, "productImage" | "mediaLibraryImage">,
  shop: string,
  mediaId: string,
): Promise<boolean> {
  const productRow = await db.productImage.findFirst({
    where: { mediaId, product: { shop } },
    select: { id: true },
  });
  if (productRow) return false;
  const lib = await db.mediaLibraryImage.findFirst({
    where: { shop, id: mediaId },
    select: { usageKind: true },
  });
  return !!lib && (lib as { usageKind?: string | null }).usageKind !== "product";
}

/**
 * The alts of the LIBRARY images among `mediaIds` as the cache holds them,
 * read BEFORE the write (every alt path updates the cache itself). An image
 * with a `ProductImage` row anywhere in the shop is a product medium and is
 * left to `product-alt-repair`. A failed read is an empty map: nothing is
 * deleted.
 */
export async function snapshotLibraryAlts(
  db: PrismaClient,
  shop: string,
  mediaIds: readonly string[],
): Promise<Map<string, LibraryAltSnapshotEntry>> {
  const out = new Map<string, LibraryAltSnapshotEntry>();
  const wanted = [...new Set(mediaIds.filter(Boolean))];
  if (wanted.length === 0) return out;
  try {
    const [library, productBacked] = await Promise.all([
      db.mediaLibraryImage.findMany({
        where: { shop, id: { in: wanted } },
        select: { id: true, altText: true, usageKind: true },
      }),
      db.productImage.findMany({
        where: { mediaId: { in: wanted }, product: { shop } },
        select: { mediaId: true },
      }),
    ]);
    const product = new Set(
      (productBacked as Array<{ mediaId: string | null }>).map((r) => r.mediaId).filter((id): id is string => !!id),
    );
    // Only a file PROVABLY outside the catalogue counts: a cache row that says
    // "product" (product not cached yet, failed sync) is a product medium whose
    // ProductImage row is merely missing, and is left alone.
    for (const row of library as Array<{ id: string; altText: string | null; usageKind?: string | null }>) {
      if (row.usageKind === "product") continue;
      if (!product.has(row.id)) out.set(row.id, { altText: row.altText });
    }
  } catch (error: unknown) {
    logger.warn("[LibraryAltRepair] Could not read the library alts before the write - nothing is deleted", {
      context: "LibraryAltRepair",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return out;
}

/**
 * Delete the foreign alt translations of the library images whose primary alt
 * CHANGED. Returns the media ids whose translations were really removed (the
 * client re-reads those), never throws.
 */
export async function purgeLibraryAltTranslationsAfterWrite(params: {
  gateway: ShopifyApiGateway;
  db: PrismaClient;
  shop: string;
  snapshot: ReadonlyMap<string, LibraryAltSnapshotEntry>;
  /** What was WRITTEN (Shopify's echo where the mutation returns one). */
  written: ReadonlyArray<{ mediaId: string; alt: string }>;
}): Promise<string[]> {
  const { gateway, db, shop, snapshot } = params;
  const purgedMedia: string[] = [];
  try {
    const changed = new Map<string, string>();
    for (const { mediaId, alt } of params.written) {
      const before = snapshot.get(mediaId);
      if (!before || (before.altText ?? "").trim() === alt.trim()) continue;
      changed.set(mediaId, alt);
    }
    if (changed.size === 0) return [];

    const { isPurgeOnPrimaryChangeEnabled } = await import("./translation-change-policy.server");
    if (!(await isPurgeOnPrimaryChangeEnabled(shop, db, { reconciled: false }))) {
      logger.info("[LibraryAltRepair] Primary alt changed, translations kept (deletion switched off)", {
        context: "LibraryAltRepair",
        shop,
        count: changed.size,
      });
      return [];
    }

    const [{ fetchShopLocales }, { translationForeignLocales }] = await Promise.all([
      import("../sync-utils"),
      import("./stale-translations.shared"),
    ]);
    const locales = await fetchShopLocales(gateway.graphql.bind(gateway));
    const foreignLocales = translationForeignLocales(locales);
    // An empty list is a failed lookup or a single-language shop: either way
    // there is nothing this can address.
    if (foreignLocales.length === 0) return [];

    const [
      { purgeMarketOverrides },
      { contentTranslationMirror },
      { removeAndVerify, removeAndVerifyAcrossLocales, LOCALE_KEY_SEP },
    ] = await Promise.all([
      import("./market-layer-purge.server"),
      import("./stale-translation-sync.server"),
      import("./verified-translations.server"),
    ]);

    for (const mediaId of changed.keys()) {
      try {
        // The MARKET overrides: nothing re-translates one.
        const marketRemoved = await purgeMarketOverrides({
          gateway,
          mirror: contentTranslationMirror(shop),
          refs: [{ resourceId: mediaId, resourceType: "MediaImage" }],
          locales: foreignLocales,
          keys: ["alt"],
          context: "libraryAlt",
        });

        // The GLOBAL layer: echo first, then the re-read for a local row the
        // echo skipped (a row Shopify never held is "gone" there).
        const confirmed = new Set<string>();
        const across = await removeAndVerifyAcrossLocales(gateway, mediaId, ["alt"], [...foreignLocales], "");
        for (const locale of foreignLocales) {
          if (across.confirmedPairs.has(`${locale}${LOCALE_KEY_SEP}alt`)) confirmed.add(locale);
        }
        const localRows = await db.contentTranslation.findMany({
          where: {
            shop,
            resourceType: "MediaImage",
            resourceId: mediaId,
            key: "alt",
            marketId: "",
            locale: { in: [...foreignLocales] },
          },
          select: { locale: true },
        });
        const localLocales = [...new Set((localRows as Array<{ locale: string }>).map((r) => r.locale))];
        for (const locale of localLocales) {
          if (confirmed.has(locale)) continue;
          try {
            const single = await removeAndVerify(gateway, mediaId, ["alt"], locale, "");
            if (single.confirmedKeys.has("alt")) confirmed.add(locale);
          } catch {
            // Unconfirmed: the local row stays; the next look corrects it.
          }
        }
        if (confirmed.size > 0) {
          await db.contentTranslation.deleteMany({
            where: {
              shop,
              resourceType: "MediaImage",
              resourceId: mediaId,
              key: "alt",
              marketId: "",
              locale: { in: [...confirmed] },
            },
          });
        }
        // The client re-reads where either layer lost rows.
        if (confirmed.size > 0 || (marketRemoved ?? 0) > 0) purgedMedia.push(mediaId);
      } catch (error: unknown) {
        logger.warn("[LibraryAltRepair] Removing the alt translations of a library image failed - they stay", {
          context: "LibraryAltRepair",
          shop,
          mediaId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error: unknown) {
    logger.warn("[LibraryAltRepair] Library alt translation purge skipped", {
      context: "LibraryAltRepair",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return purgedMedia;
}
