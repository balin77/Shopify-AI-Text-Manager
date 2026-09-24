/**
 * What a changed PRIMARY alt text of a product medium does to its foreign
 * translations — the ONE implementation both alt-text save paths call.
 *
 * There used to be exactly one of them: the product editor's save
 * (`updatePrimaryProduct`) purged or re-translated the alt translations of the
 * images whose primary alt it wrote, while the image manager's per-image save
 * (`saveImageAltText`, alt-text.action.ts) wrote the alt through `fileUpdate`
 * and did NOTHING else — no re-translation with auto-translate on, no deletion
 * with it off. An alt edited there stayed untranslated in every language, and a
 * stale translation of the old alt stayed live on the storefront. Alt texts sit
 * outside every webhook and sweep this app has, so the save IS the only moment
 * anything can know (CLAUDE.md, "A webhook-less type is repaired by its own
 * SAVE, or by nothing at all").
 *
 * Two answers, decided by the merchant's policy exactly as before:
 *  - auto-translate on (and a known primary locale + foreign locales): the
 *    detached repair RE-TRANSLATES the new alt into every foreign locale —
 *    filling locales that never held a translation, which is the case a
 *    merchant saw failing;
 *  - otherwise the stored "delete on primary change" answer for unreconciled
 *    surfaces decides whether the now-stale translations are removed.
 *
 * Never throws: every caller runs after a primary write that already
 * succeeded, and answering a translation problem with "save failed" invites a
 * re-save that repeats the write.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger.server";
import type { ShopifyApiGateway } from "../shopify-api-gateway.service";
import type { TranslationChangePolicy } from "./translation-change-policy.server";
import { markTranslationSaved } from "../../utils/translation-save-lock.server";
import { altTextLockId, altTextSyncShieldId, mediaAltLockId } from "./translation-locks.shared";

export interface ProductAltChange {
  /** The ProductImage CACHE row — only for the local delete of the purge. */
  imageId: string;
  /** The MediaImage GID; `null` when the cache never learned it. */
  mediaId: string | null;
  /** What the save WROTE (Shopify's echo where there is one). */
  alt?: string;
}

export interface ProductAltRepairParams {
  gateway: ShopifyApiGateway;
  db: PrismaClient;
  shop: string;
  productId: string;
  productTitle: string;
  changes: readonly ProductAltChange[];
  policy: TranslationChangePolicy;
  /** Every foreign locale translations are kept for (published or not). */
  foreignLocales: readonly string[];
  primaryLocale: string;
  /**
   * The repair's lock. Defaults to the product-wide `altTextLockId` (one save
   * over several images — the product editor); a PER-IMAGE save passes
   * `mediaAltLockId`, or each save's claim aborts the previous image's run.
   */
  lockId?: string;
}

/** Whether this policy + locale state re-translates rather than purges. */
export function altRepairRetranslates(
  policy: TranslationChangePolicy | null | undefined,
  foreignLocales: readonly string[],
  primaryLocale: string,
): boolean {
  return !!policy?.autoTranslateExternalChanges && foreignLocales.length > 0 && !!primaryLocale;
}

export async function repairChangedProductAlts(params: ProductAltRepairParams): Promise<{ taskId?: string }> {
  const { gateway, db, shop, productId, policy, foreignLocales, primaryLocale } = params;
  const changes = params.changes;
  if (changes.length === 0) return {};

  const retranslate = altRepairRetranslates(policy, foreignLocales, primaryLocale);
  const purge = retranslate ? policy.purgeOnPrimaryChange : policy.purgeUnreconciledSurfaces;
  if (!retranslate && !purge) return {};
  // The product sync's shield — watched by no repair, so marking it never
  // aborts a sibling run (translation-locks.shared.ts).
  markTranslationSaved(altTextSyncShieldId(productId));

  if (purge && foreignLocales.length > 0) {
    await purgeAltTranslations(params);
  }

  if (!retranslate) return {};

  try {
    // A cached image with no `mediaId` has no Shopify resource to address at
    // all, so it is a DECLINE, not a failure, and it follows the merchant's
    // stored answer like every other declined entry.
    const unaddressable = changes.filter((c) => !c.mediaId).map((c) => c.imageId);
    if (unaddressable.length > 0 && policy.purgeUnreconciledSurfaces) {
      await db.productImageAltTranslation.deleteMany({
        where: { imageId: { in: unaddressable }, marketId: "", locale: { in: [...foreignLocales] } },
      });
    }

    const byMedia = new Map<string, string | undefined>();
    for (const change of changes) if (change.mediaId) byMedia.set(change.mediaId, change.alt);
    if (byMedia.size === 0) return {};

    const { reconcileAfterPrimarySave, productImageAltMirror } = await import("./stale-translation-sync.server");
    const outcome = await reconcileAfterPrimarySave({
      client: gateway,
      shop,
      resourceId: productId,
      resourceType: "Product",
      // The Task row stays on the PRODUCT; the lock does not. Claiming the
      // product here would make the `products/update` webhook's field
      // reconciliation bail for 30 seconds, and with auto-translate on that
      // leaves the title's translations neither purged nor refreshed.
      lockId: params.lockId ?? altTextLockId(productId),
      contentKind: "product",
      resourceTitle: params.productTitle || productId,
      changed: [...byMedia.entries()].map(([mediaId, alt]) => ({
        resourceId: mediaId,
        resourceType: "MediaImage",
        key: "alt",
        // An alt that was EMPTY before has no translatable entry until Shopify
        // has indexed the new one — the read-back is checked against this.
        ...(typeof alt === "string" ? { expectedValue: alt } : {}),
      })),
      foreignLocales: [...foreignLocales],
      policy,
      // (shop, product) rather than captured cache-row ids: `syncProduct`
      // recreates every ProductImage row, and this save's own
      // `products/update` webhook triggers one while the detached run works.
      mirror: productImageAltMirror(shop, productId),
      translateAs: { kind: "values", context: "product image alt texts", sourceLocale: primaryLocale },
    });
    return outcome.taskId ? { taskId: outcome.taskId } : {};
  } catch (error: unknown) {
    logger.warn("[AltRepair] Alt-text re-translation failed — translations kept", {
      context: "AltRepair",
      shop,
      productId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

async function purgeAltTranslations(params: ProductAltRepairParams): Promise<void> {
  const { gateway, db, shop, productId, foreignLocales, changes } = params;
  try {
    const mediaIds = [...new Set(changes.map((c) => c.mediaId).filter((id): id is string => !!id))];

    // The MARKET overrides first: nothing re-translates one, and an alt text
    // sits outside every webhook this app listens to.
    if (mediaIds.length > 0) {
      try {
        const { purgeMarketOverrides } = await import("./market-layer-purge.server");
        const { productImageAltMirror } = await import("./stale-translation-sync.server");
        await purgeMarketOverrides({
          gateway,
          mirror: productImageAltMirror(shop, productId),
          refs: mediaIds.map((mediaId) => ({ resourceId: mediaId, resourceType: "MediaImage" })),
          locales: foreignLocales,
          keys: ["alt"],
          context: "altText",
        });
      } catch {
        // Logged inside; never fails a primary write that already succeeded.
      }
    }

    // Echo-verified (CLAUDE.md): a local row goes only where Shopify confirmed
    // the removal — by its echo, or, for a locale with a local row the echo
    // skipped, by the single-locale re-read (a row Shopify never held is
    // "gone" there and confirms).
    const { removeAndVerify, removeAndVerifyAcrossLocales, LOCALE_KEY_SEP } = await import(
      "../bulk-editor/translations.server"
    );
    const confirmedByMedia = new Map<string, Set<string>>();
    for (const mediaId of mediaIds) {
      const confirmed = new Set<string>();
      try {
        const across = await removeAndVerifyAcrossLocales(gateway, mediaId, ["alt"], [...foreignLocales], "");
        for (const locale of foreignLocales) {
          if (across.confirmedPairs.has(`${locale}${LOCALE_KEY_SEP}alt`)) confirmed.add(locale);
        }
      } catch (error: unknown) {
        logger.warn("[AltRepair] translationsRemove failed", {
          context: "AltRepair",
          productId,
          mediaId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      confirmedByMedia.set(mediaId, confirmed);
    }

    const imageByMedia = new Map(changes.filter((c) => c.mediaId).map((c) => [c.mediaId as string, c.imageId]));
    for (const [mediaId, confirmed] of confirmedByMedia) {
      const imageId = imageByMedia.get(mediaId);
      if (!imageId) continue;
      const localRows = await db.productImageAltTranslation.findMany({
        where: { imageId, marketId: "", locale: { in: [...foreignLocales] } },
        select: { locale: true },
      });
      for (const { locale } of localRows) {
        if (confirmed.has(locale)) continue;
        try {
          const single = await removeAndVerify(gateway, mediaId, ["alt"], locale, "");
          if (single.confirmedKeys.has("alt")) confirmed.add(locale);
        } catch {
          // Unconfirmed: the local row stays; the next look corrects it.
        }
      }
      if (confirmed.size > 0) {
        await db.productImageAltTranslation.deleteMany({
          where: { imageId, marketId: "", locale: { in: [...confirmed] } },
        });
      }
    }

    // A cached image with no `mediaId` has no Shopify resource at all, so its
    // local rows describe nothing live and go as before.
    const unaddressable = changes.filter((c) => !c.mediaId).map((c) => c.imageId);
    if (unaddressable.length > 0) {
      await db.productImageAltTranslation.deleteMany({
        where: { imageId: { in: unaddressable }, marketId: "", locale: { in: [...foreignLocales] } },
      });
    }
  } catch (error: unknown) {
    logger.error("[AltRepair] Failed to delete alt-text translations for changed images", {
      context: "AltRepair",
      productId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A product medium's alt as it stood BEFORE a write — see `snapshotProductAlts`. */
export interface ProductAltSnapshotEntry {
  imageId: string;
  productId: string;
  altText: string | null;
  productTitle: string;
}

/**
 * Read the alts about to be overwritten. Must run BEFORE the write: every
 * primary alt path updates the `ProductImage` cache itself, so a snapshot taken
 * after it reads its own write and every change looks like "unchanged". Shop-
 * scoped (media GIDs can collide across tenants). A failed read is an empty
 * map — nothing is repaired, which is what happened before this existed.
 */
export async function snapshotProductAlts(
  db: PrismaClient,
  shop: string,
  mediaIds: readonly string[],
): Promise<Map<string, ProductAltSnapshotEntry>> {
  const out = new Map<string, ProductAltSnapshotEntry>();
  if (mediaIds.length === 0) return out;
  try {
    const rows = await db.productImage.findMany({
      where: { mediaId: { in: [...mediaIds] }, product: { shop } },
      select: { id: true, productId: true, altText: true, mediaId: true, product: { select: { title: true } } },
    });
    for (const row of rows) {
      if (!row.mediaId) continue;
      out.set(row.mediaId, {
        imageId: row.id,
        productId: row.productId,
        altText: row.altText,
        productTitle: row.product?.title ?? row.productId,
      });
    }
  } catch (error: unknown) {
    logger.warn("[AltRepair] Could not read the alts before the write — no repair", {
      context: "AltRepair",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return out;
}

/**
 * The repair for every primary alt path that is NOT the product editor's save:
 * the image manager's per-image save, the SKU generator, a template apply and
 * the SEO bulk fix. Only a CHANGED alt counts (trimmed, against the snapshot
 * taken before the write), grouped per product so one merchant action is one
 * run per product; a group of ONE medium takes `mediaAltLockId`, so image-by-
 * image saves do not abort each other's runs. One policy read and one locale
 * read per call. Returns the task ids; never throws.
 */
export async function repairAltsAfterWrite(params: {
  gateway: ShopifyApiGateway;
  db: PrismaClient;
  shop: string;
  snapshot: ReadonlyMap<string, ProductAltSnapshotEntry>;
  /** What was WRITTEN (Shopify's echo where the mutation returns one). */
  written: ReadonlyArray<{ mediaId: string; alt: string }>;
}): Promise<string[]> {
  const { gateway, db, shop, snapshot } = params;
  try {
    const groups = new Map<string, { title: string; changes: ProductAltChange[] }>();
    for (const { mediaId, alt } of params.written) {
      const before = snapshot.get(mediaId);
      if (!before || (before.altText ?? "").trim() === alt.trim()) continue;
      const group = groups.get(before.productId) ?? { title: before.productTitle, changes: [] };
      group.changes.push({ imageId: before.imageId, mediaId, alt });
      groups.set(before.productId, group);
    }
    if (groups.size === 0) return [];

    const { loadTranslationChangePolicy } = await import("./translation-change-policy.server");
    const policy = await loadTranslationChangePolicy(shop, db);
    if (!policy.autoTranslateExternalChanges && !policy.purgeUnreconciledSurfaces) return [];

    const [{ fetchShopLocales }, { translationForeignLocales }] = await Promise.all([
      import("../sync-utils"),
      import("./stale-translations.shared"),
    ]);
    const locales = await fetchShopLocales(gateway.graphql.bind(gateway));
    const foreignLocales = translationForeignLocales(locales);
    const primaryLocale = locales.find((l) => l.primary)?.locale ?? "";

    const taskIds: string[] = [];
    for (const [productId, group] of groups) {
      const only = group.changes.length === 1 ? group.changes[0].mediaId : null;
      const outcome = await repairChangedProductAlts({
        gateway,
        db,
        shop,
        productId,
        productTitle: group.title,
        changes: group.changes,
        policy,
        foreignLocales,
        primaryLocale,
        ...(only ? { lockId: mediaAltLockId(productId, only) } : {}),
      });
      if (outcome.taskId) taskIds.push(outcome.taskId);
    }
    return taskIds;
  } catch (error: unknown) {
    // Non-fatal: every caller's primary write has already gone through.
    logger.warn("[AltRepair] Alt translation repair skipped", {
      context: "AltRepair",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
