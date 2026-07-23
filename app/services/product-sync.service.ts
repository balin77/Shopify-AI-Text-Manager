/**
 * Product Sync Service
 *
 * Synchronizes product data from Shopify to local PostgreSQL database
 * including all translations for all available locales.
 */

import type { Prisma } from '@prisma/client';
import { logger } from '~/utils/logger.server';
import { isTranslationRecentlySaved } from '~/utils/translation-save-lock.server';
import { markProductDeleted, isProductRecentlyDeleted } from '~/utils/product-delete-lock.server';
import { withDbRaceRetry } from '~/utils/db-retry.server';
import type { ShopifyGraphQLClient, ShopLocale, GraphQLEdge, ShopifyTranslation, ResolvedTranslation, ProgressCallback } from './sync-types';
import type { MarketInfo } from '~/types/content-editor.types';
import { fetchShopLocales, fetchShopMarkets, fetchedMarketLayers, marketLayersForLocale } from './sync-utils';
import { isDefaultTitleOption } from '~/utils/shopify-product.utils';
import { syncProductVariantRows, type ShopifySyncVariant } from './product-variant-sync.server';

/** GraphQL error shape */
interface GraphQLError {
  message: string;
}

/** Response shape for bulk products query */
interface BulkProductsQueryResponse {
  data?: {
    products?: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: GraphQLEdge<ShopifyProductData>[];
    };
  };
  errors?: GraphQLError[];
}

/** Response shape for translatableResourcesByIds queries */
interface TranslatableResourcesByIdsResponse {
  data?: {
    translatableResourcesByIds?: {
      edges: GraphQLEdge<{
        resourceId: string;
        translatableContent?: Array<{ key: string; digest: string | null }>;
        translations: Array<{ key: string; value: string; locale?: string }>;
      }>[];
    };
  };
  errors?: GraphQLError[];
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
  /** Variant window of the sync (Plan §5.1): first 100 only, NO pagination —
   * hasNextPage marks products whose remainder stays in the Shopify admin. */
  variants?: {
    pageInfo?: { hasNextPage: boolean } | null;
    nodes?: ShopifySyncVariant[] | null;
  } | null;
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
  /** Markets memo — loaded once per service instance (one instance ≈ one sync run). */
  private marketsPromise: Promise<MarketInfo[]> | null = null;

  constructor(
    private admin: ShopifyGraphQLClient,
    private shop: string
  ) {}

  /** Shop markets for the market-aware read-back; [] when scope/markets missing. */
  private getMarkets(): Promise<MarketInfo[]> {
    if (!this.marketsPromise) {
      this.marketsPromise = fetchShopMarkets(this.admin.graphql.bind(this.admin));
    }
    return this.marketsPromise;
  }

  /**
   * Bulk-sync all products with translations, images, options, and metafields.
   * Used by the initial full sync (services/initial-sync.service.ts).
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
    let allProducts: ShopifyProductData[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    onProgress?.({ overallPercent: 0, message: 'Fetching products from Shopify...' });

    while (hasNextPage && allProducts.length < maxProducts) {
      checkAborted();
      const batchSize = Math.min(250, maxProducts - allProducts.length);

      const response = await this.admin.graphql(
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
                  variants(first: 100) {
                    pageInfo {
                      hasNextPage
                    }
                    nodes {
                      id
                      title
                      sku
                      price
                      compareAtPrice
                      position
                      barcode
                      image {
                        url
                      }
                    }
                  }
                }
              }
            }
          }`,
        { variables: { first: batchSize, after: cursor } }
      );

      const data = await response.json() as BulkProductsQueryResponse;

      if (data.errors) {
        throw new Error(data.errors[0]?.message || "GraphQL error");
      }

      const pageInfo = data.data?.products?.pageInfo;
      const products = data.data?.products?.edges?.map((e) => e.node) ?? [];

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

    // R3-H3: write products in BATCHES, one transaction per batch, instead
    // of one interactive transaction per product. The previous loop opened a
    // separate transaction for every product (~10k tx / ~50k statements for
    // a 10k-product shop, fully serial). Batching collapses that to
    // ceil(n/BATCH) transactions. A batch failure (one malformed product
    // would otherwise roll back its neighbours) falls back to per-product
    // transactions for that batch only, preserving the original per-product
    // fault isolation.
    const writeProduct = async (tx: Prisma.TransactionClient, product: ShopifyProductData) => {
      // NOTE (review MEDIUM "webhook ordering"): we deliberately do NOT
      // compare the stored shopifyUpdatedAt against the incoming value to
      // reject out-of-order writes. Webhook handlers never apply the webhook
      // payload directly — they call syncProduct(), which fetches the CURRENT
      // live product state from Shopify, so the last write always reflects
      // the freshest Shopify state regardless of delivery order.
      // hasMoreVariants (Plan §5.1): only touched when the variants block was
      // actually delivered — a partial response must not flip the flag.
      const hasMoreVariants = product.variants
        ? product.variants.pageInfo?.hasNextPage ?? false
        : undefined;
      await tx.product.upsert({
        where: { shop_id: { shop: this.shop, id: product.id } },
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
          hasMoreVariants: hasMoreVariants ?? false,
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
          ...(hasMoreVariants !== undefined ? { hasMoreVariants } : {}),
          shopifyUpdatedAt: new Date(product.updatedAt),
          lastSyncedAt: new Date(),
        },
      });

      // Save images
      if (cacheProductImages) {
        const mediaImages = product.media?.edges
          ?.filter((edge) => edge.node.id && edge.node.image?.url)
          .map((edge) => edge.node) ?? [];

        if (mediaImages.length > 0) {
          // Deleting ProductImage rows CASCADES away every
          // ProductImageAltTranslation (global AND market layers). Snapshot
          // them and re-attach to the recreated images (matched by mediaId)
          // so translations survive the delete-then-recreate. Phase 3c then
          // refreshes the layers it successfully fetches (delete+recreate
          // scoped per layer), so preserved rows never go permanently stale.
          const preservedAltRows = await tx.productImageAltTranslation.findMany({
            where: { image: { productId: product.id } },
            select: { locale: true, altText: true, marketId: true, image: { select: { mediaId: true } } },
          });

          await tx.productImage.deleteMany({ where: { productId: product.id } });
          await tx.productImage.createMany({
            data: mediaImages.map((media, index) => ({
              productId: product.id,
              url: media.image.url,
              altText: media.alt || null,
              mediaId: media.id,
              position: index,
            })),
          });

          if (preservedAltRows.length > 0) {
            const newImages = await tx.productImage.findMany({
              where: { productId: product.id },
              select: { id: true, mediaId: true },
            });
            const newIdByMediaId = new Map(newImages.filter((i) => i.mediaId).map((i) => [i.mediaId as string, i.id]));
            const restoreData = preservedAltRows.flatMap((row) => {
              const newImageId = row.image.mediaId ? newIdByMediaId.get(row.image.mediaId) : undefined;
              return newImageId
                ? [{ imageId: newImageId, locale: row.locale, altText: row.altText, marketId: row.marketId }]
                : [];
            });
            if (restoreData.length > 0) {
              await tx.productImageAltTranslation.createMany({ data: restoreData, skipDuplicates: true });
            }
          }
        }
      }

      // Save options (filter out Shopify's internal "Default Title" placeholder)
      const realOptions = (product.options ?? []).filter((opt) => !isDefaultTitleOption(opt));
      // Always delete stale options so products without real variants don't keep phantom options
      await tx.productOption.deleteMany({ where: { productId: product.id } });
      if (realOptions.length > 0) {
        const optCreateData = realOptions.map((opt) => ({
          id: opt.id,
          productId: product.id,
          name: opt.name,
          position: opt.position,
          values: opt.optionValues
            ? JSON.stringify(opt.optionValues.map((v) => ({ id: v.id, name: v.name, linked: !!v.linkedMetafieldValue, linkedValue: v.linkedMetafieldValue || undefined })))
            : JSON.stringify((opt as { values?: string[] }).values),
          linkedMetafieldKey: opt.linkedMetafield ? `${opt.linkedMetafield.namespace}--${opt.linkedMetafield.key}` : null,
        }));
        await tx.productOption.createMany({ data: optCreateData });
      }

      // Upsert metafields (idempotent — safe under concurrent execution)
      const metafields = product.metafields?.edges?.map((edge) => edge.node) ?? [];
      await upsertProductMetafields(tx, product.id, metafields);

      // Variants (Plan §5.1): targeted upsert + targeted delete of vanished
      // ids — NEVER deleteMany+createMany, galleryJson/imageKey come from the
      // image manager and must survive. hasNextPage = the 100-variant window
      // is truncated — deletion is skipped inside (review Finding 4).
      await syncProductVariantRows(
        tx,
        product.id,
        product.variants?.nodes ?? null,
        product.variants?.pageInfo?.hasNextPage ?? false,
      );
    };

    const PRODUCT_BATCH_SIZE = 100;
    // Interactive-transaction defaults (5s) are far too low for a 100-product
    // batch; raise them so a batch can't spuriously time out.
    const TX_OPTS = { maxWait: 15_000, timeout: 120_000 } as const;

    const reportProgress = () => {
      const done = Math.min(synced, total);
      const progress = Math.round(20 + (done / total) * 40);
      onProgress?.({ overallPercent: progress, detailCurrent: done, detailTotal: total, message: `Saving products: ${done}/${total}` });
    };

    for (let i = 0; i < allProducts.length; i += PRODUCT_BATCH_SIZE) {
      checkAborted();
      const chunk = allProducts.slice(i, i + PRODUCT_BATCH_SIZE);
      try {
        // R4-DI2: the PRIMARY batch transaction must also be race-retried
        // (not just the per-product fallback below). A single image colliding
        // with a concurrent alt-text apply (P2002/P2034/…) otherwise aborts
        // the whole 100-product batch on the first try; retrying the batch
        // heals transient contention before paying for the slow per-product
        // path, and avoids silently skipping a product under sustained
        // contention. (The earlier "wraps BOTH" claim was only true for the
        // fallback — this closes that gap.)
        await withDbRaceRetry(() => db.$transaction(async (tx: Prisma.TransactionClient) => {
          for (const product of chunk) await writeProduct(tx, product);
        }, TX_OPTS));
        synced += chunk.length;
      } catch (batchErr: unknown) {
        if (batchErr instanceof DOMException && batchErr.name === "AbortError") throw batchErr;
        logger.warn(`[ProductSync] Batch write failed (${chunk.length} products) — retrying per-product`, { error: batchErr instanceof Error ? batchErr.message : String(batchErr) });
        for (const product of chunk) {
          checkAborted();
          try {
            // writeProduct does deleteMany+createMany on ProductImage, so the
            // per-product retry path can lose the (productId, mediaId) race
            // against a concurrent alt-text apply (P2002, or P2003/P2025/P2034/
            // P2028 under contention). Heal it here, symmetric to the apply
            // route — the batch path above already falls back to this.
            await withDbRaceRetry(() => db.$transaction(async (tx: Prisma.TransactionClient) => {
              await writeProduct(tx, product);
            }, TX_OPTS));
            synced++;
          } catch (err: unknown) {
            if (err instanceof DOMException && err.name === "AbortError") throw err;
            logger.error(`[ProductSync] Failed to save product ${product.id}`, { error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      reportProgress();
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
        // Market-aware read-back: [] when scope/markets missing → global-only.
        const markets = await this.getMarkets();

        if (nonPrimaryLocales.length > 0) {
          const productIds = allProducts.map((p) => p.id);
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
              marketId: string;
            }> = [];

            // Global layer ("") plus one pass per market serving this locale
            for (const marketId of marketLayersForLocale(markets, locale.locale)) {
              let batchIndex = 0;
              for (const batch of batches) {
                batchIndex++;
                checkAborted();
                onProgress?.({ overallPercent: localeProgress, detailCurrent: batchIndex, detailTotal: batches.length, message: `Fetching translations: ${locale.name || locale.locale} (${localeIndex}/${nonPrimaryLocales.length})` });
                try {
                  const response = await this.admin.graphql(
                    `#graphql
                      query getBulkProductTranslations($resourceIds: [ID!]!, $locale: String!, $marketId: ID) {
                        translatableResourcesByIds(first: ${BATCH_SIZE}, resourceIds: $resourceIds) {
                          edges {
                            node {
                              resourceId
                              translatableContent {
                                key
                                digest
                              }
                              translations(locale: $locale, marketId: $marketId) {
                                key
                                value
                                locale
                              }
                            }
                          }
                        }
                      }`,
                    { variables: { resourceIds: batch, locale: locale.locale, marketId: marketId || null } }
                  );

                  const data = await response.json() as TranslatableResourcesByIdsResponse;

                  if (data.errors) {
                    logger.warn(`[ProductSync] GraphQL error fetching translations for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, data.errors[0]?.message);
                    continue;
                  }

                  const resources = data.data?.translatableResourcesByIds?.edges ?? [];
                  for (const edge of resources) {
                    const node = edge.node;
                    const digestMap = new Map<string, string>();
                    for (const content of node.translatableContent ?? []) {
                      if (content.digest) {
                        digestMap.set(content.key, content.digest);
                      }
                    }
                    for (const t of node.translations ?? []) {
                      if (t.value) {
                        allTranslations.push({
                          resourceId: node.resourceId,
                          key: t.key,
                          value: t.value,
                          locale: t.locale ?? locale.locale,
                          digest: digestMap.get(t.key) ?? null,
                          marketId,
                        });
                      }
                    }
                  }
                } catch (batchErr: unknown) {
                  if (batchErr instanceof DOMException && batchErr.name === "AbortError") throw batchErr;
                  logger.warn(`[ProductSync] Failed to fetch translation batch for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, batchErr instanceof Error ? batchErr.message : String(batchErr));
                }
              }
            }

            if (allTranslations.length > 0) {
              await db.contentTranslation.createMany({
                data: allTranslations.map(t => ({
                  shop: this.shop,
                  resourceId: t.resourceId,
                  resourceType: "Product",
                  key: t.key,
                  value: t.value,
                  locale: t.locale,
                  digest: t.digest,
                  marketId: t.marketId,
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
                marketId: string;
              }> = [];

              for (const marketId of marketLayersForLocale(markets, locale.locale)) {
                let subBatchIndex = 0;
                for (const batch of subBatches) {
                  subBatchIndex++;
                  checkAborted();
                  onProgress?.({ overallPercent: subProgress, detailCurrent: subBatchIndex, detailTotal: subBatches.length, message: `Fetching sub-resource translations: ${locale.name || locale.locale} (${subLocaleIndex}/${nonPrimaryLocales.length})` });
                  try {
                    const response = await this.admin.graphql(
                      `#graphql
                        query getSubResourceTranslationsBulk($resourceIds: [ID!]!, $locale: String!, $marketId: ID) {
                          translatableResourcesByIds(first: 250, resourceIds: $resourceIds) {
                            edges {
                              node {
                                resourceId
                                translations(locale: $locale, marketId: $marketId) {
                                  key
                                  value
                                }
                              }
                            }
                          }
                        }`,
                      { variables: { resourceIds: batch, locale: locale.locale, marketId: marketId || null } }
                    );

                    const data = await response.json() as TranslatableResourcesByIdsResponse;

                    if (data.errors) {
                      logger.warn(`[ProductSync] GraphQL error fetching sub-resource translations for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, data.errors[0]?.message);
                      continue;
                    }

                    const resources = data.data?.translatableResourcesByIds?.edges ?? [];
                    for (const edge of resources) {
                      const resourceId = edge.node.resourceId;
                      const resourceType = typeMap.get(resourceId) ?? "Unknown";
                      for (const t of edge.node.translations ?? []) {
                        if (t.value) {
                          subTranslations.push({
                            resourceId,
                            resourceType,
                            key: t.key,
                            value: t.value,
                            locale: locale.locale,
                            marketId,
                          });
                        }
                      }
                    }
                  } catch (batchErr: unknown) {
                    if (batchErr instanceof DOMException && batchErr.name === "AbortError") throw batchErr;
                    logger.warn(`[ProductSync] Failed to fetch sub-resource translation batch for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, batchErr instanceof Error ? batchErr.message : String(batchErr));
                  }
                }
              }

              if (subTranslations.length > 0) {
                await db.contentTranslation.createMany({
                  data: subTranslations.map(t => ({
                    shop: this.shop,
                    resourceId: t.resourceId,
                    resourceType: t.resourceType,
                    key: t.key,
                    value: t.value,
                    locale: t.locale,
                    digest: null,
                    marketId: t.marketId,
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
              ?.filter((edge) => edge.node.id)
              .map((edge) => edge.node.id) ?? [];
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

            const altTranslations: Array<{ imageId: string; locale: string; altText: string; marketId: string }> = [];
            // Layers we attempted vs. layers with at least one failed batch —
            // only cleanly fetched layers are replaced in the DB below.
            const attemptedAltLayers = new Set<string>();
            const failedAltLayers = new Set<string>();

            let mediaLocaleIndex = 0;
            for (const locale of nonPrimaryLocales) {
              mediaLocaleIndex++;
              checkAborted();

              for (const marketId of marketLayersForLocale(markets, locale.locale)) {
                attemptedAltLayers.add(marketId);
                let mediaBatchIndex = 0;
                for (const batch of mediaBatches) {
                  mediaBatchIndex++;
                  checkAborted();
                  onProgress?.({ overallPercent: Math.round(90 + (mediaLocaleIndex / nonPrimaryLocales.length) * 7), detailCurrent: mediaBatchIndex, detailTotal: mediaBatches.length, message: `Fetching image translations: ${locale.name || locale.locale} (${mediaLocaleIndex}/${nonPrimaryLocales.length})` });
                  try {
                    const response = await this.admin.graphql(
                      `#graphql
                        query getBulkImageAltTranslations($resourceIds: [ID!]!, $locale: String!, $marketId: ID) {
                          translatableResourcesByIds(first: 250, resourceIds: $resourceIds) {
                            edges {
                              node {
                                resourceId
                                translations(locale: $locale, marketId: $marketId) {
                                  key
                                  value
                                }
                              }
                            }
                          }
                        }`,
                      { variables: { resourceIds: batch, locale: locale.locale, marketId: marketId || null } }
                    );

                    const data = await response.json() as TranslatableResourcesByIdsResponse;
                    if (data.errors) {
                      logger.warn(`[ProductSync] GraphQL error fetching alt-text for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, data.errors[0]?.message);
                      failedAltLayers.add(marketId);
                      continue;
                    }

                    const resources = data.data?.translatableResourcesByIds?.edges ?? [];
                    for (const edge of resources) {
                      const mediaId = edge.node.resourceId;
                      const translations = edge.node.translations ?? [];
                      const altTranslation = translations.find((t: { key: string; value?: string }) => t.key === "alt");
                      if (altTranslation?.value) {
                        const dbId = mediaIdToDbId.get(mediaId);
                        if (dbId) {
                          altTranslations.push({
                            imageId: dbId,
                            locale: locale.locale,
                            altText: altTranslation.value,
                            marketId,
                          });
                        }
                      }
                    }
                  } catch (batchErr: unknown) {
                    if (batchErr instanceof DOMException && batchErr.name === "AbortError") throw batchErr;
                    logger.warn(`[ProductSync] Failed to fetch alt-text batch for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, batchErr instanceof Error ? batchErr.message : String(batchErr));
                    failedAltLayers.add(marketId);
                  }
                }
              }
            }

            // Replace each CLEANLY fetched layer wholesale. writeProduct
            // preserved the pre-sync alt rows across the image recreate, so a
            // plain skipDuplicates insert would keep stale values; deleting
            // only the succeeded layers keeps failed/un-fetched layers intact.
            // Delete + recreate run in ONE transaction: if the insert fails
            // (e.g. an image id vanished under a concurrent single-product
            // sync → FK error), the delete rolls back and the old rows survive
            // instead of leaving the succeeded layers empty.
            const succeededAltLayers = [...attemptedAltLayers].filter((l) => !failedAltLayers.has(l));
            const dbImageIds = [...mediaIdToDbId.values()];
            const freshAltRows = altTranslations.filter((t) => !failedAltLayers.has(t.marketId));

            if ((succeededAltLayers.length > 0 && dbImageIds.length > 0) || freshAltRows.length > 0) {
              if (freshAltRows.length > 0) {
                onProgress?.({ overallPercent: 97, message: `Saving ${freshAltRows.length} image alt-text translations...` });
              }
              try {
                await db.$transaction(async (tx) => {
                  if (succeededAltLayers.length > 0 && dbImageIds.length > 0) {
                    await tx.productImageAltTranslation.deleteMany({
                      where: { imageId: { in: dbImageIds }, marketId: { in: succeededAltLayers } },
                    });
                  }
                  if (freshAltRows.length > 0) {
                    await tx.productImageAltTranslation.createMany({
                      data: freshAltRows.map(t => ({
                        imageId: t.imageId,
                        locale: t.locale,
                        altText: t.altText,
                        marketId: t.marketId,
                      })),
                      skipDuplicates: true,
                    });
                  }
                });
                logger.debug(`[ProductSync] Saved ${freshAltRows.length} image alt-text translations`);
              } catch (altWriteErr: unknown) {
                if (altWriteErr instanceof DOMException && altWriteErr.name === "AbortError") throw altWriteErr;
                // Rolled back — old rows intact; next sync/reload refreshes them.
                logger.warn(`[ProductSync] Alt-text translation write failed (rolled back):`, altWriteErr instanceof Error ? altWriteErr.message : String(altWriteErr));
              }
            }
          }
        }
      } catch (translationErr: unknown) {
        if (translationErr instanceof DOMException && translationErr.name === "AbortError") throw translationErr;
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

      // R4-DI5: if this product was deleted while we were fetching it from
      // Shopify, don't continue the (expensive) translation fetch + write —
      // it would just resurrect a deleted product. saveToDatabase re-checks
      // too, but bailing here also saves the work.
      if (isProductRecentlyDeleted(productId)) {
        logger.warn(`[ProductSync] Product deleted during sync — aborting: ${productId}`);
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

      // 2. Fetch all available locales + markets (market-aware read-back)
      const locales = await fetchShopLocales(this.admin.graphql.bind(this.admin));
      const markets = await this.getMarkets();
      logger.debug(`[ProductSync] Found ${locales.length} locales, ${markets.length} market(s)`);

      // 3. Fetch translations for all non-primary locales (global + market layers)
      const foreignLocales = locales.filter((l) => !l.primary);
      const translationResult = await this.fetchAllTranslations(
        productId,
        foreignLocales,
        productData, // Pass product data for fallback values
        markets
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
        // Use a percentage-based threshold: abort if ≥50% of locales failed.
        // Absolute counts (e.g. >= 2) are misleading: 2/3 (67%) and 2/10 (20%) are very different.
        const failureRate = translationResult.errorCount / publishedLocales.length;
        if (publishedLocales.length >= 2 && failureRate >= 0.5) {
          logger.error(`[ProductSync] 🔴 ABORTING SYNC: ${translationResult.errorCount}/${publishedLocales.length} locales failed (${Math.round(failureRate * 100)}%) - refusing to delete existing translations`);
          throw new Error(`Translation fetch failed for ${translationResult.errorCount}/${publishedLocales.length} locales - aborting to prevent data loss`);
        } else if (translationResult.hadErrors) {
          logger.warn(`[ProductSync] ⚠️ Some locales failed (${translationResult.errorCount}), but continuing with partial data`);
        } else {
          logger.warn(`[ProductSync] ⚠️ Product might genuinely have no translations, continuing with sync`);
        }
      }

      logger.debug(`[ProductSync] Fetched ${allTranslations.length} translations from ${foreignLocales.length} foreign locales (errors: ${translationResult.errorCount})`);

      // 4. Fetch image alt-text translations (API 2025-10+)
      const altFailedMarketIds = new Set<string>();
      const imageAltTranslations = await this.fetchImageAltTextTranslations(
        productData,
        locales.filter((l) => !l.primary && l.published),
        markets,
        altFailedMarketIds
      );
      logger.debug(`[ProductSync] Fetched ${imageAltTranslations.length} image alt-text translations`);

      // 4b. Fetch sub-resource translations (options, option values, metafields)
      const subResFailedMarketIds = new Set<string>();
      const subResourceTranslations = await this.fetchSubResourceTranslations(
        productData,
        locales.filter((l) => !l.primary && l.published),
        markets,
        subResFailedMarketIds
      );
      logger.debug(`[ProductSync] Fetched ${subResourceTranslations.length} sub-resource translations`);

      // 5. Save to database
      if (forceSync) {
        logger.info(`[ProductSync] [RELOAD] title="${productData.title || '(empty)'}", descLen=${(productData.descriptionHtml || '').length}, translations=${allTranslations.length}`);
      }
      await this.saveToDatabase(productData, allTranslations, imageAltTranslations, subResourceTranslations, forceSync, markets, {
        productFields: translationResult.failedMarketIds,
        imageAlt: altFailedMarketIds,
        subResources: subResFailedMarketIds,
      });

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
    locales: ShopLocale[],
    markets: MarketInfo[] = [],
    /** OUT: markets whose fetch errored — their DB rows must not be replaced. */
    failedMarketIds?: Set<string>
  ): Promise<Array<{ mediaId: string; locale: string; altText: string; marketId: string }>> {
    const altTranslations: Array<{ mediaId: string; locale: string; altText: string; marketId: string }> = [];

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

    // 1 API call per (locale, layer) — global layer plus markets serving the locale
    for (const locale of locales) {
      for (const marketId of marketLayersForLocale(markets, locale.locale)) {
        try {
          const response = await this.admin.graphql(
            `#graphql
              query getMediaImageTranslationsBulk($resourceIds: [ID!]!, $locale: String!, $marketId: ID) {
                translatableResourcesByIds(first: 250, resourceIds: $resourceIds) {
                  edges {
                    node {
                      resourceId
                      translations(locale: $locale, marketId: $marketId) {
                        key
                        value
                      }
                    }
                  }
                }
              }`,
            { variables: { resourceIds: mediaIds, locale: locale.locale, marketId: marketId || null } }
          );

          const data = await response.json();

          if (data.errors) {
            logger.warn(`[ProductSync] GraphQL error for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, data.errors[0]?.message);
            if (marketId) failedMarketIds?.add(marketId);
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
                marketId,
              });
              foundCount++;
            }
          }

          if (foundCount > 0) {
            logger.debug(`[ProductSync] Found ${foundCount} alt-text translations for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}`);
          }
        } catch (error) {
          logger.warn(`[ProductSync] Failed to fetch bulk alt-text for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, error);
          if (marketId) failedMarketIds?.add(marketId);
        }
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
    locales: ShopLocale[],
    markets: MarketInfo[] = [],
    /** OUT: markets whose fetch errored — their DB rows must not be replaced. */
    failedMarketIds?: Set<string>
  ): Promise<Array<{ resourceId: string; resourceType: string; key: string; value: string; locale: string; marketId: string }>> {
    const results: Array<{ resourceId: string; resourceType: string; key: string; value: string; locale: string; marketId: string }> = [];

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

    // 1 API call per (locale, layer) — global layer plus markets serving the locale
    for (const locale of locales) {
      for (const marketId of marketLayersForLocale(markets, locale.locale)) {
        try {
          const response = await this.admin.graphql(
            `#graphql
              query getSubResourceTranslationsBulk($resourceIds: [ID!]!, $locale: String!, $marketId: ID) {
                translatableResourcesByIds(first: 250, resourceIds: $resourceIds) {
                  edges {
                    node {
                      resourceId
                      translations(locale: $locale, marketId: $marketId) {
                        key
                        value
                      }
                    }
                  }
                }
              }`,
            { variables: { resourceIds: allIds, locale: locale.locale, marketId: marketId || null } }
          );

          const data = await response.json();

          if (data.errors) {
            logger.warn(`[ProductSync] GraphQL error fetching sub-resource translations for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, data.errors[0]?.message);
            if (marketId) failedMarketIds?.add(marketId);
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
                  marketId,
                });
                foundCount++;
              }
            }
          }

          if (foundCount > 0) {
            logger.debug(`[ProductSync] Found ${foundCount} sub-resource translations for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}`);
          }
        } catch (error) {
          logger.warn(`[ProductSync] Failed to fetch sub-resource translations for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, error);
          if (marketId) failedMarketIds?.add(marketId);
        }
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
            variants(first: 100) {
              pageInfo {
                hasNextPage
              }
              nodes {
                id
                title
                sku
                price
                compareAtPrice
                position
                barcode
                image {
                  url
                }
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
  private async fetchAllTranslations(productId: string, locales: ShopLocale[], productData: ShopifyProductData, markets: MarketInfo[] = []): Promise<{
    translations: ResolvedTranslation[];
    hadErrors: boolean;
    errorCount: number;
    /** Markets whose fetch failed for at least one locale — their DB rows must not be wiped. */
    failedMarketIds: Set<string>;
  }> {
    const allTranslations: ResolvedTranslation[] = [];
    const digestMap = new Map<string, string>();
    // errors[] drives the abort/data-loss heuristic in syncProduct and counts
    // GLOBAL-layer failures only (as before markets existed); market-layer
    // failures are tracked per market so saveToDatabase can exclude that
    // market's rows from the delete+recreate instead of wiping them.
    const errors: string[] = [];
    const failedMarketIds = new Set<string>();
    const skipped: string[] = [];

    logger.debug(`[ProductSync] Starting translation fetch for ${locales.length} locales, ${markets.length} market(s)`);

    for (const locale of locales) {
      if (!locale.published) {
        logger.debug(`[ProductSync] Skipping unpublished locale: ${locale.locale}`);
        skipped.push(locale.locale);
        continue;
      }

      for (const marketId of marketLayersForLocale(markets, locale.locale)) {
        logger.debug(`[ProductSync] Fetching translations for locale: ${locale.locale}${marketId ? ` (market ${marketId})` : ''}`);

        try {
          const response = await this.admin.graphql(
            `#graphql
              query getTranslations($resourceId: ID!, $locale: String!, $marketId: ID) {
                translatableResource(resourceId: $resourceId) {
                  translatableContent {
                    key
                    value
                    digest
                    locale
                  }
                  translations(locale: $locale, marketId: $marketId) {
                    key
                    value
                    locale
                  }
                }
              }`,
            { variables: { resourceId: productId, locale: locale.locale, marketId: marketId || null } }
          );

          const data = await response.json();

          // Check for GraphQL errors for this locale
          if (data.errors && data.errors.length > 0) {
            logger.warn(`[ProductSync] GraphQL errors fetching translations for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, {
              errors: data.errors,
              productId,
              locale: locale.locale,
            });
            if (marketId) failedMarketIds.add(marketId);
            else errors.push(`${locale.locale}: ${(data.errors as GraphQLError[])[0].message}`);
            // Continue with other locales instead of failing completely
            continue;
          }

          const resource = data.data?.translatableResource;

          if (!resource) {
            logger.warn(`[ProductSync] No translatable resource found for ${locale.locale}${marketId ? ` (market ${marketId})` : ''}`);
            if (marketId) failedMarketIds.add(marketId);
            else errors.push(`${locale.locale}: No translatable resource`);
            continue;
          }

          // Build digest map from translatableContent (for reference only)
          if (resource.translatableContent) {
            for (const content of resource.translatableContent) {
              // Store digest for future updates - but DO NOT store as translation
              digestMap.set(content.key, content.digest);
            }
          }

          // ONLY save actual translations from Shopify
          // DO NOT save translatableContent values - those are the source language text
          if (resource.translations && resource.translations.length > 0) {
            logger.debug(`[ProductSync] Actual translations for ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`,
              resource.translations.map((t: ShopifyTranslation) => t.key).join(', '));

            for (const translation of resource.translations) {
              allTranslations.push({
                key: translation.key,
                value: translation.value,
                locale: translation.locale,
                digest: digestMap.get(translation.key),
                marketId,
              });
            }

            logger.debug(`[ProductSync] Saved ${resource.translations.length} actual translations for ${locale.locale}${marketId ? ` (market ${marketId})` : ''}`);
          } else {
            logger.debug(`[ProductSync] No translations found for ${locale.locale}${marketId ? ` (market ${marketId})` : ''} - nothing to save`);
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          // Log error but continue with other locales (graceful degradation)
          logger.error(`[ProductSync] Error fetching translations for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, {
            error: message,
            productId,
            locale: locale.locale,
          });
          if (marketId) failedMarketIds.add(marketId);
          else errors.push(`${locale.locale}: ${message}`);
          // Continue to next locale
        }
      }
    }

    // Summary logging
    const successfulLocales = locales.length - skipped.length - errors.length;
    logger.debug(`[ProductSync] Translation fetch complete:`, {
      totalLocales: locales.length,
      successful: successfulLocales,
      skipped: skipped.length,
      errors: errors.length,
      failedMarkets: failedMarketIds.size,
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
      failedMarketIds,
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
    imageAltTranslations: Array<{ mediaId: string; locale: string; altText: string; marketId?: string }> = [],
    subResourceTranslations: Array<{ resourceId: string; resourceType: string; key: string; value: string; locale: string; marketId?: string }> = [],
    forceSync = false,
    markets: MarketInfo[] = [],
    /** Per fetch pipeline: markets whose fetch errored — their rows survive untouched. */
    failedMarkets: { productFields?: Set<string>; imageAlt?: Set<string>; subResources?: Set<string> } = {}
  ) {
    const { db } = await import("../db.server");

    const productFieldsFailed = failedMarkets.productFields ?? new Set<string>();
    const imageAltFailed = failedMarkets.imageAlt ?? new Set<string>();
    const subResourcesFailed = failedMarkets.subResources ?? new Set<string>();

    // Layers this sync run actually (successfully) fetched: global ("") plus
    // every market whose fetch did not fail. Delete/recreate is SCOPED to
    // these layers so market rows survive a global-only or partially-failed
    // run (e.g. loadMarkets degraded to [] on a missing read_markets scope).
    // Tracked per fetch pipeline — product fields, image alt-text, and
    // sub-resources fail independently.
    const fetchedLayers = fetchedMarketLayers(markets.filter((m) => !productFieldsFailed.has(m.id)));
    const altFetchedLayers = fetchedMarketLayers(markets.filter((m) => !imageAltFailed.has(m.id)));
    const subResFetchedLayers = fetchedMarketLayers(markets.filter((m) => !subResourcesFailed.has(m.id)));

    // R4-DI5: do not resurrect a product that was deleted while this sync was
    // in flight (we fetched it from Shopify before a products/delete webhook
    // committed deleteProduct()). Re-checked again inside the transaction to
    // close the check→commit window.
    if (isProductRecentlyDeleted(productData.id)) {
      logger.warn(`[ProductSync] Skipping save — product was deleted during this sync: ${productData.id}`);
      return;
    }

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

    // Alt-text TRANSLATION rows of layers we did NOT cleanly fetch this run
    // (failed markets, or all markets when loadMarkets degraded to []) would
    // be destroyed by the ProductImage delete-then-recreate below via the FK
    // cascade — no marketId scoping can protect them there. Snapshot them and
    // re-attach to the recreated images (matched by mediaId).
    const preservedAltRows = await db.productImageAltTranslation.findMany({
      where: { image: { productId: productData.id }, marketId: { notIn: altFetchedLayers } },
      select: { locale: true, altText: true, marketId: true, image: { select: { mediaId: true } } },
    });

    // Prepare data outside transaction. Rows of layers OUTSIDE fetchedLayers
    // (i.e. a market that partially failed) are dropped: their old DB rows are
    // preserved untouched, and inserting a partial fresh set would collide
    // with the un-deleted rows on the composite unique key.
    const validTranslations = translations.filter(t =>
      t.value != null && t.value !== undefined && fetchedLayers.includes(t.marketId || "")
    );
    const skippedCount = translations.length - validTranslations.length;
    if (skippedCount > 0) {
      logger.debug(`[ProductSync] Skipping ${skippedCount} translations with null/undefined values or failed market layers`);
    }

    const mediaImages: ShopifyMediaImage[] = productData.media?.edges
      ?.filter((edge) => edge.node.id && edge.node.image?.url)
      .map((edge) => edge.node) || [];

    // Use transaction to ensure all-or-nothing data consistency. Wrapped in
    // the race-retry: this is the webhook-driven sync that wipes+recreates
    // ProductImage rows and can collide on (productId, mediaId) with a
    // parallel alt-text apply now that a unique constraint exists.
    await withDbRaceRetry(() => db.$transaction(async (tx) => {
      // R4-DI5: re-check inside the transaction. deleteProduct() may have
      // committed (and tombstoned) between the top-of-method guard and here;
      // returning early commits an empty transaction so nothing is written
      // and the deleted product stays deleted.
      if (isProductRecentlyDeleted(productData.id)) {
        logger.warn(`[ProductSync] Aborting write — product deleted mid-transaction: ${productData.id}`);
        return;
      }
      // hasMoreVariants (Plan §5.1): only touched when the variants block was
      // actually delivered — a partial response must not flip the flag.
      const hasMoreVariants = productData.variants
        ? productData.variants.pageInfo?.hasNextPage ?? false
        : undefined;
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
          hasMoreVariants: hasMoreVariants ?? false,
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
          ...(hasMoreVariants !== undefined ? { hasMoreVariants } : {}),
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
        // R3-H4: products/update fires on every edit (incl. our own alt-text
        // writes) and previously always wiped + recreated EVERY translation
        // row for the product, churning rows/indexes even when nothing
        // changed. Shopify's translatableContentDigest lets us detect "no
        // change": skip the rewrite ONLY when every incoming translation has
        // a digest AND the stored (locale,key)->digest map is byte-identical
        // (same membership + same digests). Any uncertainty (missing digest,
        // count/membership mismatch) falls through to the original
        // delete+recreate, so correctness is never traded for the speed-up.
        const existingTranslations = await tx.contentTranslation.findMany({
          // marketId-scoped: only rows of successfully fetched layers take part
          // in the digest comparison and the delete+recreate below.
          where: { shop: this.shop, resourceId: productData.id, resourceType: "Product", marketId: { in: fetchedLayers } },
          select: { locale: true, key: true, digest: true, marketId: true },
        });
        const tkey = (locale: string, key: string, marketId: string) => `${marketId} ${locale} ${key}`;
        const everyIncomingHasDigest = validTranslations.length > 0 && validTranslations.every(t => !!t.digest);
        const everyStoredHasDigest = existingTranslations.length > 0 && existingTranslations.every(e => !!e.digest);
        const existingDigestByKey = new Map(existingTranslations.map(e => [tkey(e.locale, e.key, e.marketId), e.digest]));
        const translationsUnchanged =
          everyIncomingHasDigest &&
          everyStoredHasDigest &&
          existingTranslations.length === validTranslations.length &&
          validTranslations.every(t => existingDigestByKey.get(tkey(t.locale, t.key, t.marketId || "")) === t.digest);

        if (translationsUnchanged) {
          logger.info(`[ProductSync] [RELOAD] Skipping translation rewrite — all ${validTranslations.length} digests unchanged`, { productId: productData.id });
        } else {
        // Delete old translations and recreate from Shopify — SCOPED to the
        // layers this run fetched, so un-fetched market rows survive.
        const deletedTranslations = await tx.contentTranslation.deleteMany({
          where: { shop: this.shop, resourceId: productData.id, resourceType: "Product", marketId: { in: fetchedLayers } }
        });
        logger.info(`[ProductSync] [RELOAD] Deleted ${deletedTranslations.count} old translations, will save ${validTranslations.length} fresh ones`);

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
              shop: this.shop,
              resourceId: productData.id,
              resourceType: "Product",
              key: t.key,
              value: t.value,
              locale: t.locale,
              digest: t.digest || null,
              marketId: t.marketId || "",
            })),
          });
          logger.debug(`[ProductSync] ✓ Successfully saved ${validTranslations.length} translations to database`);
        } else {
          logger.debug(`[ProductSync] No translations to save`);
        }
        } // end: translations changed (digest mismatch / uncertain)

        // Save sub-resource translations (options, option values, metafields).
        // Sub-resource rows are stored with digest=null, so they cannot be
        // digest-skipped and are always reconciled here as before.
        if (subResourceTranslations.length > 0) {
          // Rows of markets whose sub-resource fetch failed are dropped: their
          // old rows stay untouched (excluded from the delete scope below) and
          // a partial insert would collide with them on the unique key.
          const freshSubResourceRows = subResourceTranslations.filter(
            t => subResFetchedLayers.includes(t.marketId || "")
          );
          const subResourceIds = [...new Set(freshSubResourceRows.map(t => t.resourceId))];

          if (subResourceIds.length > 0) {
            const deletedSubTrans = await tx.contentTranslation.deleteMany({
              where: {
                shop: this.shop,
                resourceId: { in: subResourceIds },
                resourceType: { in: ["ProductOption", "ProductOptionValue", "Metafield"] },
                marketId: { in: subResFetchedLayers },
              },
            });
            logger.debug(`[ProductSync] Deleted ${deletedSubTrans.count} old sub-resource translations`);

            await tx.contentTranslation.createMany({
              data: freshSubResourceRows.map(t => ({
                shop: this.shop,
                resourceId: t.resourceId,
                resourceType: t.resourceType,
                key: t.key,
                value: t.value,
                locale: t.locale,
                digest: null,
                marketId: t.marketId || "",
              })),
            });
            logger.debug(`[ProductSync] Saved ${freshSubResourceRows.length} sub-resource translations`);
          }
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
            // Rows of failed market layers are dropped — the preserved
            // snapshot below carries those layers over instead.
            if (!altFetchedLayers.includes(altTrans.marketId || "")) continue;
            const dbImageId = mediaIdToDbId.get(altTrans.mediaId);
            if (dbImageId) {
              await tx.productImageAltTranslation.create({
                data: {
                  imageId: dbImageId,
                  locale: altTrans.locale,
                  altText: altTrans.altText,
                  marketId: altTrans.marketId || "",
                },
              });
              savedAltTranslations++;
            }
          }

          if (savedAltTranslations > 0) {
            logger.debug(`[ProductSync] ✓ Saved ${savedAltTranslations} image alt-text translations`);
          }
        }

        // Restore the snapshot of un-fetched layers (see preservedAltRows
        // above). skipDuplicates: fresh rows above always win — preserved and
        // fresh layers are disjoint, so this only fills the protected layers.
        if (preservedAltRows.length > 0) {
          const mediaIdToNewDbId = new Map<string, string>();
          createdImages.forEach((img) => {
            if (img.mediaId) mediaIdToNewDbId.set(img.mediaId, img.id);
          });
          const restoreData = preservedAltRows.flatMap((row) => {
            const newImageId = row.image.mediaId ? mediaIdToNewDbId.get(row.image.mediaId) : undefined;
            return newImageId
              ? [{ imageId: newImageId, locale: row.locale, altText: row.altText, marketId: row.marketId }]
              : [];
          });
          if (restoreData.length > 0) {
            await tx.productImageAltTranslation.createMany({ data: restoreData, skipDuplicates: true });
            logger.debug(`[ProductSync] ✓ Restored ${restoreData.length} preserved market alt-text translations`);
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

      // Variants (Plan §5.1): targeted upsert + targeted delete of vanished
      // ids — NEVER deleteMany+createMany, galleryJson/imageKey come from the
      // image manager and must survive (§10.3). hasNextPage = the 100-variant
      // window is truncated — deletion is skipped inside (review Finding 4).
      await syncProductVariantRows(
        tx,
        productData.id,
        productData.variants?.nodes ?? null,
        productData.variants?.pageInfo?.hasNextPage ?? false,
      );
    }));

    logger.debug(`[ProductSync] ✓ Transaction completed successfully for product ${productData.id}`);
  }

  /**
   * Delete a product from the database
   */
  async deleteProduct(productId: string): Promise<void> {
    logger.debug(`[ProductSync] Deleting product: ${productId}`);

    const { db } = await import("../db.server");

    // Atomically remove the product AND its polymorphic ContentTranslation
    // rows. ContentTranslation has no FK/ON DELETE CASCADE (resourceId is
    // polymorphic), so without this the translations orphan forever on every
    // product delete (Shopify products/delete webhook, sync reconcile).
    // deleteMany (not delete) keeps this idempotent — a missing product is a
    // successful no-op and still clears any pre-existing orphaned rows.
    await db.$transaction([
      db.contentTranslation.deleteMany({
        where: { shop: this.shop, resourceId: productId },
      }),
      db.product.deleteMany({
        where: { shop: this.shop, id: productId },
      }),
    ]);

    // R4-DI5: tombstone the id so an in-flight sync that already fetched this
    // product from Shopify cannot upsert it back AFTER this delete commits
    // (Shopify never redelivers products/delete, so a resurrected row would
    // never self-heal). Marked AFTER a successful delete so a failed delete
    // doesn't wrongly suppress a legitimate sync.
    markProductDeleted(productId);

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
