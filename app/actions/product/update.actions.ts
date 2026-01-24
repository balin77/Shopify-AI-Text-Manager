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

  const params: UpdateProductParams = {
    locale: formData.get("locale") as string,
    primaryLocale: formData.get("primaryLocale") as string,
    title: formData.get("title") as string,
    descriptionHtml: formData.get("descriptionHtml") as string,
    handle: formData.get("handle") as string,
    seoTitle: formData.get("seoTitle") as string,
    metaDescription: formData.get("metaDescription") as string,
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
      return await updatePrimaryProduct(gateway, db, productId, params, changedFields, context.session.shop);
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
 */
async function updateImageAltTexts(
  gateway: ShopifyApiGateway,
  db: any,
  productId: string,
  params: UpdateProductParams
): Promise<void> {
  loggers.product("info", "Updating image alt-texts", {
    productId,
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
  const mediaEdges = productData.data?.product?.media?.edges || [];

  // Get DB product images
  const dbProduct = await db.product.findUnique({
    where: { id: productId },
    include: { images: true },
  });

  // Update each image with new alt-text
  for (const [indexStr, altText] of Object.entries(params.imageAltTexts || {})) {
    const index = parseInt(indexStr);
    if (index < mediaEdges.length) {
      const imageId = mediaEdges[index].node.id;

      loggers.product("debug", "Updating image alt-text", {
        index,
        imageId,
        locale: params.locale,
      });

      // Save to Shopify
      await gateway.graphql(
        `#graphql
          mutation updateMedia($media: [UpdateMediaInput!]!) {
            productUpdateMedia(media: $media, productId: "${productId}") {
              media {
                alt
                mediaErrors {
                  field
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
                id: imageId,
                alt: altText,
              },
            ],
          },
        }
      );

      // Save to Database
      const dbImage = dbProduct?.images[index];
      if (dbImage) {
        if (params.locale === params.primaryLocale) {
          // Primary locale: Update ProductImage table
          await db.productImage.update({
            where: { id: dbImage.id },
            data: { altText },
          });
          loggers.product("debug", "Updated primary alt-text in DB", { index });
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

  const translationsInput = [];
  const translationsToDelete = [];

  // Only add non-empty translations
  if (params.title && params.title.trim()) {
    translationsInput.push({ key: "title", value: params.title, locale: params.locale });
  } else if (params.title === "") {
    // Empty string means user wants to delete the translation
    translationsToDelete.push("title");
  }

  if (params.descriptionHtml && params.descriptionHtml.trim()) {
    translationsInput.push({ key: "body_html", value: params.descriptionHtml, locale: params.locale });
  } else if (params.descriptionHtml === "") {
    translationsToDelete.push("body_html");
  }

  if (params.handle && params.handle.trim()) {
    translationsInput.push({ key: "handle", value: params.handle, locale: params.locale });
  } else if (params.handle === "") {
    translationsToDelete.push("handle");
  }

  if (params.seoTitle && params.seoTitle.trim()) {
    translationsInput.push({ key: "meta_title", value: params.seoTitle, locale: params.locale });
  } else if (params.seoTitle === "") {
    translationsToDelete.push("meta_title");
  }

  if (params.metaDescription && params.metaDescription.trim()) {
    translationsInput.push({
      key: "meta_description",
      value: params.metaDescription,
      locale: params.locale,
    });
  } else if (params.metaDescription === "") {
    translationsToDelete.push("meta_description");
  }

  // Save non-empty translations to Shopify
  if (translationsInput.length > 0) {
    for (const translation of translationsInput) {
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
            translations: [translation],
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
    }
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
    // Use upsert to preserve existing translations for other fields
    for (const translation of translationsInput) {
      await db.contentTranslation.upsert({
        where: {
          resourceId_resourceType_locale_key: {
            resourceId: productId,
            resourceType: "Product",
            locale: translation.locale,
            key: translation.key,
          },
        },
        update: {
          value: translation.value,
          digest: null,
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
      await db.contentTranslation.deleteMany({
        where: {
          resourceId: productId,
          resourceType: "Product",
          locale: params.locale,
          key: key,
        },
      });
    }

    loggers.product("info", "Saved translations to DB (ContentTranslation)", {
      productId,
      locale: params.locale,
      saved: translationsInput.length,
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
  shop: string
): Promise<Response> {
  loggers.product("info", "Updating primary product", { productId, changedFields });

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
        input: {
          id: productId,
          title: params.title,
          handle: params.handle,
          descriptionHtml: params.descriptionHtml,
          seo: {
            title: params.seoTitle,
            description: params.metaDescription,
          },
        },
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
      };

      const translationKeysToDelete = changedFields
        .map((field) => fieldToKeyMap[field])
        .filter((key): key is string => !!key);

      if (translationKeysToDelete.length > 0) {
        // Get all shop locales from database
        const shopLocales = await db.shopLocale.findMany({
          where: { shop },
          select: { locale: true, primary: true },
        });

        // Filter out the primary locale
        const foreignLocales = shopLocales
          .filter((l: any) => !l.primary)
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

          // Delete translations from local database
          for (const key of translationKeysToDelete) {
            await db.contentTranslation.deleteMany({
              where: {
                resourceId: productId,
                resourceType: "Product",
                key: key,
                locale: { in: foreignLocales },
              },
            });
          }

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

  return json({ success: true, product: data.data.productUpdate.product });
}
