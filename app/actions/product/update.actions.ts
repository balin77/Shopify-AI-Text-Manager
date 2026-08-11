/**
 * Product Update Action
 *
 * Handles saving product changes back to Shopify and local database:
 * - Updates primary locale products directly via productUpdate mutation
 * - Updates translated locales via translationsRegister mutation
 * - Syncs changes to local database for caching
 * - Handles image alt-text updates for all locales
 */

import { data as json } from "react-router";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import { sanitizeSlug } from "~/utils/slug.utils";
import { logger, loggers } from "~/utils/logger.server";
import { markTranslationSaved } from "~/utils/translation-save-lock.server";
import type { ActionContext } from "./shared/action-context";
import { getFormString, getFormStringOrNull, getFormJSON } from "~/utils/form-data.utils";
import { isValidLocale, safeJsonParse } from "~/utils/validation";
import type { PrismaClient } from "@prisma/client";
import type { DataResponse } from "~/types/data-response";
import { readDataPayload, readDataStatus } from "~/utils/data-response";

interface UpdateProductParams {
  locale: string;
  primaryLocale: string;
  title?: string;
  descriptionHtml?: string;
  handle?: string;
  seoTitle?: string;
  metaDescription?: string;
  productType?: string;
  imageAltTexts?: Record<number, string>;
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
  productId: string
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
      response = await updatePrimaryProduct(gateway, db, productId, params, changedFields, changedAltTextIndices, context.session.shop);
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
      // TRANSLATION: Handle alt-text translation for foreign locales
      const altTextValue = String(altText ?? "");

      if (altTextValue.trim() === "") {
        // EMPTY VALUE: Use translationsRemove to delete the translation from Shopify
        // (same pattern as regular text fields in updateTranslatedProduct)
        try {
          const removeResponse = await gateway.graphql(
            `#graphql
              mutation removeAltTextTranslation($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!, $marketIds: [ID!]) {
                translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales, marketIds: $marketIds) {
                  userErrors {
                    field
                    message
                  }
                  translations {
                    key
                    locale
                  }
                }
              }`,
            {
              variables: {
                resourceId: mediaImageId,
                translationKeys: ["alt"],
                locales: [params.locale],
                marketIds: marketId ? [marketId] : null,
              },
            }
          );

          const removeData = await removeResponse.json() as any;
          const userErrors = removeData.data?.translationsRemove?.userErrors || [];
          if (userErrors.length > 0) {
            loggers.product("error", "Failed to remove alt-text translation", { index, locale: params.locale, errors: userErrors });
          } else {
            shopifySaved = true;
            loggers.product("debug", "Removed alt-text translation via translationsRemove", { index, locale: params.locale });
          }
        } catch (err: unknown) {
          loggers.product("error", "translationsRemove exception for alt-text", { index, locale: params.locale, error: err instanceof Error ? err.message : String(err) });
        }
      } else {
        // NON-EMPTY VALUE: Use translationsRegister (requires digest from primary content)
        let altDigest: string | undefined;
        try {
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
            { variables: { resourceId: mediaImageId } }
          );

          const translatableData = await translatableResponse.json() as any;
          const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
          altDigest = translatableContent.find((c: { key: string; digest?: string }) => c.key === "alt")?.digest;
        } catch (err: unknown) {
          loggers.product("error", "Error fetching translatable content for alt-text", { index, error: err instanceof Error ? err.message : String(err) });
        }

        if (!altDigest) {
          loggers.product("warn", "No digest found for alt-text translation - cannot save to Shopify", {
            index, mediaImageId, locale: params.locale,
          });
        } else {
          try {
            const translateResponse = await gateway.graphql(
              `#graphql
                mutation translateMediaImage($resourceId: ID!, $translations: [TranslationInput!]!) {
                  translationsRegister(resourceId: $resourceId, translations: $translations) {
                    userErrors {
                      field
                      message
                    }
                    translations {
                      locale
                      key
                      value
                    }
                  }
                }`,
              {
                variables: {
                  resourceId: mediaImageId,
                  translations: [
                    {
                      key: "alt",
                      value: altTextValue,
                      locale: params.locale,
                      translatableContentDigest: altDigest,
                      ...(marketId ? { marketId } : {}),
                    },
                  ],
                },
              }
            );

            const translateData = await translateResponse.json() as any;
            const userErrors = translateData.data?.translationsRegister?.userErrors || [];
            if (userErrors.length > 0) {
              loggers.product("error", "Failed to translate alt-text", { index, locale: params.locale, errors: userErrors });
            } else {
              shopifySaved = true;
              loggers.product("debug", "Translated alt-text via translationsRegister", { index, locale: params.locale });
            }
          } catch (err: unknown) {
            loggers.product("error", "translationsRegister exception for alt-text", { index, locale: params.locale, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }

    // Save to Database ONLY if Shopify save succeeded (no mismatch allowed)
    if (shopifySaved && dbImage) {
      try {
        if (params.locale === params.primaryLocale) {
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
        } else {
          const altTextValue = String(altText ?? "");
          if (altTextValue.trim() === "") {
            // Empty value: delete the (market-scoped) translation record from DB
            await db.productImageAltTranslation.deleteMany({
              where: { imageId: dbImage.id, locale: params.locale, marketId },
            });
            loggers.product("debug", "Deleted alt-text translation from DB", { index, locale: params.locale, marketId: marketId || '(global)' });
          } else {
            // Atomic upsert to avoid race condition between findUnique + create
            await db.productImageAltTranslation.upsert({
              where: { imageId_locale_marketId: { imageId: dbImage.id, locale: params.locale, marketId } },
              update: { altText: altTextValue },
              create: { imageId: dbImage.id, locale: params.locale, altText: altTextValue, marketId },
            });
            loggers.product("debug", "Upserted alt-text translation in DB", { index, locale: params.locale });
          }
        }
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
    addTranslation("title", params.title);
  } else if (params.title === "") {
    // Empty string means user wants to delete the translation
    translationsToDelete.push("title");
  }

  if (params.descriptionHtml && params.descriptionHtml.trim()) {
    addTranslation("body_html", params.descriptionHtml);
  } else if (params.descriptionHtml === "") {
    translationsToDelete.push("body_html");
  }

  if (params.handle && params.handle.trim()) {
    addTranslation("handle", params.handle);
  } else if (params.handle === "") {
    translationsToDelete.push("handle");
  }

  if (params.seoTitle && params.seoTitle.trim()) {
    addTranslation("meta_title", params.seoTitle);
  } else if (params.seoTitle === "") {
    translationsToDelete.push("meta_title");
  }

  if (params.metaDescription && params.metaDescription.trim()) {
    addTranslation("meta_description", params.metaDescription);
  } else if (params.metaDescription === "") {
    translationsToDelete.push("meta_description");
  }

  if (params.productType && params.productType.trim()) {
    addTranslation("product_type", params.productType);
  } else if (params.productType === "") {
    translationsToDelete.push("product_type");
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

  // Save non-empty translations to Shopify
  if (translationsInput.length > 0) {
    const response = await gateway.graphql(
      `#graphql
        mutation translateProduct($resourceId: ID!, $translations: [TranslationInput!]!) {
          translationsRegister(resourceId: $resourceId, translations: $translations) {
            userErrors {
              field
              message
            }
            translations {
              locale
              key
              value
            }
          }
        }`,
      {
        variables: {
          resourceId: productId,
          // Add marketId to each input for a market-specific override; omit for global.
          translations: marketId
            ? translationsInput.map((t) => ({ ...t, marketId }))
            : translationsInput,
        },
      }
    );

    const responseData = await response.json() as any;
    if (responseData.data?.translationsRegister?.userErrors?.length > 0) {
      logger.error("Shopify translation API error", {
        context: "UpdateProduct",
        errors: responseData.data.translationsRegister.userErrors,
      });
      return json(
        {
          success: false,
          error: responseData.data.translationsRegister.userErrors[0].message,
        },
        { status: 500 }
      );
    }

    loggers.product("info", "Saved translations to Shopify", {
      productId,
      locale: params.locale,
      count: translationsInput.length,
    });
  }

  // Delete cleared translations from Shopify using translationsRemove
  if (translationsToDelete.length > 0) {
    const response = await gateway.graphql(
      `#graphql
        mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!, $marketIds: [ID!]) {
          translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales, marketIds: $marketIds) {
            userErrors {
              field
              message
            }
            translations {
              key
              locale
            }
          }
        }`,
      {
        variables: {
          resourceId: productId,
          translationKeys: translationsToDelete,
          locales: [params.locale],
          // Market-scoped removal keeps the global translation intact; global
          // removal (marketId "") omits marketIds.
          marketIds: marketId ? [marketId] : null,
        },
      }
    );

    const responseData = await response.json() as any;
    if (responseData.data?.translationsRemove?.userErrors?.length > 0) {
      logger.error("Shopify translationsRemove API error", {
        context: "UpdateProduct",
        errors: responseData.data.translationsRemove.userErrors,
      });
      return json(
        {
          success: false,
          error: responseData.data.translationsRemove.userErrors[0].message,
        },
        { status: 500 }
      );
    }

    loggers.product("info", "Removed translations from Shopify", {
      productId,
      locale: params.locale,
      keys: translationsToDelete,
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
      // Save all translations to DB — both Shopify-saved and DB-only (no digest)
      for (const translation of [...translationsInput, ...dbOnlyTranslations]) {
        await tx.contentTranslation.upsert({
          where: {
            // Unique constraint: @@unique([shop, resourceId, key, locale, marketId])
            shop_resourceId_key_locale_marketId: {
              shop: product.shop,
              resourceId: productId,
              key: translation.key,
              locale: translation.locale,
              marketId,
            },
          },
          update: {
            value: translation.value,
            digest: null,
            resourceType: "Product", // Update resourceType in case it changed
          },
          create: {
            shop: product.shop,
            resourceId: productId,
            resourceType: "Product",
            key: translation.key,
            value: translation.value,
            locale: translation.locale,
            digest: null,
            marketId,
          },
        });
      }

      // Delete translations that were cleared by the user (scoped to this market)
      for (const key of translationsToDelete) {
        await tx.contentTranslation.deleteMany({
          where: {
            resourceId: productId,
            resourceType: "Product",
            locale: params.locale,
            marketId,
            key: key,
          },
        });
      }
    });

    // Mark this product as recently saved so webhook syncs don't overwrite
    markTranslationSaved(productId);

    loggers.product("info", "Saved translations to DB (ContentTranslation)", {
      productId,
      locale: params.locale,
      savedToShopifyAndDb: translationsInput.length,
      savedToDbOnly: dbOnlyTranslations.length,
      deleted: translationsToDelete.length,
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
  shop: string
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

  const response = await gateway.graphql(
    `#graphql
      mutation updateProduct($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            title
            handle
            descriptionHtml
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

  // Update local database
  try {
    const updateData: Record<string, string | Date | null> = {};
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

    // Always update lastSyncedAt
    updateData.lastSyncedAt = new Date();

    await db.product.update({
      where: { shop_id: { shop, id: productId } },
      data: updateData,
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

  // Delete translations for changed fields in all foreign languages
  if (changedFields.length > 0) {
    try {
      // Map field names to Shopify translation keys
      const fieldToKeyMap: Record<string, string> = {
        title: "title",
        description: "body_html",
        handle: "handle",
        seoTitle: "meta_title",
        metaDescription: "meta_description",
        productType: "product_type",
      };

      const translationKeysToDelete = changedFields
        .map((field) => fieldToKeyMap[field])
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

        // Filter out the primary locale, only keep published foreign locales
        const foreignLocales = shopLocales
          .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary && l.published)
          .map((l: { locale: string }) => l.locale);

        if (foreignLocales.length > 0) {
          loggers.product("info", "Deleting translations for changed fields", {
            productId,
            changedFields,
            translationKeys: translationKeysToDelete,
            locales: foreignLocales,
          });

          // Delete translations from Shopify
          const response = await gateway.graphql(
            `#graphql
              mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
                translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                  userErrors {
                    field
                    message
                  }
                  translations {
                    key
                    locale
                  }
                }
              }`,
            {
              variables: {
                resourceId: productId,
                translationKeys: translationKeysToDelete,
                locales: foreignLocales,
              },
            }
          );

          const responseData = await response.json() as any;
          if (responseData.data?.translationsRemove?.userErrors?.length > 0) {
            logger.error("Shopify translationsRemove API error (primary update)", {
              context: "UpdateProduct",
              errors: responseData.data.translationsRemove.userErrors,
            });
            // Don't fail the request - primary update succeeded
          } else {
            loggers.product("info", "Deleted translations from Shopify", {
              productId,
              keys: translationKeysToDelete,
              locales: foreignLocales,
            });
          }

          // Delete translations from local database (using transaction for consistency)
          // @ts-expect-error Prisma interactive transaction types are complex; tx has same model accessors as db
    await db.$transaction(async (tx: PrismaClient) => {
            for (const key of translationKeysToDelete) {
              await tx.contentTranslation.deleteMany({
                where: {
                  resourceId: productId,
                  resourceType: "Product",
                  // Global only — mirrors the global-only Shopify removal so market
                  // overrides are preserved on both sides (no DB/Shopify divergence).
                  marketId: "",
                  key: key,
                  locale: { in: foreignLocales },
                },
              });
            }
          });

          loggers.product("info", "Deleted translations from DB", {
            productId,
            keys: translationKeysToDelete,
            locales: foreignLocales,
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
      // Don't fail the request - primary update succeeded
    }
  }

  // Delete alt-text translations for changed image indices in all foreign languages
  if (changedAltTextIndices.length > 0) {
    try {
      // Get all shop locales from Shopify API (reuse if already fetched above)
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

      // Filter out the primary locale, only keep published foreign locales
      const foreignLocales = shopLocales
        .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary && l.published)
        .map((l: { locale: string }) => l.locale);

      if (foreignLocales.length > 0) {
        // Get product images from DB to find mediaIds
        const dbProduct = await db.product.findUnique({
          where: { shop_id: { shop, id: productId } },
          include: {
            images: {
              orderBy: { position: 'asc' },
            },
          },
        });

        if (dbProduct?.images) {
          // Collect all Shopify API calls first, then batch DB deletes in a transaction
          const shopifyDeletePromises: Promise<void>[] = [];
          const imageIdsToDeleteTranslations: string[] = [];

          for (const imageIndex of changedAltTextIndices) {
            const dbImage = dbProduct.images[imageIndex];
            if (!dbImage) continue;

            const mediaImageId = dbImage.mediaId;
            imageIdsToDeleteTranslations.push(dbImage.id);

            loggers.product("info", "Deleting alt-text translations for changed image", {
              productId,
              imageIndex,
              mediaImageId,
              locales: foreignLocales,
            });

            // Delete translations from Shopify if we have the mediaId
            if (mediaImageId) {
              shopifyDeletePromises.push(
                (async () => {
                  const response = await gateway.graphql(
                    `#graphql
                      mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
                        translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                          userErrors {
                            field
                            message
                          }
                          translations {
                            key
                            locale
                          }
                        }
                      }`,
                    {
                      variables: {
                        resourceId: mediaImageId,
                        translationKeys: ["alt"],
                        locales: foreignLocales,
                      },
                    }
                  );

                  const responseData = await response.json() as any;
                  if (responseData.data?.translationsRemove?.userErrors?.length > 0) {
                    logger.error("Shopify translationsRemove API error (alt-text)", {
                      context: "UpdateProduct",
                      imageIndex,
                      mediaImageId,
                      errors: responseData.data.translationsRemove.userErrors,
                    });
                  } else {
                    loggers.product("info", "Deleted alt-text translations from Shopify", {
                      productId,
                      imageIndex,
                      mediaImageId,
                      locales: foreignLocales,
                    });
                  }
                })()
              );
            }
          }

          // Execute Shopify API calls (these can't be in a DB transaction)
          await Promise.all(shopifyDeletePromises);

          // Delete translations from local database (using transaction for consistency)
          if (imageIdsToDeleteTranslations.length > 0) {
            // @ts-expect-error Prisma interactive transaction types are complex; tx has same model accessors as db
    await db.$transaction(async (tx: PrismaClient) => {
              for (const imageId of imageIdsToDeleteTranslations) {
                await tx.productImageAltTranslation.deleteMany({
                  where: {
                    imageId: imageId,
                    // Global-scoped to mirror the global-only Shopify removal —
                    // market-specific alt overrides survive on both sides.
                    marketId: "",
                    locale: { in: foreignLocales },
                  },
                });
              }
            });

            loggers.product("info", "Deleted alt-text translations from DB", {
              productId,
              imageIds: imageIdsToDeleteTranslations,
              locales: foreignLocales,
            });
          }
        }
      }
    } catch (altTextTranslationError: unknown) {
      logger.error("Failed to delete alt-text translations for changed images", {
        context: "UpdateProduct",
        productId,
        changedAltTextIndices,
        error: altTextTranslationError instanceof Error ? altTextTranslationError.message : String(altTextTranslationError),
      });
      // Don't fail the request - primary update succeeded
    }
  }

  return json({ success: true, product: data.data.productUpdate.product });
}
