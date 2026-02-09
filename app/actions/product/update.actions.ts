/**
 * Product Update Action
 *
 * Handles saving product changes back to Shopify and local database:
 * - Updates primary locale products directly via productUpdate mutation
 * - Updates translated locales via translationsRegister mutation
 * - Syncs changes to local database for caching
 * - Handles image alt-text updates for all locales
 */

import { json } from "@remix-run/node";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import { sanitizeSlug } from "~/utils/slug.utils";
import { logger, loggers } from "~/utils/logger.server";
import type { ActionContext } from "./shared/action-context";

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
}

/**
 * Updates product in Shopify and local database
 */
export async function handleUpdateProduct(
  context: ActionContext,
  formData: FormData,
  productId: string
): Promise<Response> {
  const { db } = await import("~/db.server");

  // Parse changedFields if present (for translation deletion when primary locale changes)
  const changedFieldsStr = formData.get("changedFields") as string;
  const changedFields: string[] = changedFieldsStr ? JSON.parse(changedFieldsStr) : [];

  // Parse changedAltTextIndices if present (for alt-text translation deletion when primary locale changes)
  const changedAltTextIndicesStr = formData.get("changedAltTextIndices") as string;
  const changedAltTextIndices: number[] = changedAltTextIndicesStr ? JSON.parse(changedAltTextIndicesStr) : [];

  const params: UpdateProductParams = {
    locale: formData.get("locale") as string,
    primaryLocale: formData.get("primaryLocale") as string,
    title: formData.get("title") as string,
    descriptionHtml: formData.get("descriptionHtml") as string,
    handle: formData.get("handle") as string,
    seoTitle: formData.get("seoTitle") as string,
    metaDescription: formData.get("metaDescription") as string,
    productType: formData.get("productType") as string,
    imageAltTexts: formData.get("imageAltTexts")
      ? JSON.parse(formData.get("imageAltTexts") as string)
      : {},
    productId,
  };

  logger.info("Product update requested", {
    context: "UpdateProduct",
    productId,
    locale: params.locale,
    primaryLocale: params.primaryLocale,
    hasAltTexts: Object.keys(params.imageAltTexts || {}).length > 0,
  });

  // 🧪 DEBUG MODE: Skip Shopify sync for testing
  // Add ?skipShopifySync=true to URL to only save to DB without syncing to Shopify
  const skipShopifySync = formData.get("skipShopifySync") === "true";
  if (skipShopifySync) {
    logger.warn("⚠️ [DEBUG MODE] Skipping Shopify sync - only saving to local DB", {
      context: "UpdateProduct",
      productId,
      locale: params.locale,
    });

    // Only update local DB without Shopify sync
    try {
      // Update translations in DB
      if (params.locale !== params.primaryLocale) {
        // For translations: Update ContentTranslation table
        const translationKeys = {
          title: "translatedBody",
          description: "body",
          handle: "handle",
          seoTitle: "seo_title",
          metaDescription: "seo_description",
          productType: "product_type",
        };

        for (const [fieldKey, translationKey] of Object.entries(translationKeys)) {
          const value = (params as any)[fieldKey === 'description' ? 'descriptionHtml' : fieldKey];
          if (value !== undefined && value !== null) {
            await db.contentTranslation.upsert({
              where: {
                resourceId_key_locale: {
                  resourceId: productId,
                  locale: params.locale,
                  key: translationKey,
                },
              },
              update: { value },
              create: {
                resourceId: productId,
                resourceType: "Product",
                locale: params.locale,
                key: translationKey,
                value,
              },
            });
          }
        }
      } else {
        // For primary locale: Update Product table directly
        const updateData: any = {};
        if (params.title) updateData.title = params.title;
        if (params.descriptionHtml !== undefined) updateData.descriptionHtml = params.descriptionHtml;
        if (params.handle) updateData.handle = params.handle;
        if (params.seoTitle !== undefined) updateData.seoTitle = params.seoTitle;
        if (params.metaDescription !== undefined) updateData.seoDescription = params.metaDescription;
        if (params.productType) {
          updateData.productType = params.productType;
        } else if (changedFields.includes('productType')) {
          updateData.productType = params.productType || null;
        }

        await db.product.update({
          where: { id: productId },
          data: updateData,
        });
      }

      logger.info("✅ [DEBUG MODE] Successfully saved to DB (Shopify sync skipped)", {
        context: "UpdateProduct",
        productId,
      });

      return json({
        success: true,
        message: "⚠️ DEBUG MODE: Saved to DB only (Shopify sync skipped)",
      });
    } catch (error: any) {
      logger.error("[DEBUG MODE] DB update failed", {
        context: "UpdateProduct",
        error: error.message,
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

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
    if (params.imageAltTexts && Object.keys(params.imageAltTexts).length > 0) {
      await updateImageAltTexts(gateway, db, productId, params);
    }

    // Check if this is a translation update or primary locale update
    if (params.locale !== params.primaryLocale) {
      return await updateTranslatedProduct(gateway, db, productId, params);
    } else {
      return await updatePrimaryProduct(gateway, db, productId, params, changedFields, changedAltTextIndices, context.session.shop);
    }
  } catch (error: any) {
    logger.error("Product update failed", {
      context: "UpdateProduct",
      productId,
      error: error.message,
    });
    return json({ success: false, error: error.message }, { status: 500 });
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
  db: any,
  productId: string,
  params: UpdateProductParams
): Promise<void> {
  loggers.product("info", "Updating image alt-texts", {
    productId,
    locale: params.locale,
    isPrimary: params.locale === params.primaryLocale,
    count: Object.keys(params.imageAltTexts || {}).length,
  });

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

  const productData = await productResponse.json();

  // Filter to only include valid MediaImage nodes (exclude videos, 3D models, etc.)
  const mediaEdges = (productData.data?.product?.media?.edges || [])
    .filter((edge: any) => edge.node?.id); // Only keep nodes with an id (MediaImage type)

  // Get DB product images (sorted by position to match UI order)
  const dbProduct = await db.product.findUnique({
    where: { id: productId },
    include: {
      images: {
        orderBy: { position: 'asc' },
      },
    },
  });

  // Update each image with new alt-text
  for (const [indexStr, altText] of Object.entries(params.imageAltTexts || {})) {
    const index = parseInt(indexStr);
    const dbImage = dbProduct?.images[index];

    // Prefer mediaId from DB (more reliable), fallback to Shopify query by index
    let mediaImageId = dbImage?.mediaId;

    if (!mediaImageId && index < mediaEdges.length && mediaEdges[index]?.node?.id) {
      mediaImageId = mediaEdges[index].node.id;
      loggers.product("debug", "Using mediaId from Shopify query (DB mediaId not found)", { index });
    }

    if (!mediaImageId) {
      loggers.product("warn", "No mediaId found for image - skipping Shopify update", {
        index,
        hasDbImage: !!dbImage,
        dbImageMediaId: dbImage?.mediaId,
      });
      // Still save to DB if we have a dbImage
      if (dbImage) {
        try {
          if (params.locale === params.primaryLocale) {
            // When altText is empty string, save as null for consistency
            const altTextToSave = altText === "" ? null : altText;
            await db.productImage.update({
              where: { id: dbImage.id },
              data: {
                altText: altTextToSave,
                altTextModifiedAt: new Date(), // Prevent webhook sync from overwriting
              },
            });
          } else {
            const existing = await db.productImageAltTranslation.findUnique({
              where: { imageId_locale: { imageId: dbImage.id, locale: params.locale } },
            });
            if (existing) {
              await db.productImageAltTranslation.update({ where: { id: existing.id }, data: { altText } });
            } else {
              await db.productImageAltTranslation.create({ data: { imageId: dbImage.id, locale: params.locale, altText } });
            }
          }
          loggers.product("debug", "Saved alt-text to DB only (no Shopify sync)", { index, locale: params.locale });
        } catch (dbError: any) {
          // If the image was deleted by a concurrent sync, log and continue
          if (dbError.code === 'P2025' || dbError.code === 'P2003' || dbError.message?.includes('Foreign key constraint')) {
            loggers.product("warn", "Image was deleted during alt-text save (concurrent sync)", {
              index, locale: params.locale, error: dbError.message,
            });
          } else {
            throw dbError;
          }
        }
      }
      continue;
    }

    loggers.product("debug", "Updating image alt-text", {
      index,
      mediaImageId,
      locale: params.locale,
      isPrimary: params.locale === params.primaryLocale,
      mediaIdSource: dbImage?.mediaId ? "database" : "shopify-query",
    });

    if (params.locale === params.primaryLocale) {
      // PRIMARY LOCALE: Use productUpdateMedia mutation
      const updateMediaResponse = await gateway.graphql(
        `#graphql
          mutation updateMedia($media: [UpdateMediaInput!]!) {
            productUpdateMedia(media: $media, productId: "${productId}") {
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
      const updateMediaData = await updateMediaResponse.json();
      // Log what Shopify returned
      const returnedAlt = updateMediaData.data?.productUpdateMedia?.media?.[0]?.alt;
      logger.debug(`[ProductUpdate] [SHOPIFY-RESPONSE] mediaId: ${mediaImageId}, sent alt: "${altText}", returned alt: "${returnedAlt}"`);
      if (updateMediaData.data?.productUpdateMedia?.mediaUserErrors?.length > 0) {
        loggers.product("error", "productUpdateMedia errors", {
          index,
          errors: updateMediaData.data.productUpdateMedia.mediaUserErrors
        });
      }
      loggers.product("debug", "Updated primary alt-text via productUpdateMedia", { index, sentAlt: altText, returnedAlt });
    } else {
      // TRANSLATION: Use translationsRegister mutation with MEDIA_IMAGE resource type (API 2025-10+)
      // First, fetch the translatable content to get the digest
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

      const translatableData = await translatableResponse.json();
      const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
      const altDigest = translatableContent.find((c: any) => c.key === "alt")?.digest;

      if (altDigest) {
        // Register the translation
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
                  value: altText,
                  locale: params.locale,
                  translatableContentDigest: altDigest,
                },
              ],
            },
          }
        );

        const translateData = await translateResponse.json();

        if (translateData.data?.translationsRegister?.userErrors?.length > 0) {
          loggers.product("error", "Failed to translate alt-text", {
            index,
            locale: params.locale,
            errors: translateData.data.translationsRegister.userErrors,
          });
        } else {
          loggers.product("debug", "Translated alt-text via translationsRegister", {
            index,
            locale: params.locale,
          });
        }
      } else {
        loggers.product("warn", "No digest found for alt-text translation", {
          index,
          mediaImageId,
          locale: params.locale,
        });
      }
    }

    // Save to Database (dbImage was already fetched above)
    if (dbImage) {
      try {
        if (params.locale === params.primaryLocale) {
          // Primary locale: Update ProductImage table
          // When altText is empty string, save as null for consistency
          const altTextToSave = altText === "" ? null : altText;
          logger.debug('[ProductUpdate] SAVING ALT-TEXT TO DATABASE (PRIMARY)');
          logger.debug(`[ProductUpdate] dbImage.id: ${dbImage.id}`);
          logger.debug(`[ProductUpdate] altText to save: "${altTextToSave}" (original: "${altText}", isEmpty: ${altText === ""})`);
          await db.productImage.update({
            where: { id: dbImage.id },
            data: {
              altText: altTextToSave,
              altTextModifiedAt: new Date(), // Prevent webhook sync from overwriting
            },
          });
          // Verify the save worked
          const savedImage = await db.productImage.findUnique({
            where: { id: dbImage.id },
            select: { altText: true },
          });
          logger.debug(`[ProductUpdate] Verified saved altText: "${savedImage?.altText}" (isNull: ${savedImage?.altText === null})`);
          loggers.product("debug", "Updated primary alt-text in DB", { index, altTextSaved: altTextToSave });
        } else {
          // Translation: Update ProductImageAltTranslation table
          const existing = await db.productImageAltTranslation.findUnique({
            where: {
              imageId_locale: {
                imageId: dbImage.id,
                locale: params.locale,
              },
            },
          });

          if (existing) {
            await db.productImageAltTranslation.update({
              where: { id: existing.id },
              data: { altText },
            });
          } else {
            await db.productImageAltTranslation.create({
              data: {
                imageId: dbImage.id,
                locale: params.locale,
                altText: altText,
              },
            });
          }
          loggers.product("debug", "Saved alt-text translation in DB", {
            index,
            locale: params.locale,
          });
        }
      } catch (dbError: any) {
        // If the image was deleted by a concurrent sync, log and continue
        if (dbError.code === 'P2025' || dbError.code === 'P2003' || dbError.message?.includes('Foreign key constraint')) {
          loggers.product("warn", "Image was deleted during alt-text save (concurrent sync)", {
            index, locale: params.locale, error: dbError.message,
          });
        } else {
          throw dbError;
        }
      }
    }
  }

}

/**
 * Updates a translated product (non-primary locale)
 */
async function updateTranslatedProduct(
  gateway: ShopifyApiGateway,
  db: any,
  productId: string,
  params: UpdateProductParams
): Promise<Response> {
  loggers.product("info", "Updating translated product", {
    productId,
    locale: params.locale,
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

  const translatableData = await translatableResponse.json();
  const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];

  // Log ALL entries from Shopify (including those without digest)
  loggers.product("debug", "Raw translatableContent from Shopify", {
    productId,
    totalEntries: translatableContent.length,
    entries: translatableContent.map((item: any) => ({
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
      .filter((item: any) => !item.digest)
      .map((item: any) => item.key),
  });

  const translationsInput: Array<{ key: string; value: string; locale: string; translatableContentDigest: string }> = [];
  const translationsToDelete: string[] = [];
  const skippedFields: string[] = [];

  // Helper to add translation - only adds if digest is available (required by Shopify)
  const addTranslation = (key: string, value: string) => {
    if (digestMap[key]) {
      translationsInput.push({ key, value, locale: params.locale, translatableContentDigest: digestMap[key] });
    } else {
      skippedFields.push(key);
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

  if (skippedFields.length > 0) {
    loggers.product("warn", "Skipped Shopify save for fields without digest (will save to DB only)", {
      productId,
      locale: params.locale,
      skippedFields,
      availableDigestKeys: Object.keys(digestMap),
    });
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
          translations: translationsInput,
        },
      }
    );

    const responseData = await response.json();
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
          translationKeys: translationsToDelete,
          locales: [params.locale],
        },
      }
    );

    const responseData = await response.json();
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

  // Update local database using ContentTranslation table (unified pattern)
  const product = await db.product.findFirst({
    where: { id: productId },
    select: { shop: true },
  });

  if (product) {
    // Use transaction to ensure all upserts and deletes succeed or fail together
    await db.$transaction(async (tx: any) => {
      // Use upsert to preserve existing translations for other fields
      for (const translation of translationsInput) {
        await tx.contentTranslation.upsert({
          where: {
            // Unique constraint is: @@unique([resourceId, key, locale])
            resourceId_key_locale: {
              resourceId: productId,
              key: translation.key,
              locale: translation.locale,
            },
          },
          update: {
            value: translation.value,
            digest: null,
            resourceType: "Product", // Update resourceType in case it changed
          },
          create: {
            resourceId: productId,
            resourceType: "Product",
            key: translation.key,
            value: translation.value,
            locale: translation.locale,
            digest: null,
          },
        });
      }

      // Delete translations that were cleared by the user
      for (const key of translationsToDelete) {
        await tx.contentTranslation.deleteMany({
          where: {
            resourceId: productId,
            resourceType: "Product",
            locale: params.locale,
            key: key,
          },
        });
      }
    });

    loggers.product("info", "Saved translations to DB (ContentTranslation)", {
      productId,
      locale: params.locale,
      saved: translationsInput.length,
      skipped: skippedFields.length,
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
  db: any,
  productId: string,
  params: UpdateProductParams,
  changedFields: string[] = [],
  changedAltTextIndices: number[] = [],
  shop: string
): Promise<Response> {
  loggers.product("info", "Updating primary product", { productId, changedFields, changedAltTextIndices });

  // Validate that title is not empty for primary locale
  if (!params.title || !params.title.trim()) {
    return json(
      {
        success: false,
        error: "Title cannot be empty for the primary language. Please enter a title.",
      },
      { status: 400 }
    );
  }

  // Build mutation input - only include productType if it has a value or was explicitly changed
  // Sending productType: "" to Shopify CLEARS it, so we must omit it when unchanged
  const mutationInput: any = {
    id: productId,
    title: params.title,
    handle: params.handle,
    descriptionHtml: params.descriptionHtml,
    seo: {
      title: params.seoTitle,
      description: params.metaDescription,
    },
  };

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

  const data = await response.json();

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
    const updateData: any = {};
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
      where: { id: productId },
      data: updateData,
    });

    loggers.product("info", "Updated product in DB", {
      productId,
      fields: Object.keys(updateData),
    });
  } catch (dbError: any) {
    logger.error("Failed to update product in DB", {
      context: "UpdateProduct",
      productId,
      error: dbError.message,
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
        const localesData = await localesResponse.json();
        const shopLocales = localesData.data?.shopLocales || [];

        // Filter out the primary locale, only keep published foreign locales
        const foreignLocales = shopLocales
          .filter((l: any) => !l.primary && l.published)
          .map((l: any) => l.locale);

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

          const responseData = await response.json();
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
          await db.$transaction(async (tx: any) => {
            for (const key of translationKeysToDelete) {
              await tx.contentTranslation.deleteMany({
                where: {
                  resourceId: productId,
                  resourceType: "Product",
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
    } catch (translationError: any) {
      logger.error("Failed to delete translations for changed fields", {
        context: "UpdateProduct",
        productId,
        changedFields,
        error: translationError.message,
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
      const localesData = await localesResponse.json();
      const shopLocales = localesData.data?.shopLocales || [];

      // Filter out the primary locale, only keep published foreign locales
      const foreignLocales = shopLocales
        .filter((l: any) => !l.primary && l.published)
        .map((l: any) => l.locale);

      if (foreignLocales.length > 0) {
        // Get product images from DB to find mediaIds
        const dbProduct = await db.product.findUnique({
          where: { id: productId },
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

                  const responseData = await response.json();
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
            await db.$transaction(async (tx: any) => {
              for (const imageId of imageIdsToDeleteTranslations) {
                await tx.productImageAltTranslation.deleteMany({
                  where: {
                    imageId: imageId,
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
    } catch (altTextTranslationError: any) {
      logger.error("Failed to delete alt-text translations for changed images", {
        context: "UpdateProduct",
        productId,
        changedAltTextIndices,
        error: altTextTranslationError.message,
      });
      // Don't fail the request - primary update succeeded
    }
  }

  return json({ success: true, product: data.data.productUpdate.product });
}
