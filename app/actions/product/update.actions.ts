/**
 * Product Update Action
 *
 * Handles saving product changes back to Shopify and local database:
 * - Updates primary locale products directly via productUpdate mutation
 * - Updates translated locales via translationsRegister mutation
 * - Syncs changes to local database for caching
 * - Handles image alt-text updates for all locales
 */

import { FIELD_TO_TRANSLATION_KEY as PRODUCT_KEYS, TRANSLATION_KEY_TO_FIELD } from "../../services/translations/translation-keys.shared";
import { data as json } from "react-router";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import { sanitizeSlug } from "~/utils/slug.utils";
// One rule per attribute, shared with the generic content path — the previous
// generation of this code kept a per-resource copy of each and they drifted.
import {
  PRODUCT_COLLECTIONS_SELECTION,
  productCollectionRows,
  type ShopifyProductCollections,
} from "~/services/attribute-sync.shared";
import {
  diffCollectionMembership,
  collectionAutomation,
  isValidProductStatus,
  parseCategoryId,
  parseCollectionIds,
  parseTagList,
} from "~/services/content-attributes.shared";
import { logger, loggers } from "~/utils/logger.server";
import { markTranslationSaved } from "~/utils/translation-save-lock.server";
import { altTextLockId, marketLayerLockId } from "~/services/translations/translation-locks.shared";
import { collectRetranslationTaskIds } from "~/services/translations/retranslation-tasks.shared";
import {
  altRepairRetranslates,
  repairChangedProductAlts,
  type ProductAltChange,
} from "~/services/translations/product-alt-repair.server";
// THE field to translation-key map (CLAUDE.md: never re-declare it — the
// historic local copies drifted).
import { FIELD_TO_TRANSLATION_KEY } from "../../../src/services/shopify-content.service";
import {
  registerAndVerify,
  removeAndVerify,
  removeVerifiedWithGapReread,
  confirmedPairsWhere,
  mirrorConfirmedContentTranslations,
  registerMediaAltAndVerify,
  removeMediaAltAndVerify,
  mirrorProductMediaAlt,
  LOCALE_KEY_SEP,
  type VerifiedWriteResult,
} from "~/services/translations/verified-translations.server";
import type { ActionContext } from "./shared/action-context";
import { getFormString, getFormStringOrNull, getFormJSON } from "~/utils/form-data.utils";
import { isValidLocale, safeJsonParse } from "~/utils/validation";
import type { PrismaClient } from "@prisma/client";
import type { DataResponse } from "~/types/data-response";
import { readDataPayload, readDataStatus } from "~/utils/data-response";
import type { RepairBudget } from "~/services/translations/repair-budget.server";

/**
 * Shopify translation key -> the editor's FIELD key, for the keys a foreign
 * product save can clear. The page keeps a field whose clear was not confirmed
 * dirty by FIELD key (`unconfirmedClearedFields`); the product's body field is
 * `description` in the editor and `descriptionHtml` on the wire.
 */
const FIELD_OF_PRODUCT_TRANSLATION_KEY: Readonly<Record<string, string>> = TRANSLATION_KEY_TO_FIELD;

interface UpdateProductParams {
  locale: string;
  primaryLocale: string;
  title?: string;
  descriptionHtml?: string;
  handle?: string;
  seoTitle?: string;
  metaDescription?: string;
  productType?: string;
  // ── PLAN_CONTENT_CREATION §Phase 3 merchandising attributes ──────────────
  // Not translatable (Shopify stores one value per product), so these only
  // ever arrive on a PRIMARY-locale save — the editor renders them read-only
  // in every other locale and the write below refuses them anyway.
  status?: string;
  vendor?: string;
  /** Comma-joined on the wire, split into Shopify's array before the write. */
  tags?: string;
  templateSuffix?: string;
  /** Shopify taxonomy GID, or "" to clear. §Phase 3.1. */
  category?: string;
  /** Comma-joined collection GIDs — the membership the picker now shows. It is
   *  turned into a JOIN/LEAVE diff against the CACHE, never written as a list
   *  (see `diffCollectionMembership`). */
  collections?: string;
  imageAltTexts?: Record<number, string>;
  /** Filled by the primary alt write: the alt Shopify ECHOED per index. The
   *  repair checks its read-back against what Shopify STORED, never against
   *  what was submitted (the rule the handle redirect follows too). */
  confirmedAltTexts?: Record<number, string>;
  productId: string;
  /** Market scope ("" = global). Only applies to foreign-locale text saves. */
  marketId?: string;
}

/**
 * Updates product in Shopify and local database
 */
export async function handleUpdateProduct(
  context: ActionContext,
  formData: FormData,
  productId: string,
  /** A bulk caller's budget of detached re-translation runs — see
   *  repair-budget.server.ts. Absent for the editor (one save, one run). */
  options?: { repairBudget?: RepairBudget },
): Promise<DataResponse> {
  const { db } = await import("~/db.server");

  // Shop-isolation: productId comes straight from the route params and GIDs are
  // enumerable. If a Product row with this id exists under a different shop,
  // reject — otherwise the DB writes below (productImage, contentTranslation,
  // productImageAltTranslation) would corrupt another tenant's data.
  // NOTE: this top-level check stays fail-OPEN on the not-yet-synced case
  // (ownerCheck === null) on purpose — editing a product that isn't in the
  // local Product table yet is a legitimate flow. The hard fail-CLOSED
  // guarantee for N-C2 is provided by the `shop_id` compound scoping on every
  // internal lookup/write below (see updateImageAltTexts /
  // updateTranslatedProduct / updatePrimaryProduct), so a foreign or
  // not-synced productId resolves to null and writes safely no-op.
  const ownerCheck = await db.product.findUnique({
    where: { id: productId },
    select: { shop: true },
  });
  if (ownerCheck && ownerCheck.shop !== context.session.shop) {
    return json({ success: false, error: "Product not found" }, { status: 404 });
  }

  // Parse changedFields if present (for translation deletion when primary locale changes)
  const changedFieldsStr = getFormString(formData, "changedFields");
  const changedFields: string[] = changedFieldsStr ? safeJsonParse<string[]>(changedFieldsStr, []) : [];

  // Parse changedAltTextIndices if present (for alt-text translation deletion when primary locale changes)
  // §Phase 3 — a separate list from `changedFields`: see content-update.action.
  const changedAttributesStr = getFormString(formData, "changedAttributeFields");
  const changedAttributeFields: string[] = changedAttributesStr
    ? safeJsonParse<string[]>(changedAttributesStr, [])
    : [];

  const changedAltTextIndicesStr = getFormString(formData, "changedAltTextIndices");
  const changedAltTextIndices: number[] = changedAltTextIndicesStr ? safeJsonParse<number[]>(changedAltTextIndicesStr, []) : [];

  const locale = getFormString(formData, "locale");
  const primaryLocale = getFormString(formData, "primaryLocale");
  if (!locale || !isValidLocale(locale)) {
    return json({ success: false, error: "Invalid locale format" }, { status: 400 });
  }
  if (!primaryLocale || !isValidLocale(primaryLocale)) {
    return json({ success: false, error: "Invalid primary locale format" }, { status: 400 });
  }

  // Use getFormStringOrNull so that fields NOT sent by the client are `null`
  // (meaning "not changed — leave as is") rather than `""` (meaning "user
  // intentionally cleared this field — delete translation").
  // buildFieldsForSave on the client only sends changed fields, so any field
  // absent from the form data must NOT be treated as a deletion.
  const params: UpdateProductParams = {
    locale,
    primaryLocale,
    title: getFormStringOrNull(formData, "title") ?? undefined,
    descriptionHtml: getFormStringOrNull(formData, "descriptionHtml") ?? undefined,
    handle: getFormStringOrNull(formData, "handle") ?? undefined,
    seoTitle: getFormStringOrNull(formData, "seoTitle") ?? undefined,
    metaDescription: getFormStringOrNull(formData, "metaDescription") ?? undefined,
    productType: getFormStringOrNull(formData, "productType") ?? undefined,
    // §Phase 3 attributes. Read on EVERY save and filtered by locale at the
    // write, not here: an attribute arriving on a foreign-locale save is a
    // client bug, and dropping it silently at parse time would hide it.
    // `|| undefined`, not `?? undefined`: `getFormStringOrNull` returns "" for
    // a present-but-empty field, and "" is not a status. Kept as "" it would
    // fail the enum check and 400 the ENTIRE save — title, description and SEO
    // with it — over a field the merchant never touched.
    status: getFormStringOrNull(formData, "status") || undefined,
    vendor: getFormStringOrNull(formData, "vendor") ?? undefined,
    tags: getFormStringOrNull(formData, "tags") ?? undefined,
    templateSuffix: getFormStringOrNull(formData, "templateSuffix") ?? undefined,
    category: getFormStringOrNull(formData, "category") ?? undefined,
    collections: getFormStringOrNull(formData, "collections") ?? undefined,
    imageAltTexts: getFormJSON<Record<number, string>>(formData, "imageAltTexts") || {},
    productId,
    // Primary-locale saves are always global; only foreign locales carry a market.
    marketId: locale !== primaryLocale ? (getFormStringOrNull(formData, "marketId") ?? "") : "",
  };

  logger.info("Product update requested", {
    context: "UpdateProduct",
    productId,
    locale: params.locale,
    primaryLocale: params.primaryLocale,
    hasAltTexts: Object.keys(params.imageAltTexts || {}).length > 0,
  });

  // Sanitize handle
  if (params.handle) {
    params.handle = sanitizeSlug(params.handle);
    if (!params.handle) {
      return json(
        {
          success: false,
          error: "Invalid URL slug: Handle must contain at least one alphanumeric character",
        },
        { status: 400 }
      );
    }
  }

  try {
    const gateway = new ShopifyApiGateway(context.admin, context.session.shop);

    // Update alt-texts first (works for both primary and translated locales)
    let failedAltTextIndices: number[] = [];
    if (params.imageAltTexts && Object.keys(params.imageAltTexts).length > 0) {
      const altTextResult = await updateImageAltTexts(gateway, db, productId, params, context.session.shop);
      failedAltTextIndices = altTextResult.failedAltTextIndices;
    }

    // Check if this is a translation update or primary locale update
    let response: DataResponse;
    if (params.locale !== params.primaryLocale) {
      response = await updateTranslatedProduct(gateway, db, productId, params, context.session.shop);
    } else {
      // Only indices whose primary alt actually LANDED: a failed write leaves
      // the primary text unchanged, so its foreign alts are still correct and
      // must be neither purged nor re-translated. Same rule the sub-resource
      // path follows — act on what was SAVED, never on what was requested.
      const savedAltTextIndices = changedAltTextIndices.filter(
        (index) => !failedAltTextIndices.includes(index),
      );
      response = await updatePrimaryProduct(gateway, db, productId, params, changedFields, savedAltTextIndices, context.session.shop, changedAttributeFields, options?.repairBudget);
    }

    // If alt-text saves failed, merge warning into the response
    if (failedAltTextIndices.length > 0) {
      const responseData = await readDataPayload<Record<string, unknown>>(response);
      return json({
        ...responseData,
        failedAltTextIndices,
      }, { status: readDataStatus(response) ?? 200 });
    }

    return response;
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error("Product update failed", {
      context: "UpdateProduct",
      productId,
      error: errorMsg,
    });
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}

/**
 * Updates image alt-texts for a product
 *
 * For primary locale: Uses productUpdateMedia mutation
 * For translations: Uses translationsRegister mutation with MEDIA_IMAGE resource type (API 2025-10+)
 */
async function updateImageAltTexts(
  gateway: ShopifyApiGateway,
  db: PrismaClient,
  productId: string,
  params: UpdateProductParams,
  shop: string
): Promise<{ failedAltTextIndices: number[] }> {
  loggers.product("info", "Updating image alt-texts", {
    productId,
    locale: params.locale,
    isPrimary: params.locale === params.primaryLocale,
    count: Object.keys(params.imageAltTexts || {}).length,
  });

  const failedAltTextIndices: number[] = [];
  // Market scope for foreign-locale alt-text ("" = global; primary is always global).
  const marketId = params.locale !== params.primaryLocale ? (params.marketId || "") : "";

  // Get product images from Shopify
  const productResponse = await gateway.graphql(
    `#graphql
      query getProduct($id: ID!) {
        product(id: $id) {
          media(first: 50) {
            edges {
              node {
                ... on MediaImage {
                  id
                  alt
                }
              }
            }
          }
        }
      }`,
    { variables: { id: productId } }
  );

  const productData = await productResponse.json() as any;

  // Filter to only include valid MediaImage nodes (exclude videos, 3D models, etc.)
  const mediaEdges = (productData.data?.product?.media?.edges || [])
    .filter((edge: { node?: { id?: string } }) => edge.node?.id); // Only keep nodes with an id (MediaImage type)

  // Get DB product images (sorted by position to match UI order).
  // Scoped by the strong `shop_id` compound key so a productId owned by
  // another shop can never resolve here (fail-closed cross-tenant guard).
  const dbProduct = await db.product.findUnique({
    where: { shop_id: { shop, id: productId } },
    include: {
      images: {
        orderBy: { position: 'asc' },
      },
    },
  });

  // Update each image with new alt-text
  for (const [indexStr, altText] of Object.entries(params.imageAltTexts || {})) {
    const index = parseInt(indexStr, 10);
    const dbImage = dbProduct?.images[index];

    // Prefer mediaId from DB (more reliable), fallback to Shopify query by index
    let mediaImageId = dbImage?.mediaId;

    if (!mediaImageId && index < mediaEdges.length && mediaEdges[index]?.node?.id) {
      mediaImageId = mediaEdges[index].node.id;
      loggers.product("debug", "Using mediaId from Shopify query (DB mediaId not found)", { index });
    }

    if (!mediaImageId) {
      loggers.product("warn", "No mediaId found for image - cannot save to Shopify", {
        index,
        hasDbImage: !!dbImage,
        dbImageMediaId: dbImage?.mediaId,
      });
      failedAltTextIndices.push(index);
      continue;
    }

    loggers.product("debug", "Updating image alt-text", {
      index,
      mediaImageId,
      locale: params.locale,
      isPrimary: params.locale === params.primaryLocale,
      mediaIdSource: dbImage?.mediaId ? "database" : "shopify-query",
    });

    let shopifySaved = false;
    /** What Shopify STORED for a foreign alt (the echoed value). */
    let storedForeignAlt = "";

    if (params.locale === params.primaryLocale) {
      // PRIMARY LOCALE: Use productUpdateMedia mutation
      try {
        const updateMediaResponse = await gateway.graphql(
          `#graphql
            mutation updateMedia($media: [UpdateMediaInput!]!, $productId: ID!) {
              productUpdateMedia(media: $media, productId: $productId) {
                media {
                  alt
                  mediaErrors {
                    code
                    details
                    message
                  }
                }
                mediaUserErrors {
                  field
                  message
                }
                product {
                  id
                }
              }
            }`,
          {
            variables: {
              productId,
              media: [
                {
                  id: mediaImageId,
                  // Send empty string to Shopify to clear alt-text (null means "don't change")
                  alt: altText,
                },
              ],
            },
          }
        );
        const updateMediaData = await updateMediaResponse.json() as any;
        const mediaUserErrors = updateMediaData.data?.productUpdateMedia?.mediaUserErrors || [];
        const returnedAlt = updateMediaData.data?.productUpdateMedia?.media?.[0]?.alt;
        if (typeof returnedAlt === "string") {
          params.confirmedAltTexts = { ...(params.confirmedAltTexts ?? {}), [index]: returnedAlt };
        }
        logger.debug(`[ProductUpdate] [SHOPIFY-RESPONSE] mediaId: ${mediaImageId}, sent alt: "${altText}", returned alt: "${returnedAlt}"`);

        if (mediaUserErrors.length > 0) {
          loggers.product("error", "productUpdateMedia errors", { index, errors: mediaUserErrors });
        } else {
          shopifySaved = true;
        }
        loggers.product("debug", "Updated primary alt-text via productUpdateMedia", { index, sentAlt: altText, returnedAlt, shopifySaved });
      } catch (err: unknown) {
        loggers.product("error", "productUpdateMedia exception", { index, error: err instanceof Error ? err.message : String(err) });
      }
    } else {
      // TRANSLATION: foreign locale. Verified (Phase D): the digest is read and
      // the register is checked against Shopify's ECHO, and a clear is a
      // verified REMOVAL (echo, then the single-locale re-read, so a DB-only
      // row Shopify never held can still be cleared). `shopifySaved` is true
      // ONLY on confirmation -- `userErrors: []` is not enough.
      const altTextValue = String(altText ?? "");
      try {
        if (altTextValue.trim() === "") {
          const removal = await removeMediaAltAndVerify(gateway, mediaImageId, params.locale, marketId);
          shopifySaved = removal.confirmed;
          if (!shopifySaved) {
            loggers.product("error", "Shopify did not confirm removing the alt-text translation", {
              index, locale: params.locale, errors: removal.userErrors,
            });
          }
        } else {
          const verified = await registerMediaAltAndVerify(
            gateway, mediaImageId, params.locale, altTextValue, marketId || undefined,
          );
          shopifySaved = verified.confirmed;
          if (shopifySaved) {
            storedForeignAlt = verified.storedValue ?? altTextValue;
          } else {
            loggers.product("error", "Shopify did not confirm the alt-text translation", {
              index, mediaImageId, locale: params.locale, noDigest: verified.noDigest, errors: verified.userErrors,
            });
          }
        }
      } catch (err: unknown) {
        loggers.product("error", "alt-text translation write exception", {
          index, locale: params.locale, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Claim the alt-text lock the moment Shopify holds the value, so a detached
    // alt re-translation from an earlier primary save abandons the rest of its
    // work instead of overwriting what the merchant just wrote. Under the SAME
    // key that repair runs on (translation-locks.shared.ts) — the product's own
    // lock belongs to its field reconciliation.
    // GLOBAL layer only: the repair writes global rows, so a market override
    // edit can never collide with it, and aborting the run over one would leave
    // its remaining entries in neither list.
    if (shopifySaved && params.locale !== params.primaryLocale && !marketId) {
      markTranslationSaved(altTextLockId(productId));
      // And the MediaImage itself (global layer), the key every other alt write
      // site marks and the one a per-medium repair watches.
      if (mediaImageId) markTranslationSaved(mediaImageId);
    }

    // Save to Database ONLY if Shopify save succeeded (no mismatch allowed)
    if (shopifySaved && params.locale !== params.primaryLocale) {
      // The cache row is resolved from (productId, mediaId) NOW -- never from
      // the row read at the top of this loop: a product sync recreates
      // ProductImage rows with fresh ids. A cleared alt deletes the row of the
      // layer that was written (global or this market).
      const mirrored = await mirrorProductMediaAlt(db, {
        shop,
        productId,
        mediaId: mediaImageId,
        locale: params.locale,
        value: String(altText ?? "").trim() === "" ? "" : storedForeignAlt,
        marketId,
      });
      if (mirrored === "imageGone") {
        loggers.product("warn", "Image was deleted during alt-text save (concurrent sync)", {
          index, locale: params.locale,
        });
      }
    } else if (shopifySaved && dbImage) {
      try {
        const altTextToSave = altText === "" ? null : altText;
        await db.productImage.update({
          where: { id: dbImage.id },
          data: {
            altText: altTextToSave,
            altTextModifiedAt: new Date(),
          },
        });
        loggers.product("debug", "Updated primary alt-text in DB", { index, altTextSaved: altTextToSave });
        // DEBUG: Verify DB was actually updated
        const verifyImage = await db.productImage.findUnique({ where: { id: dbImage.id }, select: { altText: true } });
        logger.info(`[ALT-TEXT-DEBUG] DB verify after save: dbImageId=${dbImage.id}, savedAltText="${verifyImage?.altText}", expected="${altTextToSave}"`);
      } catch (dbError: unknown) {
        const dbErr = dbError instanceof Error ? dbError : new Error(String(dbError));
        const dbErrCode = (dbError as { code?: string })?.code;
        if (dbErrCode === 'P2025' || dbErrCode === 'P2003' || dbErr.message?.includes('Foreign key constraint')) {
          loggers.product("warn", "Image was deleted during alt-text save (concurrent sync)", {
            index, locale: params.locale, error: dbErr.message,
          });
        } else {
          throw dbError;
        }
      }
    } else if (!shopifySaved) {
      failedAltTextIndices.push(index);
      logger.info(`[ALT-TEXT-DEBUG] Shopify save FAILED for image index ${index}, alt="${altText}", locale=${params.locale}`);
    } else if (!dbImage) {
      logger.info(`[ALT-TEXT-DEBUG] No dbImage found for index ${index} - DB save skipped`);
    }
  }

  return { failedAltTextIndices };
}

/**
 * Updates a translated product (non-primary locale)
 */
async function updateTranslatedProduct(
  gateway: ShopifyApiGateway,
  db: PrismaClient,
  productId: string,
  params: UpdateProductParams,
  shop: string
): Promise<DataResponse> {
  const marketId = params.marketId || "";
  loggers.product("info", "Updating translated product", {
    productId,
    locale: params.locale,
    marketId: marketId || "(global)",
  });

  // First, fetch translatable content to get digests
  // This is required by Shopify's translationsRegister mutation
  const translatableResponse = await gateway.graphql(
    `#graphql
      query translatableContent($resourceId: ID!) {
        translatableResource(resourceId: $resourceId) {
          resourceId
          translatableContent {
            key
            digest
            value
          }
        }
      }`,
    { variables: { resourceId: productId } }
  );

  const translatableData = await translatableResponse.json() as any;
  const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];

  // Log ALL entries from Shopify (including those without digest)
  loggers.product("debug", "Raw translatableContent from Shopify", {
    productId,
    totalEntries: translatableContent.length,
    entries: translatableContent.map((item: { key: string; digest?: string; value?: string }) => ({
      key: item.key,
      hasDigest: !!item.digest,
      hasValue: !!item.value,
      valuePreview: item.value ? item.value.substring(0, 40) : "EMPTY",
    })),
  });

  // Create digest map for quick lookup
  const digestMap: Record<string, string> = {};
  translatableContent.forEach((item: { key: string; digest: string; value: string }) => {
    if (item.digest) {
      digestMap[item.key] = item.digest;
    }
  });

  loggers.product("debug", "Fetched translatable content digests", {
    productId,
    availableKeys: Object.keys(digestMap),
    missingDigestKeys: translatableContent
      .filter((item: { key: string; digest?: string }) => !item.digest)
      .map((item: { key: string }) => item.key),
  });

  const translationsInput: Array<{ key: string; value: string; locale: string; translatableContentDigest: string }> = [];
  const translationsToDelete: string[] = [];
  const skippedFields: string[] = [];
  // Translations that have no Shopify digest but should still be saved to the local DB
  const dbOnlyTranslations: Array<{ key: string; value: string; locale: string }> = [];

  // Helper to add translation - saves to Shopify if digest available, otherwise DB-only
  const addTranslation = (key: string, value: string) => {
    if (digestMap[key]) {
      translationsInput.push({ key, value, locale: params.locale, translatableContentDigest: digestMap[key] });
    } else {
      skippedFields.push(key);
      dbOnlyTranslations.push({ key, value, locale: params.locale });
    }
  };

  // Only add non-empty translations that have a digest (meaning primary content exists)
  if (params.title && params.title.trim()) {
    addTranslation(PRODUCT_KEYS.title, params.title);
  } else if (params.title === "") {
    // Empty string means user wants to delete the translation
    translationsToDelete.push(PRODUCT_KEYS.title);
  }

  if (params.descriptionHtml && params.descriptionHtml.trim()) {
    addTranslation(PRODUCT_KEYS.description, params.descriptionHtml);
  } else if (params.descriptionHtml === "") {
    translationsToDelete.push(PRODUCT_KEYS.description);
  }

  if (params.handle && params.handle.trim()) {
    addTranslation(PRODUCT_KEYS.handle, params.handle);
  } else if (params.handle === "") {
    translationsToDelete.push(PRODUCT_KEYS.handle);
  }

  if (params.seoTitle && params.seoTitle.trim()) {
    addTranslation(PRODUCT_KEYS.seoTitle, params.seoTitle);
  } else if (params.seoTitle === "") {
    translationsToDelete.push(PRODUCT_KEYS.seoTitle);
  }

  if (params.metaDescription && params.metaDescription.trim()) {
    addTranslation(PRODUCT_KEYS.metaDescription, params.metaDescription);
  } else if (params.metaDescription === "") {
    translationsToDelete.push(PRODUCT_KEYS.metaDescription);
  }

  if (params.productType && params.productType.trim()) {
    addTranslation(PRODUCT_KEYS.productType, params.productType);
  } else if (params.productType === "") {
    translationsToDelete.push(PRODUCT_KEYS.productType);
  }

  // Retry: if any fields were skipped due to missing digest, re-fetch translatableContent
  // (handles race conditions / late availability — mirrors shopify-content.service.ts logic)
  if (skippedFields.length > 0) {
    loggers.product("warn", "Missing digests for fields, re-fetching translatableContent...", {
      productId,
      locale: params.locale,
      skippedFields,
      availableDigestKeys: Object.keys(digestMap),
    });

    const retryResponse = await gateway.graphql(
      `#graphql
        query translatableContent($resourceId: ID!) {
          translatableResource(resourceId: $resourceId) {
            resourceId
            translatableContent {
              key
              digest
              value
            }
          }
        }`,
      { variables: { resourceId: productId } }
    );
    const retryData = await retryResponse.json() as any;
    const retryContent = retryData.data?.translatableResource?.translatableContent || [];

    // Update digest map with freshly fetched digests
    retryContent.forEach((item: { key: string; digest: string }) => {
      if (item.digest && !digestMap[item.key]) {
        digestMap[item.key] = item.digest;
      }
    });

    // Move recovered fields from dbOnly → translationsInput
    const stillSkipped: string[] = [];
    const recovered: string[] = [];
    for (let i = dbOnlyTranslations.length - 1; i >= 0; i--) {
      const t = dbOnlyTranslations[i];
      if (digestMap[t.key]) {
        translationsInput.push({ ...t, translatableContentDigest: digestMap[t.key] });
        dbOnlyTranslations.splice(i, 1);
        recovered.push(t.key);
      } else {
        stillSkipped.push(t.key);
      }
    }

    if (recovered.length > 0) {
      loggers.product("info", "Recovered digests on retry", { productId, recovered });
    }
    if (stillSkipped.length > 0) {
      loggers.product("warn", "Fields still without digest after retry (will save to DB only)", {
        productId,
        locale: params.locale,
        stillSkipped,
        availableDigestKeys: Object.keys(digestMap),
      });
    }
  }

  // Verified register (Phase D): a key counts as saved, and is mirrored, ONLY
  // when Shopify ECHOED it back -- `userErrors: []` describes a call Shopify
  // accepted, not one it acted on. Throws on a transport/GraphQL error, which
  // the caller turns into the 500 it always did.
  const confirmedInputs: typeof translationsInput = [];
  const unconfirmedKeys: string[] = [];
  let registerError = "";
  let verifiedWrite: VerifiedWriteResult | null = null;
  if (translationsInput.length > 0) {
    verifiedWrite = await registerAndVerify(
      gateway,
      productId,
      // Add marketId to each input for a market-specific override; omit for global.
      translationsInput.map((t) => (marketId ? { ...t, marketId } : t)),
    );
    registerError = verifiedWrite.userErrors[0]?.message ?? "";
    for (const t of translationsInput) {
      if (verifiedWrite.confirmedKeys.has(t.key)) confirmedInputs.push(t);
      else unconfirmedKeys.push(t.key);
    }
    if (unconfirmedKeys.length > 0) {
      logger.error("Shopify did not confirm every translation key of the product save", {
        context: "UpdateProduct",
        productId,
        locale: params.locale,
        marketId: marketId || "(global)",
        unconfirmedKeys,
        errors: verifiedWrite.userErrors,
      });
    }
    loggers.product("info", "Saved translations to Shopify", {
      productId,
      locale: params.locale,
      count: confirmedInputs.length,
    });
  }

  // Cleared fields: a verified REMOVAL -- the echo, then (single locale) the
  // re-read, so a DB-only mirror row Shopify never held can still be cleared.
  // The local row goes ONLY for a confirmed key. A market-scoped removal keeps
  // the global translation intact; a global one omits marketIds.
  const confirmedDeleteKeys: string[] = [];
  const unconfirmedRemovals: string[] = [];
  let removalError = "";
  if (translationsToDelete.length > 0) {
    const removal = await removeAndVerify(gateway, productId, translationsToDelete, params.locale, marketId);
    for (const key of translationsToDelete) {
      if (removal.confirmedKeys.has(key)) confirmedDeleteKeys.push(key);
      else unconfirmedRemovals.push(key);
    }
    removalError = removal.userErrors[0]?.message ?? "";
    loggers.product("info", "Removed translations from Shopify", {
      productId,
      locale: params.locale,
      confirmed: confirmedDeleteKeys,
      unconfirmed: unconfirmedRemovals,
    });
  }

  // Update local database using ContentTranslation table (unified pattern).
  // Scoped by the strong `shop_id` compound key: a productId belonging to
  // another shop resolves to null here, so no cross-tenant rows are written.
  const product = await db.product.findUnique({
    where: { shop_id: { shop, id: productId } },
    select: { shop: true },
  });

  if (product) {
    // Use transaction to ensure all upserts and deletes succeed or fail together
    // @ts-expect-error Prisma interactive transaction types are complex; tx has same model accessors as db
    await db.$transaction(async (tx: PrismaClient) => {
      // Mirror what Shopify CONFIRMED, with the value it STORED and the digest
      // the write used. The digest is MIRRORED, not dropped: it records which
      // source text this translation was written against, and the sync's
      // stale-translation reconciliation uses exactly that as its baseline
      // (services/translations/stale-translation-sync.server.ts). Writing null
      // made every product translated IN THIS APP invisible to that detection.
      if (verifiedWrite && confirmedInputs.length > 0) {
        await mirrorConfirmedContentTranslations(tx, {
          shop: product.shop,
          resourceId: productId,
          resourceType: "Product",
          locale: params.locale,
          marketId,
          sent: confirmedInputs.map(({ key, value }) => ({ key, value })),
          result: verifiedWrite,
          digests: new Map(Object.entries(digestMap)),
        });
      }
      // Keys with NO digest were never sent to Shopify (translationsRegister
      // requires one) but the row is written anyway (CLAUDE.md): digest null.
      // A different case from an un-echoed write, and never to be collapsed
      // into it.
      if (dbOnlyTranslations.length > 0) {
        await mirrorConfirmedContentTranslations(tx, {
          shop: product.shop,
          resourceId: productId,
          resourceType: "Product",
          locale: params.locale,
          marketId,
          sent: dbOnlyTranslations.map(({ key, value }) => ({ key, value })),
          result: { confirmedKeys: new Set(), confirmedValues: new Map() },
          digests: new Map(),
          mirrorWithoutDigest: true,
        });
      }

      // Delete translations whose removal Shopify CONFIRMED (scoped to this
      // market and this shop).
      if (confirmedDeleteKeys.length > 0) {
        await tx.contentTranslation.deleteMany({
          where: {
            shop: product.shop,
            resourceId: productId,
            resourceType: "Product",
            locale: params.locale,
            marketId,
            key: { in: confirmedDeleteKeys },
          },
        });
      }
    });

    // Mark this product as recently saved so webhook syncs don't overwrite —
    // and a MARKET write marks its own key. A repair writes GLOBAL rows only,
    // so a market override can never collide with one; a mark it could see
    // would abort an in-flight run for nothing and leave that run's remaining
    // locales in neither list (translation-locks.shared.ts). The syncs that
    // rewrite the market layer ask for both keys by name.
    markTranslationSaved(marketId ? marketLayerLockId(productId) : productId);

    loggers.product("info", "Saved translations to DB (ContentTranslation)", {
      productId,
      locale: params.locale,
      savedToShopifyAndDb: confirmedInputs.length,
      savedToDbOnly: dbOnlyTranslations.length,
      deleted: confirmedDeleteKeys.length,
    });
  }

  // What the merchant hears. Nothing confirmed => this save stored nothing, and
  // reporting success is the lie the invariant exists to prevent
  // ({ success: false } keeps the text in the fields so Save can be pressed
  // again). Something confirmed => a partial save, reported as a WARNING naming
  // what did not land -- the confirmed half is real and a critical error over
  // it would invite re-typing text that is already live.
  // The same rules, in the same order, as updateContent
  // (shopify-content.service.ts), so the product editor and every other
  // editor answer one save the same way:
  //  - a REGISTER that confirmed nothing fails the save, whatever removals did
  //    -- otherwise the client caches the unsaved text as saved and the field
  //    reads clean while Shopify holds nothing;
  //  - fields stored locally only (no digest) are said out loud, also inside a
  //    failure, so the merchant knows which half went where.
  const warnings: string[] = [];
  if (dbOnlyTranslations.length > 0) {
    const fieldNames = dbOnlyTranslations.map((t) => t.key).join(", ");
    warnings.push(
      `Some fields (${fieldNames}) could not be sent to Shopify because no digest was available and were saved locally only. They may be overwritten on the next sync — please re-save after a page refresh.`,
    );
  }
  // FIELD keys of the writes Shopify did not echo: the page keeps them dirty
  // with the typed text and words the message itself, in the merchant's
  // language, from its own field labels. A key no field owns keeps the English
  // text below as the fallback.
  const unconfirmedFields = [
    ...new Set(unconfirmedKeys.map((key) => FIELD_OF_PRODUCT_TRANSLATION_KEY[key]).filter((f): f is string => !!f)),
  ];
  const unmappedUnconfirmedKeys = unconfirmedKeys.filter((key) => !FIELD_OF_PRODUCT_TRANSLATION_KEY[key]);
  if (unconfirmedKeys.length > 0) {
    const named = unmappedUnconfirmedKeys.length > 0 ? unmappedUnconfirmedKeys : unconfirmedKeys;
    const message = `Shopify accepted the save but did not confirm storing (${named.join(", ")}). Those fields were NOT saved and were not cached locally — please try again.${registerError ? ` (${registerError})` : ""}`;
    if (confirmedInputs.length === 0) {
      return json(
        { success: false, error: [message, ...warnings].join(" "), ...(unconfirmedFields.length > 0 ? { unconfirmedFields } : {}) },
        { status: 500 },
      );
    }
    if (unmappedUnconfirmedKeys.length > 0 || registerError) warnings.unshift(message);
  }
  if (unconfirmedRemovals.length > 0) {
    const message = `Shopify did not confirm removing the translation of (${unconfirmedRemovals.join(", ")}). It was kept — please try again.${removalError ? ` (${removalError})` : ""}`;
    if (confirmedInputs.length === 0 && confirmedDeleteKeys.length === 0) {
      return json({ success: false, error: [message, ...warnings].join(" ") }, { status: 500 });
    }
    warnings.unshift(message);
  }
  if (warnings.length > 0 || unconfirmedFields.length > 0) {
    // FIELD keys whose clear Shopify did not confirm: the page keeps them dirty
    // instead of caching them as saved-empty.
    const unconfirmedClearedFields = unconfirmedRemovals
      .map((key) => FIELD_OF_PRODUCT_TRANSLATION_KEY[key])
      .filter((field): field is string => !!field);
    return json({
      success: true,
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      ...(unconfirmedClearedFields.length > 0 ? { unconfirmedClearedFields } : {}),
      ...(unconfirmedFields.length > 0 ? { unconfirmedFields } : {}),
    });
  }

  return json({ success: true });
}

/**
 * Updates a primary locale product
 * Also deletes translations for changed fields in all foreign languages
 */
async function updatePrimaryProduct(
  gateway: ShopifyApiGateway,
  db: PrismaClient,
  productId: string,
  params: UpdateProductParams,
  changedFields: string[] = [],
  changedAltTextIndices: number[] = [],
  shop: string,
  /** §Phase 3 — the attributes the merchant actually touched. Empty ⇒ write
   *  none of them; see the gate below for why that is the safe default. */
  changedAttributeFields: string[] = [],
  repairBudget?: RepairBudget,
): Promise<DataResponse> {
  loggers.product("info", "Updating primary product", { productId, changedFields, changedAltTextIndices });

  // Validate that title is not emptied for the primary locale — but ONLY when
  // the client actually sent the field. `undefined` means "not sent = leave as
  // is" (see the getFormStringOrNull note in handleUpdateProduct), so partial
  // primary saves that touch a single field — e.g. the SEO internal-links
  // Accept flow, which writes only descriptionHtml — must not be rejected for a
  // title they never touched. `""` still means "user cleared it" and is blocked.
  if (params.title !== undefined && !params.title.trim()) {
    return json(
      {
        success: false,
        error: "Title cannot be empty for the primary language. Please enter a title.",
      },
      { status: 400 }
    );
  }

  /**
   * The Task rows this ONE save handed a detached re-translation to. A product
   * save can start TWO of them — its own content fields and its alt texts, two
   * groups and two rows — and the sub-resource save adds a third from its own
   * action. They travel back so the page can stop showing empty foreign fields
   * for translations that are merely in flight.
   */
  const retranslationTaskIds: string[] = [];

  // Build mutation input — every field is omitted unless the client sent it, so
  // an unsent field is left untouched on Shopify instead of being cleared.
  // (productType additionally honours changedFields: sending "" CLEARS it.)
  const mutationInput: Record<string, unknown> = { id: productId };
  if (params.title !== undefined) mutationInput.title = params.title;
  if (params.handle !== undefined) mutationInput.handle = params.handle;
  if (params.descriptionHtml !== undefined) mutationInput.descriptionHtml = params.descriptionHtml;

  // Build the SEO object defensively. Shopify's productUpdate treats `seo` as a
  // unit: sending `seo: { title }` without a description CLEARS the existing
  // seo.description (and vice versa). Single-field primary saves — e.g. the
  // Accept & Translate flow that translates only the meta title back into the
  // primary locale — send just one sub-field, so the other would be wiped.
  //
  // A normal full save always sends both fields, so it is unaffected. For the
  // partial case (exactly one sub-field provided) we fetch the current live SEO
  // from Shopify and carry the missing half over, so it is preserved rather than
  // cleared. `undefined` means "field not sent by the client" (see the
  // getFormStringOrNull mapping above), `""` means "user intentionally cleared it".
  const hasSeoTitle = params.seoTitle !== undefined;
  const hasSeoDescription = params.metaDescription !== undefined;
  if (hasSeoTitle || hasSeoDescription) {
    const seoInput: Record<string, unknown> = {};
    seoInput.title = params.seoTitle;
    seoInput.description = params.metaDescription;

    // Only one side sent → preserve the other side from Shopify's current value.
    if (hasSeoTitle !== hasSeoDescription) {
      try {
        const currentSeoResponse = await gateway.graphql(
          `#graphql
            query getProductSeo($id: ID!) {
              product(id: $id) {
                seo { title description }
              }
            }`,
          { variables: { id: productId } }
        );
        const currentSeoData = await currentSeoResponse.json() as any;
        const currentSeo = currentSeoData.data?.product?.seo || {};
        if (!hasSeoTitle) seoInput.title = currentSeo.title ?? undefined;
        if (!hasSeoDescription) seoInput.description = currentSeo.description ?? undefined;
      } catch (seoError: unknown) {
        // If the lookup fails, fall back to omitting the missing side entirely
        // (JSON.stringify drops undefined) rather than sending an empty string
        // that would clear it. Worst case Shopify leaves it unchanged.
        loggers.product("warn", "Failed to fetch current SEO for preservation", {
          productId,
          error: seoError instanceof Error ? seoError.message : String(seoError),
        });
        if (!hasSeoTitle) seoInput.title = undefined;
        if (!hasSeoDescription) seoInput.description = undefined;
      }
    }

    mutationInput.seo = seoInput;
  }

  // Only send productType if it has a value OR if user explicitly changed it
  if (params.productType || changedFields.includes('productType')) {
    mutationInput.productType = params.productType || "";
  }

  // ── PLAN §Phase 3 merchandising attributes ────────────────────────────────
  //
  // Gated on `changedFields`, NOT on "the client sent it". A primary save
  // carries EVERY field (buildFieldsForSave only filters for foreign locales),
  // so writing on presence alone means editing a title also writes vendor,
  // tags and template suffix — and on a shop whose products predate the
  // attribute sync those arrive as "" because the cache holds the migration's
  // defaults. The result is not a no-op: `productUpdate` REPLACES the tag
  // list, so a title edit would delete every tag, clear the vendor and reset
  // the theme template. `productType` two blocks up has carried exactly this
  // guard for the same reason since long before these fields existed.
  //
  // No `changedFields` at all ⇒ write no attributes. A caller that does not
  // say what changed cannot be distinguished from one that changed nothing,
  // and of the two readings only this one is safe.
  const attributeChanged = (key: string) => changedAttributeFields.includes(key);

  if (params.status !== undefined && attributeChanged("status")) {
    // An unrecognised status is REFUSED rather than sent: `status` is the one
    // attribute whose bad value fails at the GraphQL SCHEMA level, which comes
    // back as a top-level `errors` array with `data: null` and never reaches
    // `userErrors` — so the whole save would read as a success while nothing
    // was written (the false-success pattern in CLAUDE.md).
    const status = params.status.trim().toUpperCase();
    if (!isValidProductStatus(status)) {
      return json(
        { success: false, error: `Unknown product status "${params.status}".` },
        { status: 400 },
      );
    }
    mutationInput.status = status;
  }
  if (params.vendor !== undefined && attributeChanged("vendor")) {
    mutationInput.vendor = params.vendor;
  }
  if (params.templateSuffix !== undefined && attributeChanged("templateSuffix")) {
    // "" is meaningful here: it puts the product back on the theme's default
    // template. Shopify accepts the empty string for exactly that.
    mutationInput.templateSuffix = params.templateSuffix || null;
  }
  if (params.tags !== undefined && attributeChanged("tags")) {
    // Shopify REPLACES the whole tag list on productUpdate, so this is a
    // complete list, not an addition. Trimmed and emptied-dropped to match how
    // Shopify itself stores them — otherwise a stray comma becomes a tag.
    mutationInput.tags = parseTagList(params.tags);
  }

  // §Phase 3.1 — the product taxonomy. A malformed GID is REFUSED rather than
  // forwarded: an ID of the wrong type fails at the SCHEMA level, which comes
  // back as a top-level `errors` array with `data: null` and never reaches
  // `userErrors` — the save would read as a success while nothing was written.
  if (params.category !== undefined && attributeChanged("category")) {
    const parsed = parseCategoryId(params.category);
    if (!parsed.valid) {
      return json(
        { success: false, error: `"${params.category}" is not a product category.` },
        { status: 400 },
      );
    }
    // null is meaningful: it takes the product OUT of the taxonomy.
    mutationInput.category = parsed.id;
  }

  // §Phase 3.1 — collection membership, as a DIFF against the cache.
  //
  // The BEFORE side never comes from the client: a payload that names an id as
  // "left" must not be able to remove a membership this editor never showed.
  // An AUTOMATED membership is refused outright — its rule would re-add the
  // product within seconds, and the merchant would be looking at a save that
  // apparently did nothing.
  const membershipNotes: string[] = [];
  if (params.collections !== undefined && attributeChanged("collections")) {
    const cached = await db.productCollection.findMany({
      where: { shop, productId },
      select: { collectionId: true, automated: true },
    });
    // How each collection of the SHOP reads, for screening JOINS — `cached`
    // has no row for a collection the product is not in yet, so it cannot
    // answer "is this one rule-based". `attributesSyncedAt` is the
    // discriminator: an unsynced row's `isSmart: false` is the migration's
    // default, not a measurement, and is refused rather than trusted.
    const knownCollections = new Map<string, boolean | null>(
      (
        await db.collection.findMany({
          where: { shop },
          select: { id: true, isSmart: true, attributesSyncedAt: true },
        })
      ).map((c) => [c.id, collectionAutomation(c)] as const),
    );
    const diff = diffCollectionMembership(
      cached,
      parseCollectionIds(params.collections),
      knownCollections,
    );
    if (diff.toJoin.length > 0) mutationInput.collectionsToJoin = diff.toJoin;
    if (diff.toLeave.length > 0) mutationInput.collectionsToLeave = diff.toLeave;
    // Two refusals, two sentences: a MEASURED rule-based collection has an
    // explanation ("its rules decide"), an unmeasured one has an instruction
    // ("sync the collections"). One note for both told merchants their manual
    // collection was rule-based.
    if (diff.refusedAutomated.length > 0) membershipNotes.push("collectionsAutomatedKept");
    if (diff.refusedUnknown.length > 0) membershipNotes.push("collectionsUnknownKept");
  }

  // Which halves of §Phase 3.1 this save is actually writing. Used for BOTH
  // the echo selection and the mirror, so the two can never disagree about
  // whether the block is present.
  const wroteCategory = mutationInput.category !== undefined;
  const wroteMembership =
    mutationInput.collectionsToJoin !== undefined || mutationInput.collectionsToLeave !== undefined;

  // The echoed selection below is PLAN §Phase 3: `status`, `vendor`, `tags`
  // and `templateSuffix` come back so the cache mirrors what Shopify STORED,
  // not what this app sent. Shopify normalises tags (trim, dedupe, case) and
  // can refuse a template suffix, so the sent value is not the stored one.
  //
  // The two interpolated selections are PLAN §Phase 3.1 — echoed ONLY when
  // this save actually writes them. The membership selection is 100 nodes with
  // a nested ruleSet, and a title fix, an SEO edit or an alt-text save has no
  // use for any of it — the mirror below is already gated on the same
  // predicate, so unconditional selection drained the cost bucket for data
  // that was then discarded. Absent means productCollectionRows gets
  // undefined, returns null, and the "skip the rebuild" path runs, which is
  // the designed semantics rather than a special case.
  //
  // The prose stays out here on purpose: a `#` comment inside the document
  // travels to Shopify (see the GraphQL-comment gotcha in CLAUDE.md).
  const response = await gateway.graphql(
    `#graphql
      mutation updateProduct($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            title
            handle
            descriptionHtml
            status
            vendor
            tags
            templateSuffix
            ${wroteCategory ? "category { id fullName name }" : ""}
            ${wroteMembership ? PRODUCT_COLLECTIONS_SELECTION : ""}
            seo {
              title
              description
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        input: mutationInput,
      },
    }
  );

  const data = await response.json() as any;

  // A SCHEMA-level error arrives as a top-level `errors` array with
  // `data: null` and never as a userError. Before this check the line below
  // dereferenced `data.data.productUpdate` and threw a TypeError, which the
  // caller reported as a generic 500 — the merchant learned nothing about
  // which field Shopify refused.
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    logger.error("Shopify product update schema error", {
      context: "UpdateProduct",
      errors: data.errors,
    });
    return json(
      { success: false, error: data.errors[0]?.message || "Shopify refused the update." },
      { status: 500 },
    );
  }
  if (!data.data?.productUpdate) {
    return json({ success: false, error: "Shopify returned no result for this update." }, { status: 500 });
  }

  if (data.data.productUpdate.userErrors.length > 0) {
    logger.error("Shopify product update error", {
      context: "UpdateProduct",
      errors: data.data.productUpdate.userErrors,
    });
    return json(
      {
        success: false,
        error: data.data.productUpdate.userErrors[0].message,
      },
      { status: 500 }
    );
  }

  // The echo rule: `userErrors: []` describes a call Shopify accepted, and a
  // throttled or partial answer carries an empty list too. Only a product that
  // comes BACK says something was written - without it the cache would be
  // mirrored and the translation repair started for a primary that never moved.
  if (!data.data.productUpdate.product?.id) {
    logger.error("Shopify product update returned no product", { context: "UpdateProduct", productId });
    return json(
      { success: false, error: "Shopify did not confirm the product update - please try again." },
      { status: 500 },
    );
  }

  // Update local database
  try {
    // `string[]` is in the union for `tags` — a Prisma scalar list column.
    const updateData: Record<string, string | string[] | boolean | Date | null> = {};
    if (params.title) updateData.title = params.title;
    if (params.descriptionHtml !== undefined) updateData.descriptionHtml = params.descriptionHtml || null;
    if (params.handle !== undefined) updateData.handle = params.handle || null;
    if (params.seoTitle !== undefined) updateData.seoTitle = params.seoTitle || null;
    if (params.metaDescription !== undefined) updateData.seoDescription = params.metaDescription || null;
    // Only update productType in DB if it has a value or was explicitly changed
    if (params.productType) {
      updateData.productType = params.productType;
    } else if (changedFields.includes('productType')) {
      updateData.productType = params.productType || null;
    }

    // §Phase 3 attributes, mirrored from the ECHO rather than from the input:
    // Shopify normalises tags and may reject a template suffix, so writing the
    // sent value would leave the cache claiming something the shop does not
    // hold — and the attribute checklist reads that cache.
    const echoed = data.data.productUpdate.product as {
      status?: string; vendor?: string; tags?: string[]; templateSuffix?: string | null;
      category?: { id?: string; fullName?: string | null; name?: string | null } | null;
      // The SHARED type, not a hand-written near-copy: this is exactly the
      // drift the removed `as never` cast used to hide — the mapper requires
      // every key of the selection, and a local shape that merely looks like
      // it would stop the mirror writing without a word.
      collections?: ShopifyProductCollections | null;
    } | null;
    // Mirrored only for what was actually WRITTEN — same gate as the mutation
    // input above, or a title edit would mirror the cache's own defaults back
    // over themselves and, worse, look like a real value afterwards.
    if (mutationInput.status !== undefined && echoed?.status) updateData.status = echoed.status;
    if (mutationInput.vendor !== undefined) updateData.vendor = echoed?.vendor ?? params.vendor ?? null;
    if (mutationInput.templateSuffix !== undefined) {
      updateData.templateSuffix = echoed?.templateSuffix ?? null;
    }
    // A scalar list, so it is written whole. Only when Shopify echoed one:
    // mirroring `[]` because the echo was missing would WIPE the product's
    // tags in the cache and light up the attribute checklist for a change the
    // merchant never made.
    if (mutationInput.tags !== undefined && Array.isArray(echoed?.tags)) {
      updateData.tags = echoed.tags;
    }

    // §Phase 3.1 — the taxonomy. `fullName` is the whole path and is what the
    // picker labels the category with; storing only the leaf would make the
    // sidebar say "Shirts & Tops" for a category the merchant chose under
    // "Apparel". Cleared to null when the merchant cleared it, which the echo
    // reports as a missing category rather than an empty one.
    if (wroteCategory) {
      updateData.categoryId = echoed?.category?.id ?? null;
      updateData.categoryName = echoed?.category?.fullName ?? echoed?.category?.name ?? null;
    }

    // Always update lastSyncedAt
    updateData.lastSyncedAt = new Date();

    // §Phase 3.1 — membership, rebuilt from the ECHO.
    //
    // `productCollectionRows` returns null when the block was not delivered,
    // which is the caller's signal to SKIP the rebuild rather than wipe the
    // memberships — the same rule the sync follows. It is also why the
    // truncation flag rides along: "in N collections" must not read as
    // complete when it is a cut-off list.
    const membership = wroteMembership
      ? productCollectionRows(shop, productId, echoed?.collections)
      : null;
    if (membership) updateData.hasMoreCollections = membership.hasMore;

    // ONE transaction, exactly as the three sync sites do it. Without it a
    // connection blip between the delete and the createMany leaves the product
    // cached as a member of NOTHING while the save reports success — and
    // because `attributesSyncedAt` is untouched, the picker then renders that
    // emptiness as a confident "in no collections". The `hasMoreCollections`
    // flag rides along for the same reason: it and the rows must not disagree.
    await db.$transaction(async (tx) => {
      await tx.product.update({
        where: { shop_id: { shop, id: productId } },
        data: updateData,
      });

      if (!membership) return;
      // Delete-by-product then createMany, exactly as the sync does: the echo
      // is the complete window, so a diff against it would only reintroduce
      // the drift this rebuild exists to remove.
      await tx.productCollection.deleteMany({ where: { shop, productId } });
      if (membership.rows.length > 0) {
        await tx.productCollection.createMany({ data: membership.rows, skipDuplicates: true });
      }
    });

    loggers.product("info", "Updated product in DB", {
      productId,
      fields: Object.keys(updateData),
    });
  } catch (dbError: unknown) {
    logger.error("Failed to update product in DB", {
      context: "UpdateProduct",
      productId,
      error: dbError instanceof Error ? dbError.message : String(dbError),
    });
    // Don't fail the entire request if DB update fails - Shopify is source of truth
  }

  // Whether a changed/cleared primary value purges its foreign translations at
  // all — merchant switch (Settings → Übersetzungen). Read ONCE for both the
  // field purge and the alt-text purge below; fails OPEN, so an error keeps
  // the historic behaviour. See
  // services/translations/translation-change-policy.server.ts.
  const { loadTranslationChangePolicy } = await import(
    "~/services/translations/translation-change-policy.server"
  );
  const changePolicy =
    changedFields.length > 0 || changedAltTextIndices.length > 0
      ? await loadTranslationChangePolicy(shop, db)
      : null;
  // The product's own fields are re-translated by the sync, so the
  // auto-translation may supersede their deletion. ALT-TEXTS are not: they
  // live on the MediaImage resource, which the reconciliation never looks at,
  // so suppressing their deletion would leave the old alt text live for good.
  const purgeStaleTranslations = changePolicy?.purgeOnPrimaryChange ?? false;
  // ALT-TEXTS are repaired by THIS save or by nothing: they live on the
  // MediaImage resource, which no sync and no webhook in this app looks at. So
  // with auto-translate on the save re-translates them and the deletion stands
  // down — read through the policy, never written as `false`, because which of
  // the two switches applies is that module's question.
  //
  // The locales are fetched FIRST, because the decision depends on the result:
  // without a known primary locale there is nothing to translate FROM, and
  // deciding before the lookup left a throttled shop with neither the repair
  // nor the deletion.
  let altForeignLocales: string[] = [];
  let altPrimaryLocale = "";
  // The product's OWN fields need the same list when the auto-translation is on
  // — the repair below translates into every published foreign locale — so the
  // one lookup serves both. It stays gated on there being something to do.
  //
  // A bulk caller (the SEO "Fix with AI" task) hands in a budget of detached
  // runs: past it the product's own fields start no run and keep what they
  // have - the deletion answer here is `purgeOnPrimaryChange`, which the
  // auto-translation forces off, exactly the bulk editor's refused content
  // group - and the `products/update` webhook is the only reconciler left.
  const contentRepairWanted =
    changedFields.length > 0 && !!changePolicy?.autoTranslateExternalChanges;
  if ((changedAltTextIndices.length > 0 || contentRepairWanted) && changePolicy) {
    try {
      const { fetchShopLocales } = await import("~/services/sync-utils");
      const shopLocales = await fetchShopLocales(gateway.graphql.bind(gateway));
      altForeignLocales = shopLocales.filter((l) => !l.primary).map((l) => l.locale);
      altPrimaryLocale = shopLocales.find((l) => l.primary)?.locale ?? "";
    } catch (localeError: unknown) {
      // Non-fatal: the primary write has already gone through, so throwing here
      // would report a completed save as failed.
      loggers.product("warn", "Could not load shop locales — alt-text translations untouched", {
        productId,
        error: localeError instanceof Error ? localeError.message : String(localeError),
      });
    }
  }
  // The budget slot is taken only now that it is known a run CAN start (it
  // needs a foreign locale); a single-language shop never spends one.
  const contentRepairPossible =
    contentRepairWanted &&
    altForeignLocales.length > 0 &&
    (!repairBudget || repairBudget.take("content", productId));
  const retranslateAltTexts = altRepairRetranslates(changePolicy, altForeignLocales, altPrimaryLocale);
  const purgeStaleAltTextTranslations = retranslateAltTexts
    ? (changePolicy?.purgeOnPrimaryChange ?? false)
    : (changePolicy?.purgeUnreconciledSurfaces ?? false);

  // Warnings the purge below raises. The primary write has already succeeded,
  // so they travel as `warning` on a successful answer, never as a failure.
  const purgeWarnings: string[] = [];

  // Delete translations for changed fields in all foreign languages
  if (changedFields.length > 0 && purgeStaleTranslations) {
    try {
      const translationKeysToDelete = changedFields
        .map((field) => FIELD_TO_TRANSLATION_KEY[field])
        .filter((key): key is string => !!key);

      if (translationKeysToDelete.length > 0) {
        // Get all shop locales from Shopify API
        const localesResponse = await gateway.graphql(
          `#graphql
            query getShopLocales {
              shopLocales {
                locale
                primary
                published
              }
            }`
        );
        const localesData = await localesResponse.json() as any;
        const shopLocales = localesData.data?.shopLocales || [];

        // Every foreign locale, published or not (a language being prepared).
        const foreignLocales = shopLocales
          .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary)
          .map((l: { locale: string }) => l.locale);

        if (foreignLocales.length > 0) {
          loggers.product("info", "Deleting translations for changed fields", {
            productId,
            changedFields,
            translationKeys: translationKeysToDelete,
            locales: foreignLocales,
          });

          // The MARKET overrides of the same keys, first and on their own
          // layer. Nothing re-translates one (the repair writes global rows
          // only), so once the primary text moves the override is as stale as
          // the global row below it — and this branch is the one where the
          // global rows are being DELETED, so after it nothing is left that
          // would ever make anyone look at this resource again. Without it the
          // bulk editor purged a product's overrides on a title edit and the
          // single editor did not.
          try {
            const { purgeMarketOverrides } = await import(
              "~/services/translations/market-layer-purge.server"
            );
            const { contentTranslationMirror } = await import(
              "~/services/translations/stale-translation-sync.server"
            );
            await purgeMarketOverrides({
              gateway,
              mirror: contentTranslationMirror(shop),
              refs: [{ resourceId: productId, resourceType: "Product" }],
              locales: foreignLocales,
              keys: translationKeysToDelete,
              context: "Product",
            });
          } catch {
            // Logged inside; never fails a primary write that already succeeded.
          }

          // GLOBAL layer only (marketId ""): the MARKET layer was handled
          // separately, before this, and needs its own echo per market to be
          // deleted safely.
          //
          // The local rows that could be stale are asked for first, so the
          // gap re-read below only runs for a (locale, key) that really has a
          // row to delete: Shopify echoes what it DELETED, so a DB-only mirror
          // row (digest null, written on purpose) comes back unechoed and
          // would otherwise never be purged. A failed lookup just means every
          // gap is re-read.
          let localPairs: Set<string> | undefined;
          try {
            const localRows = await db.contentTranslation.findMany({
              where: {
                shop,
                resourceId: productId,
                resourceType: "Product",
                marketId: "",
                key: { in: translationKeysToDelete },
                locale: { in: foreignLocales },
              },
              select: { locale: true, key: true },
            });
            localPairs = new Set(
              localRows.map((row: { locale: string; key: string }) => `${row.locale}${LOCALE_KEY_SEP}${row.key}`),
            );
          } catch {
            localPairs = undefined;
          }

          // Verified removal: ONE multi-locale call, then the single-locale
          // re-read for a locale that has a gap (removeVerifiedWithGapReread).
          const removal = await removeVerifiedWithGapReread(
            gateway,
            productId,
            translationKeysToDelete,
            foreignLocales,
            "",
            { localPairs },
          );
          if (removal.userErrors.length > 0) {
            logger.error("Shopify translationsRemove API error (primary update)", {
              context: "UpdateProduct",
              errors: removal.userErrors,
            });
          }

          // Delete from the local database ONLY the pairs Shopify confirmed
          // (CLAUDE.md: an unconfirmed removal keeps its row), always with the
          // shop in the filter.
          const confirmedWhere = confirmedPairsWhere(
            removal.confirmedPairs,
            translationKeysToDelete,
            foreignLocales,
          );
          if (confirmedWhere) {
            await db.contentTranslation.deleteMany({
              where: {
                shop,
                resourceId: productId,
                resourceType: "Product",
                marketId: "",
                ...confirmedWhere,
              },
            });
          }

          if (removal.unconfirmedPairs.length > 0) {
            const pairs = removal.unconfirmedPairs.map((p) => p.split(LOCALE_KEY_SEP));
            const keys = [...new Set(pairs.map(([, key]) => key))];
            const locales = [...new Set(pairs.map(([locale]) => locale))];
            purgeWarnings.push(
              `Shopify did not confirm removing the outdated translation of (${keys.join(", ")}) in (${locales.join(", ")}). It was kept and is still live on Shopify — please save again.`,
            );
          }

          loggers.product("info", "Purged foreign translations of the changed fields", {
            productId,
            keys: translationKeysToDelete,
            locales: foreignLocales,
            confirmed: removal.confirmedPairs.size,
            unconfirmed: removal.unconfirmedPairs.length,
          });
        }
      }
    } catch (translationError: unknown) {
      logger.error("Failed to delete translations for changed fields", {
        context: "UpdateProduct",
        productId,
        changedFields,
        error: translationError instanceof Error ? translationError.message : String(translationError),
      });
      // Don't fail the request - primary update succeeded -- but say so: the
      // old translations may still be live.
      purgeWarnings.push(
        "The primary text was saved, but the outdated translations could not be removed. They are kept and are still live on Shopify — please save again.",
      );
    }
  }

  // The product's OWN fields, with the auto-translation on: REPLACE the stale
  // translations instead of deleting them — and write the ones that were never
  // there.
  //
  // This used to be the `products/update` webhook's job alone, and for a
  // product that HAS translations it still does it (the claim below makes the
  // webhook stand down for this save's own run, and a later one finds the
  // digests the repair wrote and proves nothing). What the webhook can never do
  // is repair a product nobody has translated yet: its gate compares digests
  // stored ON TRANSLATION ROWS, so with no rows there is no baseline and
  // nothing can be proven — which is exactly the state a merchant is in when
  // they switch the feature on. So the save owes the repair here too.
  //
  // Best-effort by contract: the primary write is already through, so a failure
  // may not fail the save.
  if (contentRepairPossible && altForeignLocales.length > 0) {
    try {
      // The SAME map the purge above uses — they are the two branches of one
      // decision, so a second copy here would purge a field on one switch
      // setting and re-translate it on the other.
      const changedKeys = [
        ...new Set(
          changedFields
            .map((field) => FIELD_TO_TRANSLATION_KEY[field])
            .filter((key): key is string => !!key),
        ),
      ];
      if (changedKeys.length > 0) {
        const { reconcileAfterPrimarySave } = await import(
          "~/services/translations/stale-translation-sync.server"
        );
        const contentOutcome = await reconcileAfterPrimarySave({
          client: gateway,
          shop,
          resourceId: productId,
          resourceType: "Product",
          contentKind: "product",
          resourceTitle: (data.data.productUpdate.product?.title as string) || productId,
          // No `lockId`: this claims the PRODUCT itself, which is the point —
          // it is what makes the `products/update` webhook arriving from this
          // very save skip the reconciliation instead of queueing a second run
          // behind ours. The alt-text repair beside it claims a private key for
          // the opposite reason: it repairs a MediaImage, not the product.
          changed: changedKeys.map((key) => ({ key })),
          foreignLocales: altForeignLocales,
          policy: changePolicy!,
        });
        if (contentOutcome.taskId) retranslationTaskIds.push(contentOutcome.taskId);
      }
    } catch (repairError: unknown) {
      loggers.product("warn", "Auto-translation of the changed fields could not start", {
        productId,
        error: repairError instanceof Error ? repairError.message : String(repairError),
      });
    }
  }

  // The alt texts this save rewrote: purged or re-translated, by the ONE
  // implementation the image manager's per-image save calls too
  // (product-alt-repair.server.ts).
  if (changedAltTextIndices.length > 0 && (purgeStaleAltTextTranslations || retranslateAltTexts) && changePolicy) {
    try {
      const dbProduct = await db.product.findUnique({
        where: { shop_id: { shop, id: productId } },
        include: { images: { orderBy: { position: "asc" } } },
      });
      const changes: ProductAltChange[] = [];
      for (const index of changedAltTextIndices) {
        const image = dbProduct?.images?.[index];
        if (!image) continue;
        const written = params.confirmedAltTexts?.[index] ?? params.imageAltTexts?.[index];
        changes.push({
          imageId: image.id,
          mediaId: image.mediaId ?? null,
          ...(typeof written === "string" ? { alt: written } : {}),
        });
      }
      const altOutcome = await repairChangedProductAlts({
        gateway,
        db,
        shop,
        productId,
        productTitle: (data.data.productUpdate.product?.title as string) || productId,
        changes,
        policy: changePolicy,
        foreignLocales: altForeignLocales,
        primaryLocale: altPrimaryLocale,
      });
      if (altOutcome.taskId) retranslationTaskIds.push(altOutcome.taskId);
    } catch (altError: unknown) {
      loggers.product("warn", "Alt-text translation repair failed — translations kept", {
        productId,
        error: altError instanceof Error ? altError.message : String(altError),
      });
    }
  }

  return json({
    success: true,
    product: data.data.productUpdate.product,
    retranslationTaskIds: collectRetranslationTaskIds(retranslationTaskIds),
    ...(purgeWarnings.length > 0 ? { warning: purgeWarnings.join(" ") } : {}),
    // §Phase 3.1 — a rule-based membership the picker asked to remove was
    // kept. Reported rather than silent: the merchant unticked a box and the
    // product is still in the collection, and only this line explains why.
    ...(membershipNotes.length > 0 ? { attributeWarnings: membershipNotes } : {}),
  });
}
