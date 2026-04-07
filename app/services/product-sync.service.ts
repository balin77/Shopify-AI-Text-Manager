/**
 * Product Sync Service
 *
 * Synchronizes product data from Shopify to local PostgreSQL database
 * including all translations for all available locales.
 */

import { logger } from '~/utils/logger.server';
import { isTranslationRecentlySaved } from '~/utils/translation-save-lock.server';
import type { ShopifyGraphQLClient, ShopLocale, GraphQLEdge, ShopifyTranslation, ResolvedTranslation, ProgressCallback } from './sync-types';
import { fetchShopLocales } from './sync-utils';
import { isDefaultTitleOption } from '~/utils/shopify-product.utils';

/** GraphQL error shape */
interface GraphQLError {
  message: string;
}

/** Product media image from Shopify */
interface ShopifyMediaImage {
  id: string;
  alt: string | null;
  image: {
    url: string;
  };
}

/** Product option value from Shopify */
interface ShopifyProductOptionValue {
  id: string;
  name: string;
  linkedMetafieldValue: string | null;
}

/** Product option from Shopify */
interface ShopifyProductOption {
  id: string;
  name: string;
  position: number;
  linkedMetafield: { namespace: string; key: string } | null;
  optionValues: ShopifyProductOptionValue[];
}

/** Product metafield from Shopify */
interface ShopifyMetafield {
  id: string;
  namespace: string;
  key: string;
  value: string;
  type: string;
}

/** Product data from Shopify GraphQL */
interface ShopifyProductData {
  id: string;
  title: string;
  descriptionHtml: string | null;
  handle: string;
  status: string;
  productType: string | null;
  updatedAt: string;
  seo: {
    title: string | null;
    description: string | null;
  } | null;
  featuredImage: {
    url: string;
    altText: string | null;
  } | null;
  media: {
    edges: GraphQLEdge<ShopifyMediaImage>[];
  } | null;
  options: ShopifyProductOption[] | null;
  metafields: {
    edges: GraphQLEdge<ShopifyMetafield>[];
    pageInfo?: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  } | null;
}

export class ProductSyncService {
  constructor(
    private admin: ShopifyGraphQLClient,
    private shop: string
  ) {}

  /**
   * Bulk-sync all products with translations, images, options, and metafields.
   * Used by the initial streaming sync to replace inline code in api.sync-all-stream.tsx.
   *
   * Fixes over the previous inline implementation:
   * - Uses metafields(first: 250) instead of first: 50
   * - Fetches sub-resource translations (options, option values, metafields)
   */
  async syncAllProducts(options: {
    maxProducts: number;
    cacheProductImages: boolean;
    onProgress?: (info: {
      overallPercent: number;
      detailCurrent?: number;
      detailTotal?: number;
      message: string;
    }) => void;
    signal?: AbortSignal;
  }): Promise<number> {
    const { maxProducts, cacheProductImages, onProgress, signal } = options;
    const { db, upsertProductMetafields } = await import("../db.server");

    const checkAborted = () => {
      if (signal?.aborted) {
        throw new DOMException("Client disconnected", "AbortError");
      }
    };

    // ==========================================
    // Phase 1: Fetch all products (0-20%)
    // ==========================================
    let allProducts: any[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    onProgress?.({ overallPercent: 0, message: 'Fetching products from Shopify...' });

    while (hasNextPage && allProducts.length < maxProducts) {
      checkAborted();
      const batchSize = Math.min(250, maxProducts - allProducts.length);

      const response: Response = await this.admin.graphql(
        `#graphql
          query getProductsBulk($first: Int!, $after: String) {
            products(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
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
                    linkedMetafield {
                      namespace
                      key
                    }
                    optionValues {
                      id
                      name
                      linkedMetafieldValue
                    }
                  }
                  metafields(first: 250) {
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
              }
            }
          }`,
        { variables: { first: batchSize, after: cursor } }
      );

      const data: any = await response.json();

      if (data.errors) {
        throw new Error(data.errors[0]?.message || "GraphQL error");
      }

      const pageInfo: any = data.data?.products?.pageInfo;
      const products = data.data?.products?.edges?.map((e: any) => e.node) || [];

      allProducts = [...allProducts, ...products];
      hasNextPage = pageInfo?.hasNextPage || false;
      cursor = pageInfo?.endCursor || null;

      onProgress?.({ overallPercent: 20, message: `Fetched ${allProducts.length} products from Shopify...` });
    }

    if (allProducts.length === 0) {
      onProgress?.({ overallPercent: 100, message: 'No products found' });
      return 0;
    }

    // ==========================================
    // Phase 2: Save products to DB (20-60%)
    // ==========================================
    let synced = 0;
    const total = allProducts.length;

    for (const product of allProducts) {
      checkAborted();
      try {
        await db.$transaction(async (tx: any) => {
          // Upsert product
          await tx.product.upsert({
            where: {
              shop_id: { shop: this.shop, id: product.id },
            },
            create: {
              id: product.id,
              shop: this.shop,
              title: product.title,
              descriptionHtml: product.descriptionHtml || "",
              handle: product.handle,
              status: product.status,
              productType: product.productType || null,
              seoTitle: product.seo?.title || null,
              seoDescription: product.seo?.description || null,
              featuredImageUrl: product.featuredImage?.url || null,
              featuredImageAlt: product.featuredImage?.altText || null,
              shopifyUpdatedAt: new Date(product.updatedAt),
              lastSyncedAt: new Date(),
            },
            update: {
              title: product.title,
              descriptionHtml: product.descriptionHtml || "",
              handle: product.handle,
              status: product.status,
              productType: product.productType || null,
              seoTitle: product.seo?.title || null,
              seoDescription: product.seo?.description || null,
              featuredImageUrl: product.featuredImage?.url || null,
              featuredImageAlt: product.featuredImage?.altText || null,
              shopifyUpdatedAt: new Date(product.updatedAt),
              lastSyncedAt: new Date(),
            },
          });

          // Save images
          if (cacheProductImages) {
            const mediaImages = product.media?.edges
              ?.filter((edge: any) => edge.node.id && edge.node.image?.url)
              .map((edge: any) => edge.node) || [];

            if (mediaImages.length > 0) {
              await tx.productImage.deleteMany({ where: { productId: product.id } });
              await tx.productImage.createMany({
                data: mediaImages.map((media: any, index: number) => ({
                  productId: product.id,
                  url: media.image.url,
                  altText: media.alt || null,
                  mediaId: media.id,
                  position: index,
                })),
              });
            }
          }

          // Save options (filter out Shopify's internal "Default Title" placeholder)
          const realOptions = (product.options || []).filter((opt: any) => !isDefaultTitleOption(opt));
          if (realOptions.length > 0) {
            await tx.productOption.deleteMany({ where: { productId: product.id } });
            const optCreateData = realOptions.map((opt: any) => ({
              id: opt.id,
              productId: product.id,
              name: opt.name,
              position: opt.position,
              values: opt.optionValues
                ? JSON.stringify(opt.optionValues.map((v: any) => ({ id: v.id, name: v.name, linked: !!v.linkedMetafieldValue, linkedValue: v.linkedMetafieldValue || undefined })))
                : JSON.stringify(opt.values),
              linkedMetafieldKey: opt.linkedMetafield ? `${opt.linkedMetafield.namespace}--${opt.linkedMetafield.key}` : null,
            }));
            try {
              await tx.productOption.createMany({ data: optCreateData });
            } catch (optErr: unknown) {
              logger.error(`[ProductSync] OPTIONS createMany FAILED for ${product.id}: ${optErr instanceof Error ? optErr.message : String(optErr)}`);
              // Fallback: save without linkedMetafieldKey if column doesn't exist yet
              await tx.productOption.createMany({
                data: realOptions.map((opt: any) => ({
                  id: opt.id,
                  productId: product.id,
                  name: opt.name,
                  position: opt.position,
                  values: opt.optionValues
                    ? JSON.stringify(opt.optionValues.map((v: any) => ({ id: v.id, name: v.name, linked: !!v.linkedMetafieldValue, linkedValue: v.linkedMetafieldValue || undefined })))
                    : JSON.stringify(opt.values),
                })),
              });
            }
          }

          // Upsert metafields (idempotent — safe under concurrent execution)
          const metafields = product.metafields?.edges?.map((edge: any) => edge.node) || [];
          await upsertProductMetafields(tx, product.id, metafields);
        });

        synced++;

        if (synced % 10 === 0 || synced === total) {
          const progress = Math.round(20 + (synced / total) * 40);
          onProgress?.({ overallPercent: progress, detailCurrent: synced, detailTotal: total, message: `Saving products: ${synced}/${total}` });
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        logger.error(`[ProductSync] Failed to save product ${product.id}`, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ==========================================
    // Phase 3: Bulk-fetch translations (60-100%)
    // ==========================================
    if (synced > 0) {
      try {
        checkAborted();
        onProgress?.({ overallPercent: 60, message: 'Fetching product translations...' });

        const shopLocales = await fetchShopLocales(this.admin.graphql.bind(this.admin));
        const nonPrimaryLocales = shopLocales.filter((l) => !l.primary && l.published);

        if (nonPrimaryLocales.length > 0) {
          const productIds = allProducts.map((p: any) => p.id);
          const BATCH_SIZE = 100;
          const batches: string[][] = [];
          for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
            batches.push(productIds.slice(i, i + BATCH_SIZE));
          }

          // 3a. Product translations (60-80%)
          let localeIndex = 0;
          for (const locale of nonPrimaryLocales) {
            localeIndex++;
            checkAborted();

            const localeProgress = Math.round(60 + (localeIndex / nonPrimaryLocales.length) * 20);

            const allTranslations: Array<{
              resourceId: string;
              key: string;
              value: string;
              locale: string;
              digest: string | null;
            }> = [];

            let batchIndex = 0;
            for (const batch of batches) {
              batchIndex++;
              checkAborted();
              onProgress?.({ overallPercent: localeProgress, detailCurrent: batchIndex, detailTotal: batches.length, message: `Fetching translations: ${locale.name || locale.locale} (${localeIndex}/${nonPrimaryLocales.length})` });
              try {
                const response: Response = await this.admin.graphql(
                  `#graphql
                    query getBulkProductTranslations($resourceIds: [ID!]!, $locale: String!) {
                      translatableResourcesByIds(first: ${BATCH_SIZE}, resourceIds: $resourceIds) {
                        edges {
                          node {
                            resourceId
                            translatableContent {
                              key
                              digest
                            }
                            translations(locale: $locale) {
                              key
                              value
                              locale
                            }
                          }
                        }
                      }
                    }`,
                  { variables: { resourceIds: batch, locale: locale.locale } }
                );

                const data: any = await response.json();

                if (data.errors) {
                  logger.warn(`[ProductSync] GraphQL error fetching translations for locale ${locale.locale}:`, data.errors[0]?.message);
                  continue;
                }

                const resources = data.data?.translatableResourcesByIds?.edges || [];
                for (const edge of resources) {
                  const node = edge.node;
                  const digestMap = new Map<string, string>();
                  for (const content of node.translatableContent || []) {
                    if (content.digest) {
                      digestMap.set(content.key, content.digest);
                    }
                  }
                  for (const t of node.translations || []) {
                    if (t.value) {
                      allTranslations.push({
                        resourceId: node.resourceId,
                        key: t.key,
                        value: t.value,
                        locale: t.locale,
                        digest: digestMap.get(t.key) || null,
                      });
                    }
                  }
                }
              } catch (batchErr: unknown) {
                if (batchErr instanceof Error && batchErr.name === "AbortError") throw batchErr;
                logger.warn(`[ProductSync] Failed to fetch translation batch for locale ${locale.locale}:`, batchErr instanceof Error ? batchErr.message : String(batchErr));
              }
            }

            if (allTranslations.length > 0) {
              await db.contentTranslation.createMany({
                data: allTranslations.map(t => ({
                  resourceId: t.resourceId,
                  resourceType: "Product",
                  key: t.key,
                  value: t.value,
                  locale: t.locale,
                  digest: t.digest,
                })),
                skipDuplicates: true,
              });

              logger.debug(`[ProductSync] Saved ${allTranslations.length} product translations for locale ${locale.locale}`);
            }
          }

          // 3b. Sub-resource translations — options, option values, metafields (80-90%)
          onProgress?.({ overallPercent: 80, message: 'Fetching sub-resource translations...' });

          const subResources: Array<{ id: string; type: string }> = [];
          for (const product of allProducts) {
            for (const opt of product.options || []) {
              subResources.push({ id: opt.id, type: "ProductOption" });
              for (const val of opt.optionValues || []) {
                if (val.id && !val.linkedMetafieldValue) {
                  subResources.push({ id: val.id, type: "ProductOptionValue" });
                }
              }
            }
            for (const edge of product.metafields?.edges || []) {
              subResources.push({ id: edge.node.id, type: "Metafield" });
            }
          }

          if (subResources.length > 0) {
            const allSubIds = subResources.map(s => s.id);
            const typeMap = new Map(subResources.map(s => [s.id, s.type]));
            const SUB_BATCH_SIZE = 250;
            const subBatches: string[][] = [];
            for (let i = 0; i < allSubIds.length; i += SUB_BATCH_SIZE) {
              subBatches.push(allSubIds.slice(i, i + SUB_BATCH_SIZE));
            }

            let subLocaleIndex = 0;
            for (const locale of nonPrimaryLocales) {
              subLocaleIndex++;
              checkAborted();

              const subProgress = Math.round(80 + (subLocaleIndex / nonPrimaryLocales.length) * 10);

              const subTranslations: Array<{
                resourceId: string;
                resourceType: string;
                key: string;
                value: string;
                locale: string;
              }> = [];

              let subBatchIndex = 0;
              for (const batch of subBatches) {
                subBatchIndex++;
                checkAborted();
                onProgress?.({ overallPercent: subProgress, detailCurrent: subBatchIndex, detailTotal: subBatches.length, message: `Fetching sub-resource translations: ${locale.name || locale.locale} (${subLocaleIndex}/${nonPrimaryLocales.length})` });
                try {
                  const response: Response = await this.admin.graphql(
                    `#graphql
                      query getSubResourceTranslationsBulk($resourceIds: [ID!]!, $locale: String!) {
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
                    { variables: { resourceIds: batch, locale: locale.locale } }
                  );

                  const data: any = await response.json();

                  if (data.errors) {
                    logger.warn(`[ProductSync] GraphQL error fetching sub-resource translations for locale ${locale.locale}:`, data.errors[0]?.message);
                    continue;
                  }

                  const resources = data.data?.translatableResourcesByIds?.edges || [];
                  for (const edge of resources) {
                    const resourceId = edge.node.resourceId;
                    const resourceType = typeMap.get(resourceId) || "Unknown";
                    for (const t of edge.node.translations || []) {
                      if (t.value) {
                        subTranslations.push({
                          resourceId,
                          resourceType,
                          key: t.key,
                          value: t.value,
                          locale: locale.locale,
                        });
                      }
                    }
                  }
                } catch (batchErr: unknown) {
                  if (batchErr instanceof Error && batchErr.name === "AbortError") throw batchErr;
                  logger.warn(`[ProductSync] Failed to fetch sub-resource translation batch for locale ${locale.locale}:`, batchErr instanceof Error ? batchErr.message : String(batchErr));
                }
              }

              if (subTranslations.length > 0) {
                await db.contentTranslation.createMany({
                  data: subTranslations.map(t => ({
                    resourceId: t.resourceId,
                    resourceType: t.resourceType,
                    key: t.key,
                    value: t.value,
                    locale: t.locale,
                    digest: null,
                  })),
                  skipDuplicates: true,
                });

                logger.debug(`[ProductSync] Saved ${subTranslations.length} sub-resource translations for locale ${locale.locale}`);
              }
            }
          }

          // 3c. Image alt-text translations (90-100%)
          const allMediaIds: string[] = [];
          for (const product of allProducts) {
            const mediaImages = product.media?.edges
              ?.filter((edge: any) => edge.node.id)
              .map((edge: any) => edge.node.id) || [];
            allMediaIds.push(...mediaImages);
          }

          if (allMediaIds.length > 0) {
            onProgress?.({ overallPercent: 90, message: 'Fetching image alt-text translations...' });

            const dbImages = await db.productImage.findMany({
              where: { mediaId: { in: allMediaIds } },
              select: { id: true, mediaId: true },
            });
            const mediaIdToDbId = new Map<string, string>();
            for (const img of dbImages) {
              if (img.mediaId) mediaIdToDbId.set(img.mediaId, img.id);
            }

            const MEDIA_BATCH_SIZE = 250;
            const mediaBatches: string[][] = [];
            for (let i = 0; i < allMediaIds.length; i += MEDIA_BATCH_SIZE) {
              mediaBatches.push(allMediaIds.slice(i, i + MEDIA_BATCH_SIZE));
            }

            const altTranslations: Array<{ imageId: string; locale: string; altText: string }> = [];

            let mediaLocaleIndex = 0;
            for (const locale of nonPrimaryLocales) {
              mediaLocaleIndex++;
              checkAborted();

              let mediaBatchIndex = 0;
              for (const batch of mediaBatches) {
                mediaBatchIndex++;
                checkAborted();
                onProgress?.({ overallPercent: Math.round(90 + (mediaLocaleIndex / nonPrimaryLocales.length) * 7), detailCurrent: mediaBatchIndex, detailTotal: mediaBatches.length, message: `Fetching image translations: ${locale.name || locale.locale} (${mediaLocaleIndex}/${nonPrimaryLocales.length})` });
                try {
                  const response: Response = await this.admin.graphql(
                    `#graphql
                      query getBulkImageAltTranslations($resourceIds: [ID!]!, $locale: String!) {
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
                    { variables: { resourceIds: batch, locale: locale.locale } }
                  );

                  const data: any = await response.json();
                  if (data.errors) {
                    logger.warn(`[ProductSync] GraphQL error fetching alt-text for locale ${locale.locale}:`, data.errors[0]?.message);
                    continue;
                  }

                  const resources = data.data?.translatableResourcesByIds?.edges || [];
                  for (const edge of resources) {
                    const mediaId = edge.node.resourceId;
                    const translations: Array<{ key: string; value: string }> = edge.node.translations || [];
                    const altTranslation = translations.find((t: any) => t.key === "alt");
                    if (altTranslation?.value) {
                      const dbId = mediaIdToDbId.get(mediaId);
                      if (dbId) {
                        altTranslations.push({
                          imageId: dbId,
                          locale: locale.locale,
                          altText: altTranslation.value,
                        });
                      }
                    }
                  }
                } catch (batchErr: unknown) {
                  if (batchErr instanceof Error && batchErr.name === "AbortError") throw batchErr;
                  logger.warn(`[ProductSync] Failed to fetch alt-text batch for locale ${locale.locale}:`, batchErr instanceof Error ? batchErr.message : String(batchErr));
                }
              }
            }

            if (altTranslations.length > 0) {
              onProgress?.({ overallPercent: 97, message: `Saving ${altTranslations.length} image alt-text translations...` });

              await db.productImageAltTranslation.createMany({
                data: altTranslations.map(t => ({
                  imageId: t.imageId,
                  locale: t.locale,
                  altText: t.altText,
                })),
                skipDuplicates: true,
              });

              logger.debug(`[ProductSync] Saved ${altTranslations.length} image alt-text translations`);
            }
          }
        }
      } catch (translationErr: unknown) {
        if (translationErr instanceof Error && translationErr.name === "AbortError") throw translationErr;
        logger.error(`[ProductSync] Failed to fetch product translations:`, translationErr instanceof Error ? translationErr.message : String(translationErr));
        // Non-fatal: products are synced, translations can be loaded on-demand
      }
    }

    onProgress?.({ overallPercent: 100, message: `Synced ${synced} products` });
    return synced;
  }

  /**
   * Sync a single product with all its translations
   */
  async syncProduct(productId: string, forceSync = false): Promise<void> {
    logger.debug(`[ProductSync] Starting sync for product: ${productId}`);

    try {
      // 1. Fetch product data
      const productData = await this.fetchProductData(productId);

      if (!productData) {
        logger.warn(`[ProductSync] Product not found in Shopify: ${productId} - attempting to delete from local database`);

        // Product doesn't exist in Shopify anymore - remove from local database
        try {
          await this.deleteProduct(productId);
          logger.info(`[ProductSync] Successfully deleted non-existent product from database: ${productId}`);
        } catch (deleteError) {
          // Product might not exist in database either - this is OK
          logger.debug(`[ProductSync] Product not found in database (already deleted): ${productId}`);
        }
        return;
      }

      // Log product data for debugging
      logger.debug(`[ProductSync] Product data fetched:`, {
        id: productData.id,
        title: productData.title,
        status: productData.status,
        productType: productData.productType || 'NULL',
        hasDescription: !!productData.descriptionHtml,
        imageCount: productData.media?.edges?.length || 0,
      });

      // Check if product is DRAFT or ARCHIVED
      if (productData.status === 'DRAFT' || productData.status === 'ARCHIVED') {
        logger.debug(`[ProductSync] Product is ${productData.status}: ${productId} - syncing anyway with current status`);
      }

      // 2. Fetch all available locales
      const locales = await fetchShopLocales(this.admin.graphql.bind(this.admin));
      logger.debug(`[ProductSync] Found ${locales.length} locales`);

      // 3. Fetch translations for all non-primary locales
      const foreignLocales = locales.filter((l) => !l.primary);
      const translationResult = await this.fetchAllTranslations(
        productId,
        foreignLocales,
        productData // Pass product data for fallback values
      );

      const allTranslations = translationResult.translations;

      // CRITICAL: Check if translation fetch was successful
      const publishedLocales = foreignLocales.filter((l) => l.published);
      const expectedTranslations = publishedLocales.length > 0;

      if (expectedTranslations && allTranslations.length === 0) {
        logger.error(`[ProductSync] 🔴 CRITICAL: No translations fetched for product with ${publishedLocales.length} published locales!`, {
          productId,
          title: productData.title,
          publishedLocales: publishedLocales.map((l) => l.locale).join(', '),
          hadErrors: translationResult.hadErrors,
          errorCount: translationResult.errorCount,
        });

        // Check if this might be a complete API failure
        // If we have multiple locales AND had errors, this is likely an API failure
        if (publishedLocales.length >= 2 && translationResult.errorCount >= 2) {
          logger.error(`[ProductSync] 🔴 ABORTING SYNC: ${translationResult.errorCount}/${publishedLocales.length} locales failed - refusing to delete existing translations`);
          throw new Error(`Translation fetch failed for ${translationResult.errorCount}/${publishedLocales.length} locales - aborting to prevent data loss`);
        } else if (translationResult.hadErrors) {
          logger.warn(`[ProductSync] ⚠️ Some locales failed (${translationResult.errorCount}), but continuing with partial data`);
        } else {
          logger.warn(`[ProductSync] ⚠️ Product might genuinely have no translations, continuing with sync`);
        }
      }

      logger.debug(`[ProductSync] Fetched ${allTranslations.length} translations from ${foreignLocales.length} foreign locales (errors: ${translationResult.errorCount})`);

      // 4. Fetch image alt-text translations (API 2025-10+)
      const imageAltTranslations = await this.fetchImageAltTextTranslations(
        productData,
        locales.filter((l) => !l.primary && l.published)
      );
      logger.debug(`[ProductSync] Fetched ${imageAltTranslations.length} image alt-text translations`);

      // 4b. Fetch sub-resource translations (options, option values, metafields)
      const subResourceTranslations = await this.fetchSubResourceTranslations(
        productData,
        locales.filter((l) => !l.primary && l.published)
      );
      logger.debug(`[ProductSync] Fetched ${subResourceTranslations.length} sub-resource translations`);

      // 5. Save to database
      await this.saveToDatabase(productData, allTranslations, imageAltTranslations, subResourceTranslations, forceSync);

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
    productData: ShopifyProductData,
    locales: ShopLocale[]
  ): Promise<Array<{ mediaId: string; locale: string; altText: string }>> {
    const altTranslations: Array<{ mediaId: string; locale: string; altText: string }> = [];

    // Get all media images from product
    const mediaImages = productData.media?.edges
      ?.filter((edge) => edge.node.id) // Filter out non-MediaImage types
      .map((edge) => edge.node) || [];

    if (mediaImages.length === 0) {
      logger.debug(`[ProductSync] No media images found for alt-text translations`);
      return altTranslations;
    }

    // Collect all MediaImage IDs for bulk query
    const mediaIds = mediaImages.map((m) => m.id);

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
          const translations: Array<{ key: string; value: string }> = edge.node.translations || [];

          const altTranslation = translations.find((t) => t.key === "alt");
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
   * Fetch translations for all product sub-resources (options, option values, metafields)
   * Uses translatableResourcesByIds for BULK loading — 1 API call per locale
   *
   * This puts sub-resource translations into the same sync pipeline as main
   * product translations so the loader can pre-load them from DB instantly.
   */
  private async fetchSubResourceTranslations(
    productData: ShopifyProductData,
    locales: ShopLocale[]
  ): Promise<Array<{ resourceId: string; resourceType: string; key: string; value: string; locale: string }>> {
    const results: Array<{ resourceId: string; resourceType: string; key: string; value: string; locale: string }> = [];

    // Collect all sub-resource IDs from product data
    const subResources: Array<{ id: string; type: string }> = [];

    for (const opt of productData.options || []) {
      subResources.push({ id: opt.id, type: "ProductOption" });
      for (const val of opt.optionValues || []) {
        // Skip linked option values — their translations come from metafields
        if (val.id && !val.linkedMetafieldValue) {
          subResources.push({ id: val.id, type: "ProductOptionValue" });
        }
      }
    }

    for (const edge of productData.metafields?.edges || []) {
      const mf = edge.node;
      subResources.push({ id: mf.id, type: "Metafield" });
    }

    if (subResources.length === 0) return results;

    const allIds = subResources.map(s => s.id);
    const typeMap = new Map(subResources.map(s => [s.id, s.type]));

    logger.debug(`[ProductSync] Fetching sub-resource translations for ${allIds.length} resources using BULK query`);

    // 1 API call per locale (bulk)
    for (const locale of locales) {
      try {
        const response = await this.admin.graphql(
          `#graphql
            query getSubResourceTranslationsBulk($resourceIds: [ID!]!, $locale: String!) {
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
          { variables: { resourceIds: allIds, locale: locale.locale } }
        );

        const data = await response.json();

        if (data.errors) {
          logger.warn(`[ProductSync] GraphQL error fetching sub-resource translations for locale ${locale.locale}:`, data.errors[0]?.message);
          continue;
        }

        const resources = data.data?.translatableResourcesByIds?.edges || [];

        let foundCount = 0;
        for (const edge of resources) {
          const resourceId = edge.node.resourceId;
          const translations: Array<{ key: string; value: string }> = edge.node.translations || [];
          const resourceType = typeMap.get(resourceId) || "Unknown";

          for (const t of translations) {
            if (t.value) {
              results.push({
                resourceId,
                resourceType,
                key: t.key,
                value: t.value,
                locale: locale.locale,
              });
              foundCount++;
            }
          }
        }

        if (foundCount > 0) {
          logger.debug(`[ProductSync] Found ${foundCount} sub-resource translations for locale ${locale.locale}`);
        }
      } catch (error) {
        logger.warn(`[ProductSync] Failed to fetch sub-resource translations for locale ${locale.locale}:`, error);
      }
    }

    logger.debug(`[ProductSync] Total sub-resource translations fetched: ${results.length}`);
    return results;
  }

  /**
   * Fetch product data from Shopify with paginated metafields
   * Uses media query instead of images to get MediaImage IDs for translations (API 2025-10+)
   */
  private async fetchProductData(productId: string): Promise<ShopifyProductData | null> {
    logger.debug(`[ProductSync] Fetching product data with paginated metafields for: ${productId}`);

    // First, fetch base product data with first page of metafields
    const response = await this.admin.graphql(
      `#graphql
        query getProduct($id: ID!, $metafieldsFirst: Int!, $metafieldsAfter: String) {
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
              linkedMetafield {
                namespace
                key
              }
              optionValues {
                id
                name
                linkedMetafieldValue
              }
            }
            metafields(first: $metafieldsFirst, after: $metafieldsAfter) {
              edges {
                node {
                  id
                  namespace
                  key
                  value
                  type
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }`,
      { variables: { id: productId, metafieldsFirst: 250, metafieldsAfter: null } }
    );

    const data = await response.json();

    // Check for GraphQL errors
    if (data.errors && data.errors.length > 0) {
      logger.error(`[ProductSync] GraphQL errors for product ${productId}:`, {
        errors: data.errors,
        productId,
      });

      // Distinguish between "not found" errors and other errors
      const notFoundError = (data.errors as GraphQLError[]).some((e) =>
        e.message?.toLowerCase().includes('not found') ||
        e.message?.toLowerCase().includes('does not exist') ||
        e.message?.toLowerCase().includes('could not find')
      );

      if (notFoundError) {
        logger.debug(`[ProductSync] Product not found (GraphQL error): ${productId}`);
        return null; // Product doesn't exist - this is expected for deleted products
      }

      // For other errors (rate limiting, permissions, etc.), throw to retry
      throw new Error(`GraphQL error: ${(data.errors as GraphQLError[])[0].message}`);
    }

    // Check if product data is present
    let product: ShopifyProductData | undefined = data.data?.product;

    if (!product) {
      logger.warn(`[ProductSync] Product data is null (but no GraphQL errors): ${productId}`);
      return null;
    }

    // Collect all metafields using pagination
    const allMetafields: ShopifyMetafield[] = [];
    let hasNextPage = product.metafields?.pageInfo?.hasNextPage || false;
    let cursor = product.metafields?.pageInfo?.endCursor || null;

    // Add first page of metafields
    const firstPageMetafields = product.metafields?.edges?.map((edge) => edge.node) || [];
    allMetafields.push(...firstPageMetafields);
    logger.debug(`[ProductSync] Fetched ${firstPageMetafields.length} metafields (first page), hasNextPage: ${hasNextPage}`);

    // Fetch remaining pages
    while (hasNextPage && cursor) {
      logger.debug(`[ProductSync] Fetching next page of metafields, cursor: ${cursor.substring(0, 20)}...`);

      const nextResponse = await this.admin.graphql(
        `#graphql
          query getProductMetafields($id: ID!, $metafieldsFirst: Int!, $metafieldsAfter: String) {
            product(id: $id) {
              metafields(first: $metafieldsFirst, after: $metafieldsAfter) {
                edges {
                  node {
                    id
                    namespace
                    key
                    value
                    type
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }`,
        { variables: { id: productId, metafieldsFirst: 250, metafieldsAfter: cursor } }
      );

      const nextData = await nextResponse.json();

      if (nextData.errors && nextData.errors.length > 0) {
        logger.error(`[ProductSync] Error fetching next page of metafields:`, nextData.errors[0].message);
        break; // Stop pagination on error, but keep what we have
      }

      const nextPageMetafields = nextData.data?.product?.metafields?.edges?.map((edge: GraphQLEdge<ShopifyMetafield>) => edge.node) || [];
      allMetafields.push(...nextPageMetafields);

      hasNextPage = nextData.data?.product?.metafields?.pageInfo?.hasNextPage || false;
      cursor = nextData.data?.product?.metafields?.pageInfo?.endCursor || null;

      logger.debug(`[ProductSync] Fetched ${nextPageMetafields.length} metafields (page), total: ${allMetafields.length}, hasNextPage: ${hasNextPage}`);
    }

    logger.info(`[ProductSync] Successfully fetched ${allMetafields.length} metafields for product ${productId}`);

    // Replace metafields with all paginated results
    product.metafields = {
      edges: allMetafields.map(node => ({ node }))
    };

    // Log warning if productType is missing (this shouldn't happen normally)
    if (!product.productType) {
      logger.warn(`[ProductSync] ⚠️ Product has NULL productType in Shopify:`, {
        productId: product.id,
        title: product.title,
        status: product.status,
      });
    }

    return product;
  }

  /**
   * Fetch translations for all locales
   *
   * IMPORTANT: Only saves ACTUAL translations from Shopify.
   * If a field has no translation in Shopify, it will NOT be stored in the database.
   * This prevents the primary language text from appearing as a "translation".
   *
   * Returns: { translations, hadErrors, errorCount }
   */
  private async fetchAllTranslations(productId: string, locales: ShopLocale[], productData: ShopifyProductData): Promise<{
    translations: ResolvedTranslation[];
    hadErrors: boolean;
    errorCount: number;
  }> {
    const allTranslations: ResolvedTranslation[] = [];
    const digestMap = new Map<string, string>();
    const errors: string[] = [];
    const skipped: string[] = [];

    logger.debug(`[ProductSync] Starting translation fetch for ${locales.length} locales`);

    for (const locale of locales) {
      if (!locale.published) {
        logger.debug(`[ProductSync] Skipping unpublished locale: ${locale.locale}`);
        skipped.push(locale.locale);
        continue;
      }

      logger.debug(`[ProductSync] Fetching translations for locale: ${locale.locale}`);

      try {
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

        // Check for GraphQL errors for this locale
        if (data.errors && data.errors.length > 0) {
          logger.warn(`[ProductSync] GraphQL errors fetching translations for locale ${locale.locale}:`, {
            errors: data.errors,
            productId,
            locale: locale.locale,
          });
          errors.push(`${locale.locale}: ${(data.errors as GraphQLError[])[0].message}`);
          // Continue with other locales instead of failing completely
          continue;
        }

        const resource = data.data?.translatableResource;

        if (!resource) {
          logger.warn(`[ProductSync] No translatable resource found for ${locale.locale}`);
          errors.push(`${locale.locale}: No translatable resource`);
          continue;
        }

        // Build digest map from translatableContent (for reference only)
        if (resource.translatableContent) {
          logger.debug(`[ProductSync] Available translatable keys for ${locale.locale}:`,
            resource.translatableContent.map((c: { key: string }) => c.key).join(', '));

          for (const content of resource.translatableContent) {
            // Store digest for future updates - but DO NOT store as translation
            digestMap.set(content.key, content.digest);
          }
        }

        // ONLY save actual translations from Shopify
        // DO NOT save translatableContent values - those are the source language text
        if (resource.translations && resource.translations.length > 0) {
          logger.debug(`[ProductSync] Actual translations for ${locale.locale}:`,
            resource.translations.map((t: ShopifyTranslation) => t.key).join(', '));

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
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // Log error but continue with other locales (graceful degradation)
        logger.error(`[ProductSync] Error fetching translations for locale ${locale.locale}:`, {
          error: message,
          productId,
          locale: locale.locale,
        });
        errors.push(`${locale.locale}: ${message}`);
        // Continue to next locale
      }
    }

    // Summary logging
    const successfulLocales = locales.length - skipped.length - errors.length;
    logger.debug(`[ProductSync] Translation fetch complete:`, {
      totalLocales: locales.length,
      successful: successfulLocales,
      skipped: skipped.length,
      errors: errors.length,
      translationsFound: allTranslations.length,
    });

    if (errors.length > 0) {
      logger.warn(`[ProductSync] Failed to fetch translations for ${errors.length} locale(s):`, {
        productId,
        errors: errors.join('; '),
      });
    }

    return {
      translations: allTranslations,
      hadErrors: errors.length > 0,
      errorCount: errors.length,
    };
  }

  /**
   * Save product and translations to database
   * Includes image alt-text translations from Shopify (API 2025-10+)
   * Uses a transaction to ensure data consistency
   */
  private async saveToDatabase(
    productData: ShopifyProductData,
    translations: ResolvedTranslation[],
    imageAltTranslations: Array<{ mediaId: string; locale: string; altText: string }> = [],
    subResourceTranslations: Array<{ resourceId: string; resourceType: string; key: string; value: string; locale: string }> = [],
    forceSync = false
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

    const mediaImages: ShopifyMediaImage[] = productData.media?.edges
      ?.filter((edge) => edge.node.id && edge.node.image?.url)
      .map((edge) => edge.node) || [];

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

      // Check if user recently saved translations for this product
      // Skip this check on manual reload (forceSync) - user explicitly wants fresh data
      const skipTranslationSync = !forceSync && isTranslationRecentlySaved(productData.id);

      if (skipTranslationSync) {
        logger.info(`[ProductSync] Skipping translation sync - recently saved by user`, { productId: productData.id });
      } else {
        // Delete old translations and recreate from Shopify
        const deletedTranslations = await tx.contentTranslation.deleteMany({
          where: { resourceId: productData.id, resourceType: "Product" }
        });
        logger.debug(`[ProductSync] Deleted ${deletedTranslations.count} old translations from database`);

        // Insert translations
        if (validTranslations.length > 0) {
          const translationsByLocale = validTranslations.reduce((acc: Record<string, string[]>, t) => {
            if (!acc[t.locale]) acc[t.locale] = [];
            acc[t.locale].push(t.key);
            return acc;
          }, {});

          logger.debug(`[ProductSync] Saving ${validTranslations.length} translations to database:`);
          for (const [locale, keys] of Object.entries(translationsByLocale)) {
            logger.debug(`[ProductSync]   ${locale}: ${keys.join(', ')}`);
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

        // Save sub-resource translations (options, option values, metafields)
        if (subResourceTranslations.length > 0) {
          const subResourceIds = [...new Set(subResourceTranslations.map(t => t.resourceId))];

          const deletedSubTrans = await tx.contentTranslation.deleteMany({
            where: {
              resourceId: { in: subResourceIds },
              resourceType: { in: ["ProductOption", "ProductOptionValue", "Metafield"] },
            },
          });
          logger.debug(`[ProductSync] Deleted ${deletedSubTrans.count} old sub-resource translations`);

          await tx.contentTranslation.createMany({
            data: subResourceTranslations.map(t => ({
              resourceId: t.resourceId,
              resourceType: t.resourceType,
              key: t.key,
              value: t.value,
              locale: t.locale,
              digest: null,
            })),
          });
          logger.debug(`[ProductSync] Saved ${subResourceTranslations.length} sub-resource translations`);
        }
      }

      // DIAGNOSTIC: Log what we're about to save for productType
      logger.debug(`[ProductSync] 🔍 DIAGNOSTIC - About to save product to DB:`, {
        productId: productData.id,
        title: productData.title,
        productType: productData.productType === null ? "NULL_FROM_SHOPIFY" : productData.productType === "" ? "EMPTY_STRING" : productData.productType || "FALSY_VALUE",
        productTypeLength: productData.productType?.length || 0,
        translationsCount: validTranslations.length,
        hasTranslations: validTranslations.length > 0,
      });

      await tx.productImage.deleteMany({ where: { productId: productData.id } });
      await tx.productOption.deleteMany({ where: { productId: productData.id } });

      // Insert ALL images to database (with mediaId for translation support)
      if (mediaImages.length > 0) {
        // Log what Shopify returned for alt-texts
        logger.debug(`[ProductSync] [SYNC] Syncing ${mediaImages.length} images from Shopify 🔵🔵🔵`);
        mediaImages.forEach((media, index) => {
          logger.debug(`[ProductSync] [SYNC] Image ${index}: mediaId=${media.id}, alt="${media.alt}" (isNull: ${media.alt === null}, isEmpty: ${media.alt === ""})`);
        });

        // Create images with mediaId for translation support
        const createdImages = await Promise.all(
          mediaImages.map(async (media, index) => {
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
        try {
          await tx.productOption.createMany({
            data: productData.options.map((opt) => ({
              id: opt.id,
              productId: productData.id,
              name: opt.name,
              position: opt.position,
              values: JSON.stringify((opt.optionValues ?? []).map(v => ({ id: v.id, name: v.name, linked: !!v.linkedMetafieldValue, linkedValue: v.linkedMetafieldValue || undefined }))),
              linkedMetafieldKey: opt.linkedMetafield ? `${opt.linkedMetafield.namespace}--${opt.linkedMetafield.key}` : null,
            })),
          });
        } catch (optErr: unknown) {
          logger.error(`[ProductSync] saveToDatabase OPTIONS createMany FAILED: ${optErr instanceof Error ? optErr.message : String(optErr)}`);
          // Fallback: save without linkedMetafieldKey if column doesn't exist yet
          await tx.productOption.createMany({
            data: productData.options.map((opt) => ({
              id: opt.id,
              productId: productData.id,
              name: opt.name,
              position: opt.position,
              values: JSON.stringify((opt.optionValues ?? []).map(v => ({ id: v.id, name: v.name, linked: !!v.linkedMetafieldValue, linkedValue: v.linkedMetafieldValue || undefined }))),
            })),
          });
        }

        logger.debug(`[ProductSync] Saved ${productData.options.length} options`);
      }

      // Upsert metafields (idempotent — safe under concurrent execution)
      const metafields: ShopifyMetafield[] = productData.metafields?.edges?.map((edge) => edge.node) || [];
      const { upsertProductMetafields } = await import("../db.server");
      await upsertProductMetafields(tx, productData.id, metafields);
      if (metafields.length > 0) {
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
  async syncSingleProduct(productId: string, includeAllImages: boolean = true): Promise<Record<string, unknown> | null> {
    logger.debug(`[ProductSync] Manual sync for product: ${productId} (images: ${includeAllImages ? "all" : "featured only"})`);

    // Convert to GID format if numeric
    const gid = productId.startsWith("gid://")
      ? productId
      : `gid://shopify/Product/${productId}`;

    try {
      // Sync the product (forceSync=true bypasses save lock for manual reload)
      await this.syncProduct(gid, /* forceSync */ true);

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
