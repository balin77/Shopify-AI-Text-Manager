/**
 * Product Sync Service
 *
 * Synchronizes product data from Shopify to local PostgreSQL database
 * including all translations for all available locales.
 */

import { logger } from '~/utils/logger.server';

interface ShopifyGraphQLClient {
  graphql: (query: string, options?: { variables?: any }) => Promise<any>;
}

export class ProductSyncService {
  constructor(
    private admin: ShopifyGraphQLClient,
    private shop: string
  ) {}

  /**
   * Sync a single product with all its translations
   */
  async syncProduct(productId: string): Promise<void> {
    logger.debug(`[ProductSync] Starting sync for product: ${productId}`);

    try {
      // 1. Fetch product data
      const productData = await this.fetchProductData(productId);

      if (!productData) {
        logger.warn(`[ProductSync] Product not found: ${productId}`);
        return;
      }

      // 2. Fetch all available locales
      const locales = await this.fetchShopLocales();
      logger.debug(`[ProductSync] Found ${locales.length} locales`);

      // 3. Fetch translations for all non-primary locales
      const allTranslations = await this.fetchAllTranslations(
        productId,
        locales.filter((l: any) => !l.primary),
        productData // Pass product data for fallback values
      );
      logger.debug(`[ProductSync] Fetched ${allTranslations.length} translations`);

      // 4. Fetch image alt-text translations (API 2025-10+)
      const imageAltTranslations = await this.fetchImageAltTextTranslations(
        productData,
        locales.filter((l: any) => !l.primary && l.published)
      );
      logger.debug(`[ProductSync] Fetched ${imageAltTranslations.length} image alt-text translations`);

      // 5. Save to database
      await this.saveToDatabase(productData, allTranslations, imageAltTranslations);

      logger.debug(`[ProductSync] Successfully synced product: ${productId}`);
    } catch (error) {
      logger.error(`[ProductSync] Error syncing product ${productId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch alt-text translations for all product images (API 2025-10+)
   * Uses translatableResourcesByIds for BULK loading - 1 API call per locale instead of per image
   *
   * Performance: 5 images × 3 locales = 3 API calls (instead of 15)
   */
  private async fetchImageAltTextTranslations(
    productData: any,
    locales: any[]
  ): Promise<Array<{ mediaId: string; locale: string; altText: string }>> {
    const altTranslations: Array<{ mediaId: string; locale: string; altText: string }> = [];

    // Get all media images from product
    const mediaImages = productData.media?.edges
      ?.filter((edge: any) => edge.node.id) // Filter out non-MediaImage types
      .map((edge: any) => edge.node) || [];

    if (mediaImages.length === 0) {
      logger.debug(`[ProductSync] No media images found for alt-text translations`);
      return altTranslations;
    }

    // Collect all MediaImage IDs for bulk query
    const mediaIds = mediaImages.map((m: any) => m.id);

    logger.debug(`[ProductSync] Fetching alt-text translations for ${mediaIds.length} images using BULK query`);

    // 1 API call per locale (instead of per image × locale)
    for (const locale of locales) {
      try {
        const response = await this.admin.graphql(
          `#graphql
            query getMediaImageTranslationsBulk($resourceIds: [ID!]!, $locale: String!) {
              translatableResourcesByIds(first: 250, resourceIds: $resourceIds) {
                edges {
                  node {
                    resourceId
                    translations(locale: $locale) {
                      key
                      value
                    }
                  }
                }
              }
            }`,
          { variables: { resourceIds: mediaIds, locale: locale.locale } }
        );

        const data = await response.json();

        if (data.errors) {
          logger.warn(`[ProductSync] GraphQL error for locale ${locale.locale}:`, data.errors[0]?.message);
          continue;
        }

        const resources = data.data?.translatableResourcesByIds?.edges || [];

        let foundCount = 0;
        for (const edge of resources) {
          const resourceId = edge.node.resourceId;
          const translations = edge.node.translations || [];

          const altTranslation = translations.find((t: any) => t.key === "alt");
          if (altTranslation?.value) {
            altTranslations.push({
              mediaId: resourceId,
              locale: locale.locale,
              altText: altTranslation.value,
            });
            foundCount++;
          }
        }

        if (foundCount > 0) {
          logger.debug(`[ProductSync] Found ${foundCount} alt-text translations for locale ${locale.locale}`);
        }
      } catch (error) {
        logger.warn(`[ProductSync] Failed to fetch bulk alt-text for locale ${locale.locale}:`, error);
      }
    }

    logger.debug(`[ProductSync] Total alt-text translations fetched: ${altTranslations.length}`);
    return altTranslations;
  }

  /**
   * Fetch product data from Shopify
   * Uses media query instead of images to get MediaImage IDs for translations (API 2025-10+)
   */
  private async fetchProductData(productId: string) {
    const response = await this.admin.graphql(
      `#graphql
        query getProduct($id: ID!) {
          product(id: $id) {
            id
            title
            descriptionHtml
            handle
            status
            productType
            updatedAt
            seo {
              title
              description
            }
            featuredImage {
              url
              altText
            }
            media(first: 250) {
              edges {
                node {
                  ... on MediaImage {
                    id
                    alt
                    image {
                      url
                    }
                  }
                }
              }
            }
            options {
              id
              name
              position
              values
            }
            metafields(first: 100) {
              edges {
                node {
                  id
                  namespace
                  key
                  value
                  type
                }
              }
            }
          }
        }`,
      { variables: { id: productId } }
    );

    const data = await response.json();
    return data.data?.product || null;
  }

  /**
   * Fetch all shop locales
   */
  private async fetchShopLocales() {
    const response = await this.admin.graphql(
      `#graphql
        query getShopLocales {
          shopLocales {
            locale
            name
            primary
            published
          }
        }`
    );

    const data = await response.json();
    return data.data?.shopLocales || [];
  }

  /**
   * Fetch translations for all locales
   *
   * IMPORTANT: Only saves ACTUAL translations from Shopify.
   * If a field has no translation in Shopify, it will NOT be stored in the database.
   * This prevents the primary language text from appearing as a "translation".
   */
  private async fetchAllTranslations(productId: string, locales: any[], productData: any) {
    const allTranslations = [];
    const digestMap = new Map<string, string>();

    for (const locale of locales) {
      if (!locale.published) {
        logger.debug(`[ProductSync] Skipping unpublished locale: ${locale.locale}`);
        continue;
      }

      logger.debug(`[ProductSync] Fetching translations for locale: ${locale.locale}`);

      const response = await this.admin.graphql(
        `#graphql
          query getTranslations($resourceId: ID!, $locale: String!) {
            translatableResource(resourceId: $resourceId) {
              translatableContent {
                key
                value
                digest
                locale
              }
              translations(locale: $locale) {
                key
                value
                locale
              }
            }
          }`,
        { variables: { resourceId: productId, locale: locale.locale } }
      );

      const data = await response.json();
      const resource = data.data?.translatableResource;

      if (!resource) {
        logger.warn(`[ProductSync] No translatable resource found for ${locale.locale}`);
        continue;
      }

      // Build digest map from translatableContent (for reference only)
      if (resource.translatableContent) {
        logger.debug(`[ProductSync] Available translatable keys for ${locale.locale}:`,
          resource.translatableContent.map((c: any) => c.key).join(', '));

        for (const content of resource.translatableContent) {
          // Store digest for future updates - but DO NOT store as translation
          digestMap.set(content.key, content.digest);
        }
      }

      // ONLY save actual translations from Shopify
      // DO NOT save translatableContent values - those are the source language text
      if (resource.translations && resource.translations.length > 0) {
        logger.debug(`[ProductSync] Actual translations for ${locale.locale}:`,
          resource.translations.map((t: any) => t.key).join(', '));

        for (const translation of resource.translations) {
          allTranslations.push({
            key: translation.key,
            value: translation.value,
            locale: translation.locale,
            digest: digestMap.get(translation.key),
          });
        }

        logger.debug(`[ProductSync] Saved ${resource.translations.length} actual translations for ${locale.locale}`);
      } else {
        logger.debug(`[ProductSync] No translations found for ${locale.locale} - nothing to save`);
      }
    }

    return allTranslations;
  }

  /**
   * Save product and translations to database
   * Includes image alt-text translations from Shopify (API 2025-10+)
   * Uses a transaction to ensure data consistency
   */
  private async saveToDatabase(
    productData: any,
    translations: any[],
    imageAltTranslations: Array<{ mediaId: string; locale: string; altText: string }> = []
  ) {
    const { db } = await import("../db.server");

    logger.debug(`[ProductSync] Saving product to database: ${productData.id}`);

    // Before starting transaction, preserve alt-texts that were recently modified by user
    // This prevents webhook-triggered syncs from overwriting user changes
    const PRESERVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
    const cutoffTime = new Date(Date.now() - PRESERVE_WINDOW_MS);

    const existingImages = await db.productImage.findMany({
      where: { productId: productData.id },
      select: { mediaId: true, altText: true, altTextModifiedAt: true },
    });

    // Debug: Log what we found
    logger.debug(`[ProductSync] [SYNC] Checking ${existingImages.length} existing images for recent modifications 🟤🟤🟤`);
    logger.debug(`[ProductSync] [SYNC] Cutoff time: ${cutoffTime.toISOString()}`);
    existingImages.forEach((img, i) => {
      const modifiedAt = img.altTextModifiedAt ? new Date(img.altTextModifiedAt).toISOString() : 'null';
      const isRecent = img.altTextModifiedAt && new Date(img.altTextModifiedAt) > cutoffTime;
      logger.debug(`[ProductSync] [SYNC] Image ${i}: mediaId=${img.mediaId}, altText="${img.altText}", modifiedAt=${modifiedAt}, isRecent=${isRecent}`);
    });

    // Map of mediaId -> preserved altText for recently modified images
    const preservedAltTexts = new Map<string, string | null>();
    for (const img of existingImages) {
      if (img.mediaId && img.altTextModifiedAt && img.altTextModifiedAt > cutoffTime) {
        preservedAltTexts.set(img.mediaId, img.altText);
        logger.debug(`[ProductSync] [SYNC] ✅ PRESERVING user-modified alt-text for mediaId ${img.mediaId}: "${img.altText}"`);
      }
    }
    logger.debug(`[ProductSync] [SYNC] Total preserved: ${preservedAltTexts.size} images`);

    // Prepare data outside transaction
    const validTranslations = translations.filter(t => t.value != null && t.value !== undefined);
    const skippedCount = translations.length - validTranslations.length;
    if (skippedCount > 0) {
      logger.debug(`[ProductSync] Skipping ${skippedCount} translations with null/undefined values`);
    }

    const mediaImages = productData.media?.edges
      ?.filter((edge: any) => edge.node.id && edge.node.image?.url)
      .map((edge: any) => edge.node) || [];

    // Use transaction to ensure all-or-nothing data consistency
    await db.$transaction(async (tx) => {
      // Upsert product
      await tx.product.upsert({
        where: {
          shop_id: {
            shop: this.shop,
            id: productData.id,
          },
        },
        create: {
          id: productData.id,
          shop: this.shop,
          title: productData.title,
          descriptionHtml: productData.descriptionHtml || "",
          handle: productData.handle,
          status: productData.status,
          productType: productData.productType || null,
          seoTitle: productData.seo?.title || null,
          seoDescription: productData.seo?.description || null,
          featuredImageUrl: productData.featuredImage?.url || null,
          featuredImageAlt: productData.featuredImage?.altText || null,
          shopifyUpdatedAt: new Date(productData.updatedAt),
          lastSyncedAt: new Date(),
        },
        update: {
          title: productData.title,
          descriptionHtml: productData.descriptionHtml || "",
          handle: productData.handle,
          status: productData.status,
          productType: productData.productType || null,
          seoTitle: productData.seo?.title || null,
          seoDescription: productData.seo?.description || null,
          featuredImageUrl: productData.featuredImage?.url || null,
          featuredImageAlt: productData.featuredImage?.altText || null,
          shopifyUpdatedAt: new Date(productData.updatedAt),
          lastSyncedAt: new Date(),
        },
      });

      // Delete old relations and create new ones (all within transaction)
      await tx.contentTranslation.deleteMany({ where: { resourceId: productData.id, resourceType: "Product" } });
      await tx.productImage.deleteMany({ where: { productId: productData.id } });
      await tx.productOption.deleteMany({ where: { productId: productData.id } });
      await tx.productMetafield.deleteMany({ where: { productId: productData.id } });

      // Insert translations
      if (validTranslations.length > 0) {
        // Log what we're about to save for debugging
        const translationsByLocale = validTranslations.reduce((acc: any, t: any) => {
          if (!acc[t.locale]) acc[t.locale] = [];
          acc[t.locale].push(t.key);
          return acc;
        }, {});

        logger.debug(`[ProductSync] Saving ${validTranslations.length} translations to database:`);
        for (const [locale, keys] of Object.entries(translationsByLocale)) {
          logger.debug(`[ProductSync]   ${locale}: ${(keys as string[]).join(', ')}`);
        }

        await tx.contentTranslation.createMany({
          data: validTranslations.map(t => ({
            resourceId: productData.id,
            resourceType: "Product",
            key: t.key,
            value: t.value,
            locale: t.locale,
            digest: t.digest || null,
          })),
        });
        logger.debug(`[ProductSync] ✓ Successfully saved ${validTranslations.length} translations to database`);
      } else {
        logger.debug(`[ProductSync] No translations to save`);
      }

      // Insert ALL images to database (with mediaId for translation support)
      if (mediaImages.length > 0) {
        // Log what Shopify returned for alt-texts
        logger.debug(`[ProductSync] [SYNC] Syncing ${mediaImages.length} images from Shopify 🔵🔵🔵`);
        mediaImages.forEach((media: any, index: number) => {
          logger.debug(`[ProductSync] [SYNC] Image ${index}: mediaId=${media.id}, alt="${media.alt}" (isNull: ${media.alt === null}, isEmpty: ${media.alt === ""})`);
        });

        // Create images with mediaId for translation support
        const createdImages = await Promise.all(
          mediaImages.map(async (media: any, index: number) => {
            // Check if this image's alt-text was recently modified by user
            const wasRecentlyModified = preservedAltTexts.has(media.id);
            const altTextToSave = wasRecentlyModified
              ? preservedAltTexts.get(media.id) // Use preserved user value
              : (media.alt || null); // Use Shopify value

            if (wasRecentlyModified) {
              logger.debug(`[ProductSync] [SYNC] Using preserved alt-text for image ${index}: "${altTextToSave}" (ignoring Shopify: "${media.alt}")`);
            } else {
              logger.debug(`[ProductSync] [SYNC] Saving image ${index}: altText="${altTextToSave}"`);
            }

            return tx.productImage.create({
              data: {
                productId: productData.id,
                url: media.image.url,
                altText: altTextToSave,
                mediaId: media.id, // Store Shopify Media ID for translations
                position: index,
                // Preserve the modification timestamp if we're keeping user's alt-text
                altTextModifiedAt: wasRecentlyModified ? new Date() : null,
              },
            });
          })
        );

        logger.debug(`[ProductSync] Saved ${createdImages.length} images with mediaIds`);

        // Insert image alt-text translations from Shopify
        if (imageAltTranslations.length > 0) {
          // Create a map of mediaId -> dbImageId for quick lookup
          const mediaIdToDbId = new Map<string, string>();
          createdImages.forEach((img) => {
            if (img.mediaId) {
              mediaIdToDbId.set(img.mediaId, img.id);
            }
          });

          let savedAltTranslations = 0;
          for (const altTrans of imageAltTranslations) {
            const dbImageId = mediaIdToDbId.get(altTrans.mediaId);
            if (dbImageId) {
              await tx.productImageAltTranslation.create({
                data: {
                  imageId: dbImageId,
                  locale: altTrans.locale,
                  altText: altTrans.altText,
                },
              });
              savedAltTranslations++;
            }
          }

          if (savedAltTranslations > 0) {
            logger.debug(`[ProductSync] ✓ Saved ${savedAltTranslations} image alt-text translations`);
          }
        }
      }

      // Insert options
      if (productData.options && productData.options.length > 0) {
        await tx.productOption.createMany({
          data: productData.options.map((opt: any) => ({
            id: opt.id,
            productId: productData.id,
            name: opt.name,
            position: opt.position,
            values: JSON.stringify(opt.values),
          })),
        });
        logger.debug(`[ProductSync] Saved ${productData.options.length} options`);
      }

      // Insert metafields
      const metafields = productData.metafields?.edges?.map((edge: any) => edge.node) || [];
      if (metafields.length > 0) {
        await tx.productMetafield.createMany({
          data: metafields.map((mf: any) => ({
            id: mf.id,
            productId: productData.id,
            namespace: mf.namespace,
            key: mf.key,
            value: mf.value,
            type: mf.type,
          })),
        });
        logger.debug(`[ProductSync] Saved ${metafields.length} metafields`);
      }
    });

    logger.debug(`[ProductSync] ✓ Transaction completed successfully for product ${productData.id}`);
  }

  /**
   * Delete a product from the database
   */
  async deleteProduct(productId: string): Promise<void> {
    logger.debug(`[ProductSync] Deleting product: ${productId}`);

    const { db } = await import("../db.server");

    await db.product.delete({
      where: {
        shop_id: {
          shop: this.shop,
          id: productId,
        },
      },
    });

    logger.debug(`[ProductSync] Successfully deleted product: ${productId}`);
  }

  /**
   * Sync a single product with plan-aware image loading
   * @param productId - Shopify product ID (can be numeric or GID format)
   * @param includeAllImages - If true, sync all images. If false, only featured image
   */
  async syncSingleProduct(productId: string, includeAllImages: boolean = true): Promise<any> {
    logger.debug(`[ProductSync] Manual sync for product: ${productId} (images: ${includeAllImages ? "all" : "featured only"})`);

    // Convert to GID format if numeric
    const gid = productId.startsWith("gid://")
      ? productId
      : `gid://shopify/Product/${productId}`;

    try {
      // Sync the product
      await this.syncProduct(gid);

      // Fetch and update the product from database to return fresh data
      const { db } = await import("../db.server");
      const product = await db.product.findUnique({
        where: {
          shop_id: {
            shop: this.shop,
            id: gid,
          },
        },
        include: {
          images: includeAllImages ? {
            include: {
              altTextTranslations: true, // Include alt-text translations
            },
          } : false,
          options: true,
          metafields: true,
        },
      });

      return product;
    } catch (error) {
      logger.error(`[ProductSync] Error in syncSingleProduct:`, error);
      throw error;
    }
  }
}
