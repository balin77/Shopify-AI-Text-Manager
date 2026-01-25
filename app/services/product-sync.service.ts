/**
 * Product Sync Service
 *
 * Synchronizes product data from Shopify to local PostgreSQL database
 * including all translations for all available locales.
 */

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
    console.log(`[ProductSync] Starting sync for product: ${productId}`);

    try {
      // 1. Fetch product data
      const productData = await this.fetchProductData(productId);

      if (!productData) {
        console.warn(`[ProductSync] Product not found: ${productId}`);
        return;
      }

      // 2. Fetch all available locales
      const locales = await this.fetchShopLocales();
      console.log(`[ProductSync] Found ${locales.length} locales`);

      // 3. Fetch translations for all non-primary locales
      const allTranslations = await this.fetchAllTranslations(
        productId,
        locales.filter((l: any) => !l.primary),
        productData // Pass product data for fallback values
      );
      console.log(`[ProductSync] Fetched ${allTranslations.length} translations`);

      // 4. Fetch image alt-text translations (API 2025-10+)
      const imageAltTranslations = await this.fetchImageAltTextTranslations(
        productData,
        locales.filter((l: any) => !l.primary && l.published)
      );
      console.log(`[ProductSync] Fetched ${imageAltTranslations.length} image alt-text translations`);

      // 5. Save to database
      await this.saveToDatabase(productData, allTranslations, imageAltTranslations);

      console.log(`[ProductSync] Successfully synced product: ${productId}`);
    } catch (error) {
      console.error(`[ProductSync] Error syncing product ${productId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch alt-text translations for all product images (API 2025-10+)
   * Uses TranslatableResourceType.MEDIA_IMAGE
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
      console.log(`[ProductSync] No media images found for alt-text translations`);
      return altTranslations;
    }

    console.log(`[ProductSync] Fetching alt-text translations for ${mediaImages.length} images`);

    // For each locale, fetch translations for all images
    for (const locale of locales) {
      for (const media of mediaImages) {
        try {
          const response = await this.admin.graphql(
            `#graphql
              query getMediaImageTranslations($resourceId: ID!, $locale: String!) {
                translatableResource(resourceId: $resourceId) {
                  translations(locale: $locale) {
                    key
                    value
                    locale
                  }
                }
              }`,
            { variables: { resourceId: media.id, locale: locale.locale } }
          );

          const data = await response.json();
          const translations = data.data?.translatableResource?.translations || [];

          // Find the alt translation
          const altTranslation = translations.find((t: any) => t.key === "alt");
          if (altTranslation && altTranslation.value) {
            altTranslations.push({
              mediaId: media.id,
              locale: locale.locale,
              altText: altTranslation.value,
            });
            console.log(`[ProductSync] Found alt-text translation for ${media.id} in ${locale.locale}`);
          }
        } catch (error) {
          console.warn(`[ProductSync] Failed to fetch alt-text for ${media.id} in ${locale.locale}:`, error);
        }
      }
    }

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
        console.log(`[ProductSync] Skipping unpublished locale: ${locale.locale}`);
        continue;
      }

      console.log(`[ProductSync] Fetching translations for locale: ${locale.locale}`);

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
        console.warn(`[ProductSync] No translatable resource found for ${locale.locale}`);
        continue;
      }

      // Build digest map from translatableContent (for reference only)
      if (resource.translatableContent) {
        console.log(`[ProductSync] Available translatable keys for ${locale.locale}:`,
          resource.translatableContent.map((c: any) => c.key).join(', '));

        for (const content of resource.translatableContent) {
          // Store digest for future updates - but DO NOT store as translation
          digestMap.set(content.key, content.digest);
        }
      }

      // ONLY save actual translations from Shopify
      // DO NOT save translatableContent values - those are the source language text
      if (resource.translations && resource.translations.length > 0) {
        console.log(`[ProductSync] Actual translations for ${locale.locale}:`,
          resource.translations.map((t: any) => t.key).join(', '));

        for (const translation of resource.translations) {
          allTranslations.push({
            key: translation.key,
            value: translation.value,
            locale: translation.locale,
            digest: digestMap.get(translation.key),
          });
        }

        console.log(`[ProductSync] Saved ${resource.translations.length} actual translations for ${locale.locale}`);
      } else {
        console.log(`[ProductSync] No translations found for ${locale.locale} - nothing to save`);
      }
    }

    return allTranslations;
  }

  /**
   * Save product and translations to database
   * Includes image alt-text translations from Shopify (API 2025-10+)
   */
  private async saveToDatabase(
    productData: any,
    translations: any[],
    imageAltTranslations: Array<{ mediaId: string; locale: string; altText: string }> = []
  ) {
    const { db } = await import("../db.server");

    console.log(`[ProductSync] Saving product to database: ${productData.id}`);

    // Upsert product
    await db.product.upsert({
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
        seoTitle: productData.seo?.title || null,
        seoDescription: productData.seo?.description || null,
        featuredImageUrl: productData.featuredImage?.url || null,
        featuredImageAlt: productData.featuredImage?.altText || null,
        shopifyUpdatedAt: new Date(productData.updatedAt),
        lastSyncedAt: new Date(),
      },
    });

    // Delete old relations and create new ones
    await db.contentTranslation.deleteMany({ where: { resourceId: productData.id, resourceType: "Product" } });
    await db.productImage.deleteMany({ where: { productId: productData.id } });
    await db.productOption.deleteMany({ where: { productId: productData.id } });
    await db.productMetafield.deleteMany({ where: { productId: productData.id } });

    // Insert translations
    if (translations.length > 0) {
      // Filter out translations with null/undefined values (required field in DB)
      const validTranslations = translations.filter(t => t.value != null && t.value !== undefined);
      const skippedCount = translations.length - validTranslations.length;

      if (skippedCount > 0) {
        console.log(`[ProductSync] Skipping ${skippedCount} translations with null/undefined values`);
      }

      // Log what we're about to save for debugging
      const translationsByLocale = validTranslations.reduce((acc: any, t: any) => {
        if (!acc[t.locale]) acc[t.locale] = [];
        acc[t.locale].push(t.key);
        return acc;
      }, {});

      console.log(`[ProductSync] Saving ${validTranslations.length} translations to database:`);
      for (const [locale, keys] of Object.entries(translationsByLocale)) {
        console.log(`[ProductSync]   ${locale}: ${(keys as string[]).join(', ')}`);
      }

      if (validTranslations.length > 0) {
        await db.contentTranslation.createMany({
          data: validTranslations.map(t => ({
            resourceId: productData.id,
            resourceType: "Product",
            key: t.key,
            value: t.value,
            locale: t.locale,
            digest: t.digest || null,
          })),
        });
        console.log(`[ProductSync] ✓ Successfully saved ${validTranslations.length} translations to database`);
      }
    } else {
      console.log(`[ProductSync] No translations to save`);
    }

    // Insert images with mediaId (from media query instead of images query)
    const mediaImages = productData.media?.edges
      ?.filter((edge: any) => edge.node.id && edge.node.image?.url) // Filter valid MediaImage types
      .map((edge: any) => edge.node) || [];

    if (mediaImages.length > 0) {
      // Create images with mediaId for translation support
      const createdImages = await Promise.all(
        mediaImages.map(async (media: any, index: number) => {
          return db.productImage.create({
            data: {
              productId: productData.id,
              url: media.image.url,
              altText: media.alt || null,
              mediaId: media.id, // Store Shopify Media ID for translations
              position: index,
            },
          });
        })
      );

      console.log(`[ProductSync] Saved ${createdImages.length} images with mediaIds`);

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
            await db.productImageAltTranslation.create({
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
          console.log(`[ProductSync] ✓ Saved ${savedAltTranslations} image alt-text translations`);
        }
      }
    }

    // Insert options
    if (productData.options && productData.options.length > 0) {
      await db.productOption.createMany({
        data: productData.options.map((opt: any) => ({
          id: opt.id,
          productId: productData.id,
          name: opt.name,
          position: opt.position,
          values: JSON.stringify(opt.values),
        })),
      });
      console.log(`[ProductSync] Saved ${productData.options.length} options`);
    }

    // Insert metafields
    const metafields = productData.metafields?.edges?.map((edge: any) => edge.node) || [];
    if (metafields.length > 0) {
      await db.productMetafield.createMany({
        data: metafields.map((mf: any) => ({
          id: mf.id,
          productId: productData.id,
          namespace: mf.namespace,
          key: mf.key,
          value: mf.value,
          type: mf.type,
        })),
      });
      console.log(`[ProductSync] Saved ${metafields.length} metafields`);
    }
  }

  /**
   * Delete a product from the database
   */
  async deleteProduct(productId: string): Promise<void> {
    console.log(`[ProductSync] Deleting product: ${productId}`);

    const { db } = await import("../db.server");

    await db.product.delete({
      where: {
        shop_id: {
          shop: this.shop,
          id: productId,
        },
      },
    });

    console.log(`[ProductSync] Successfully deleted product: ${productId}`);
  }

  /**
   * Sync a single product with plan-aware image loading
   * @param productId - Shopify product ID (can be numeric or GID format)
   * @param includeAllImages - If true, sync all images. If false, only featured image
   */
  async syncSingleProduct(productId: string, includeAllImages: boolean = true): Promise<any> {
    console.log(`[ProductSync] Manual sync for product: ${productId} (images: ${includeAllImages ? "all" : "featured only"})`);

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
      console.error(`[ProductSync] Error in syncSingleProduct:`, error);
      throw error;
    }
  }
}
