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
        locales.filter(l => !l.primary),
        productData // Pass product data for fallback values
      );
      console.log(`[ProductSync] Fetched ${allTranslations.length} translations`);

      // 4. Save to database
      await this.saveToDatabase(productData, allTranslations);

      console.log(`[ProductSync] Successfully synced product: ${productId}`);
    } catch (error) {
      console.error(`[ProductSync] Error syncing product ${productId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch product data from Shopify
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
            images(first: 250) {
              edges {
                node {
                  url
                  altText
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

      // Build a map of all translatable fields
      const translatableFieldsMap = new Map<string, any>();

      if (resource.translatableContent) {
        console.log(`[ProductSync] Available translatable keys for ${locale.locale}:`,
          resource.translatableContent.map((c: any) => c.key).join(', '));

        for (const content of resource.translatableContent) {
          // Store digest for future updates
          digestMap.set(content.key, content.digest);

          // Store translatable field with default value from primary locale
          translatableFieldsMap.set(content.key, {
            key: content.key,
            value: content.value, // Default value from primary locale
            locale: locale.locale,
            digest: content.digest,
          });
        }
      }

      // Override with actual translations if they exist
      if (resource.translations) {
        console.log(`[ProductSync] Existing translations for ${locale.locale}:`,
          resource.translations.map((t: any) => t.key).join(', '));

        for (const translation of resource.translations) {
          translatableFieldsMap.set(translation.key, {
            key: translation.key,
            value: translation.value, // Actual translated value
            locale: translation.locale,
            digest: digestMap.get(translation.key),
          });
        }
      }

      // Collect all translations (both existing and translatable fields)
      // Keep Shopify's field names as-is (meta_title, meta_description)
      for (const translation of translatableFieldsMap.values()) {
        allTranslations.push(translation);
      }

      // IMPORTANT: Shopify doesn't always return 'handle' in translatableContent
      // Add it manually as a fallback if missing
      if (!translatableFieldsMap.has('handle') && productData.handle) {
        console.log(`[ProductSync] Adding missing 'handle' field for ${locale.locale} with fallback value`);
        allTranslations.push({
          key: 'handle',
          value: productData.handle, // Use primary locale handle as fallback
          locale: locale.locale,
          digest: null, // No digest available for manually added fields
        });
      }

      console.log(`[ProductSync] Found ${translatableFieldsMap.size} translatable fields for ${locale.locale}`);
    }

    return allTranslations;
  }

  /**
   * Save product and translations to database
   */
  private async saveToDatabase(productData: any, translations: any[]) {
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
    await db.translation.deleteMany({ where: { productId: productData.id } });
    await db.productImage.deleteMany({ where: { productId: productData.id } });
    await db.productOption.deleteMany({ where: { productId: productData.id } });
    await db.productMetafield.deleteMany({ where: { productId: productData.id } });

    // Insert translations
    if (translations.length > 0) {
      // Log what we're about to save for debugging
      const translationsByLocale = translations.reduce((acc: any, t: any) => {
        if (!acc[t.locale]) acc[t.locale] = [];
        acc[t.locale].push(t.key);
        return acc;
      }, {});

      console.log(`[ProductSync] Saving ${translations.length} translations to database:`);
      for (const [locale, keys] of Object.entries(translationsByLocale)) {
        console.log(`[ProductSync]   ${locale}: ${(keys as string[]).join(', ')}`);
      }

      await db.translation.createMany({
        data: translations.map(t => ({
          productId: productData.id,
          key: t.key,
          value: t.value,
          locale: t.locale,
          digest: t.digest || null,
        })),
      });
      console.log(`[ProductSync] ✓ Successfully saved ${translations.length} translations to database`);
    } else {
      console.log(`[ProductSync] No translations to save`);
    }

    // Insert images
    const images = productData.images?.edges?.map((edge: any) => edge.node) || [];
    if (images.length > 0) {
      await db.productImage.createMany({
        data: images.map((img: any, index: number) => ({
          productId: productData.id,
          url: img.url,
          altText: img.altText || null,
          position: index,
        })),
      });
      console.log(`[ProductSync] Saved ${images.length} images`);
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
}
