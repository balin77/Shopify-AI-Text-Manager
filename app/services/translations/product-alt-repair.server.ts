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
import { altTextLockId } from "./translation-locks.shared";

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
      lockId: altTextLockId(productId),
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

    await Promise.all(
      mediaIds.map(async (mediaId) => {
        const response = await gateway.graphql(
          `#graphql
            mutation removeAltTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
              translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                userErrors { field message }
                translations { key locale }
              }
            }`,
          { variables: { resourceId: mediaId, translationKeys: ["alt"], locales: [...foreignLocales] } },
        );
        const data = (await response.json()) as {
          data?: { translationsRemove?: { userErrors?: Array<{ message: string }> } };
        };
        const errors = data.data?.translationsRemove?.userErrors ?? [];
        if (errors.length > 0) {
          logger.error("[AltRepair] translationsRemove returned userErrors", {
            context: "AltRepair",
            productId,
            mediaId,
            errors,
          });
        }
      }),
    );

    const imageIds = changes.map((c) => c.imageId);
    if (imageIds.length > 0) {
      await db.productImageAltTranslation.deleteMany({
        // Global-scoped to mirror the global-only Shopify removal — the market
        // overrides were handled on their own layer above.
        where: { imageId: { in: imageIds }, marketId: "", locale: { in: [...foreignLocales] } },
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
