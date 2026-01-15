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
      return await updatePrimaryProduct(gateway, db, productId, params);
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
  if (params.title) translationsInput.push({ key: "title", value: params.title, locale: params.locale });
  if (params.descriptionHtml)
    translationsInput.push({ key: "body_html", value: params.descriptionHtml, locale: params.locale });
  if (params.handle) translationsInput.push({ key: "handle", value: params.handle, locale: params.locale });
  if (params.seoTitle)
    translationsInput.push({ key: "meta_title", value: params.seoTitle, locale: params.locale });
  if (params.metaDescription)
    translationsInput.push({
      key: "meta_description",
      value: params.metaDescription,
      locale: params.locale,
    });

  // Save to Shopify
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

  // Update local database
  const product = await db.product.findFirst({
    where: { id: productId },
    select: { shop: true },
  });

  if (product) {
    // Delete existing translations for this locale and product
    await db.translation.deleteMany({
      where: {
        productId: productId,
        locale: params.locale,
      },
    });

    // Insert new translations
    if (translationsInput.length > 0) {
      await db.translation.createMany({
        data: translationsInput.map((t) => ({
          productId: productId,
          key: t.key,
          value: t.value,
          locale: t.locale,
          digest: null,
        })),
      });
      loggers.product("info", "Saved translations to DB", {
        productId,
        locale: params.locale,
        count: translationsInput.length,
      });
    }
  }

  return json({ success: true });
}

/**
 * Updates a primary locale product
 */
async function updatePrimaryProduct(
  gateway: ShopifyApiGateway,
  db: any,
  productId: string,
  params: UpdateProductParams
): Promise<Response> {
  loggers.product("info", "Updating primary product", { productId });

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
    if (params.descriptionHtml) updateData.descriptionHtml = params.descriptionHtml;
    if (params.handle) updateData.handle = params.handle;
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

  return json({ success: true, product: data.data.productUpdate.product });
}
