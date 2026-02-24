import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db, upsertProductMetafields } from "../db.server";
import { getPlanLimits, type Plan } from "../utils/planUtils";
import { ContentSyncService } from "../services/content-sync.service";
import { BackgroundSyncService } from "../services/background-sync.service";
import { logger } from "~/utils/logger.server";
import { getTranslation, DEFAULT_LOCALE, type Locale } from "~/i18n";

/**
 * API Route: Streaming Sync All Content
 *
 * Uses Server-Sent Events (SSE) to stream progress updates while syncing.
 * This provides real-time feedback to the user about what's being synced.
 *
 * Usage: POST /api/sync-all-stream?force=true
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // Authenticate first - let redirects pass through
  let admin: any;
  let shop: string;

  try {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
    shop = auth.session.shop;
  } catch (error) {
    // If this is a redirect (e.g., to /auth/login), re-throw it
    if (error instanceof Response) {
      throw error;
    }
    // For other errors, return an error response
    logger.error("[SYNC-STREAM] Authentication failed", { error: error instanceof Error ? error.message : String(error) });
    return new Response(JSON.stringify({ error: "Authentication failed" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "true";

  // Capture the request abort signal to stop work on client disconnect
  const signal = request.signal;

  // Create a streaming response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // Track whether the stream has been closed to avoid enqueue-after-close errors
      let streamClosed = false;

      const onAbort = () => {
        streamClosed = true;
        logger.info("[SYNC-STREAM] Client disconnected, aborting sync", { shop });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const sendEvent = (data: {
        type: 'progress' | 'complete' | 'error';
        phase: string;
        current?: number;
        total?: number;
        message: string;
        stats?: any;
        detailCurrent?: number;
        detailTotal?: number;
        detailMessage?: string;
      }) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          streamClosed = true;
        }
      };

      const checkAborted = () => {
        if (signal.aborted || streamClosed) {
          throw new DOMException("Client disconnected", "AbortError");
        }
      };

      try {
        // Get plan limits
        const settings = await db.aISettings.findUnique({
          where: { shop },
        });
        const plan = (settings?.subscriptionPlan || "free") as Plan;
        const planLimits = getPlanLimits(plan);
        const appLocale = (settings?.appLanguage || DEFAULT_LOCALE) as Locale;
        const t = getTranslation(appLocale);

        /** Map a sync phase to its translated outage-protection message */
        const syncEmptyResponseKey: Record<string, keyof typeof t.errors> = {
          collections: 'syncEmptyResponseCollections',
          articles: 'syncEmptyResponseArticles',
          pages: 'syncEmptyResponsePages',
          policies: 'syncEmptyResponsePolicies',
          themes: 'syncEmptyResponseThemes',
        };

        function getSyncErrorMessage(phase: string, err: { message?: string }): string {
          const msg = err.message || '';
          if (msg.includes('aborting to prevent data loss')) {
            return t.errors[syncEmptyResponseKey[phase]] || t.errors.syncApiError;
          }
          if (msg.includes('API error')) {
            return t.errors.syncApiError;
          }
          return t.errors.syncFailed
            .replace('{phase}', phase.charAt(0).toUpperCase() + phase.slice(1))
            .replace('{details}', msg);
        }

        const stats = {
          products: 0,
          collections: 0,
          articles: 0,
          pages: 0,
          policies: 0,
          themes: 0,
        };

        // ==========================================
        // PHASE 1: Sync Products
        // ==========================================
        checkAborted();
        sendEvent({
          type: 'progress',
          phase: 'products',
          message: 'Checking existing products...',
          current: 0,
          total: 100
        });

        // Check if products exist
        if (!force) {
          const existingCount = await db.product.count({ where: { shop } });
          if (existingCount > 0) {
            sendEvent({
              type: 'progress',
              phase: 'products',
              message: `Found ${existingCount} existing products, skipping...`,
              current: 100,
              total: 100
            });
            stats.products = 0;
          } else {
            stats.products = await syncProductsWithProgress(admin, shop, planLimits, sendEvent, signal);
          }
        } else {
          // Force re-sync: delete existing products first
          sendEvent({
            type: 'progress',
            phase: 'products',
            message: 'Deleting existing products for re-sync...',
            current: 0,
            total: 100
          });

          const existingProducts = await db.product.findMany({
            where: { shop },
            select: { id: true },
          });

          if (existingProducts.length > 0) {
            const productIds = existingProducts.map(p => p.id);
            await db.$transaction([
              db.contentTranslation.deleteMany({
                where: { resourceId: { in: productIds }, resourceType: "Product" },
              }),
              db.productImage.deleteMany({
                where: { productId: { in: productIds } },
              }),
              db.productOption.deleteMany({
                where: { productId: { in: productIds } },
              }),
              db.productMetafield.deleteMany({
                where: { productId: { in: productIds } },
              }),
              db.product.deleteMany({
                where: { shop },
              }),
            ]);
          }

          checkAborted();
          stats.products = await syncProductsWithProgress(admin, shop, planLimits, sendEvent, signal);
        }

        // ==========================================
        // PHASE 2: Sync Collections
        // ==========================================
        checkAborted();
        sendEvent({
          type: 'progress',
          phase: 'collections',
          message: 'Syncing collections...',
          current: 0,
          total: 100
        });

        try {
          const syncService = new ContentSyncService(admin, shop);
          stats.collections = await syncService.syncAllCollections(planLimits.maxCollections, (current, total, message) => {
            checkAborted();
            sendEvent({
              type: 'progress',
              phase: 'collections',
              message: 'Syncing collections...',
              current: Math.round((current / total) * 100),
              total: 100,
              detailCurrent: current,
              detailTotal: total,
              detailMessage: message
            });
          });
          sendEvent({
            type: 'progress',
            phase: 'collections',
            message: `Synced ${stats.collections} collections`,
            current: 100,
            total: 100
          });
        } catch (err: any) {
          if (err.name === "AbortError") throw err;
          sendEvent({
            type: 'progress',
            phase: 'collections',
            message: getSyncErrorMessage('collections', err),
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // PHASE 3: Sync Articles
        // ==========================================
        checkAborted();
        sendEvent({
          type: 'progress',
          phase: 'articles',
          message: 'Syncing articles...',
          current: 0,
          total: 100
        });

        try {
          const syncService = new ContentSyncService(admin, shop);
          stats.articles = await syncService.syncAllArticles(planLimits.maxArticles, (current, total, message) => {
            checkAborted();
            sendEvent({
              type: 'progress',
              phase: 'articles',
              message: 'Syncing articles...',
              current: Math.round((current / total) * 100),
              total: 100,
              detailCurrent: current,
              detailTotal: total,
              detailMessage: message
            });
          });
          sendEvent({
            type: 'progress',
            phase: 'articles',
            message: `Synced ${stats.articles} articles`,
            current: 100,
            total: 100
          });
        } catch (err: any) {
          if (err.name === "AbortError") throw err;
          sendEvent({
            type: 'progress',
            phase: 'articles',
            message: getSyncErrorMessage('articles', err),
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // PHASE 4: Sync Pages
        // ==========================================
        checkAborted();
        sendEvent({
          type: 'progress',
          phase: 'pages',
          message: 'Syncing pages...',
          current: 0,
          total: 100
        });

        try {
          const bgSyncService = new BackgroundSyncService(admin, shop);
          stats.pages = await bgSyncService.syncAllPages(planLimits.maxPages, (current, total, message) => {
            checkAborted();
            sendEvent({
              type: 'progress',
              phase: 'pages',
              message: 'Syncing pages...',
              current: Math.round((current / total) * 100),
              total: 100,
              detailCurrent: current,
              detailTotal: total,
              detailMessage: message
            });
          });
          sendEvent({
            type: 'progress',
            phase: 'pages',
            message: `Synced ${stats.pages} pages`,
            current: 100,
            total: 100
          });
        } catch (err: any) {
          if (err.name === "AbortError") throw err;
          sendEvent({
            type: 'progress',
            phase: 'pages',
            message: getSyncErrorMessage('pages', err),
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // PHASE 5: Sync Policies
        // ==========================================
        checkAborted();
        sendEvent({
          type: 'progress',
          phase: 'policies',
          message: 'Syncing policies...',
          current: 0,
          total: 100
        });

        try {
          const bgSyncService = new BackgroundSyncService(admin, shop);
          stats.policies = await bgSyncService.syncAllPolicies((current, total, message) => {
            checkAborted();
            sendEvent({
              type: 'progress',
              phase: 'policies',
              message: 'Syncing policies...',
              current: Math.round((current / total) * 100),
              total: 100,
              detailCurrent: current,
              detailTotal: total,
              detailMessage: message
            });
          });
          sendEvent({
            type: 'progress',
            phase: 'policies',
            message: `Synced ${stats.policies} policies`,
            current: 100,
            total: 100
          });
        } catch (err: any) {
          if (err.name === "AbortError") throw err;
          sendEvent({
            type: 'progress',
            phase: 'policies',
            message: getSyncErrorMessage('policies', err),
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // PHASE 6: Sync Themes
        // ==========================================
        checkAborted();
        sendEvent({
          type: 'progress',
          phase: 'themes',
          message: 'Syncing themes...',
          current: 0,
          total: 100
        });

        try {
          const bgSyncService = new BackgroundSyncService(admin, shop);
          stats.themes = await bgSyncService.syncAllThemes((current, total, message) => {
            checkAborted();
            sendEvent({
              type: 'progress',
              phase: 'themes',
              message: 'Syncing themes...',
              current,
              total: 100,
              detailCurrent: current,
              detailTotal: total,
              detailMessage: message
            });
          });
          sendEvent({
            type: 'progress',
            phase: 'themes',
            message: `Synced ${stats.themes} themes`,
            current: 100,
            total: 100
          });
        } catch (err: any) {
          if (err.name === "AbortError") throw err;
          sendEvent({
            type: 'progress',
            phase: 'themes',
            message: getSyncErrorMessage('themes', err),
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // COMPLETE
        // ==========================================
        sendEvent({
          type: 'complete',
          phase: 'done',
          message: 'Sync complete!',
          stats
        });

      } catch (error: any) {
        if (error.name === "AbortError") {
          logger.info("[SYNC-STREAM] Sync aborted due to client disconnection", { shop });
        } else {
          logger.error("[SYNC-STREAM] Sync failed", { error: error.message, shop });
          sendEvent({
            type: 'error',
            phase: 'error',
            message: "Sync failed"
          });
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        streamClosed = true;
        try {
          controller.close();
        } catch {
          // Controller may already be closed
        }
      }
    },
    cancel() {
      logger.info("[SYNC-STREAM] Stream cancelled by client", { shop });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
};

/**
 * Syncs products with progress updates
 */
async function syncProductsWithProgress(
  admin: any,
  shop: string,
  planLimits: any,
  sendEvent: (data: any) => void,
  signal: AbortSignal
): Promise<number> {
  const maxToFetch = planLimits.maxProducts === Infinity ? 10000 : planLimits.maxProducts;
  let allProducts: any[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  sendEvent({
    type: 'progress',
    phase: 'products',
    message: 'Fetching products from Shopify...',
    current: 0,
    total: 100
  });

  // Fetch all products
  while (hasNextPage && allProducts.length < maxToFetch) {
    if (signal.aborted) {
      throw new DOMException("Client disconnected", "AbortError");
    }
    const batchSize = Math.min(250, maxToFetch - allProducts.length);

    const response: Response = await admin.graphql(
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
                }
                metafields(first: 50) {
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

    sendEvent({
      type: 'progress',
      phase: 'products',
      message: `Fetched ${allProducts.length} products from Shopify...`,
      current: 20,
      total: 100
    });
  }

  if (allProducts.length === 0) {
    sendEvent({
      type: 'progress',
      phase: 'products',
      message: 'No products found',
      current: 100,
      total: 100
    });
    return 0;
  }

  // Save products to database
  let synced = 0;
  const total = allProducts.length;

  for (const product of allProducts) {
    if (signal.aborted) {
      logger.info(`[SYNC-STREAM] Aborting product save after ${synced}/${total} products`, { shop });
      throw new DOMException("Client disconnected", "AbortError");
    }
    try {
      await db.$transaction(async (tx) => {
        // Upsert product
        await tx.product.upsert({
          where: {
            shop_id: { shop, id: product.id },
          },
          create: {
            id: product.id,
            shop,
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
        if (planLimits.cacheEnabled.productImages) {
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

        // Save options
        if (product.options && product.options.length > 0) {
          await tx.productOption.deleteMany({ where: { productId: product.id } });
          await tx.productOption.createMany({
            data: product.options.map((opt: any) => ({
              id: opt.id,
              productId: product.id,
              name: opt.name,
              position: opt.position,
              values: JSON.stringify(opt.values),
            })),
          });
        }

        // Upsert metafields (idempotent — safe under concurrent execution)
        const metafields = product.metafields?.edges?.map((edge: any) => edge.node) || [];
        await upsertProductMetafields(tx, product.id, metafields);
      });

      synced++;

      // Send progress update every 10 products or at the end
      if (synced % 10 === 0 || synced === total) {
        const progress = Math.round(20 + (synced / total) * 50);
        sendEvent({
          type: 'progress',
          phase: 'products',
          message: `Saving products: ${synced}/${total}`,
          current: progress,
          total: 100
        });
      }
    } catch (err: any) {
      if (err.name === "AbortError") throw err;
      logger.error(`[SYNC-STREAM] Failed to save product ${product.id}`, { error: err.message });
    }
  }

  // ==========================================
  // Bulk-fetch translations for all products
  // ==========================================
  if (synced > 0) {
    try {
      if (signal.aborted) {
        throw new DOMException("Client disconnected", "AbortError");
      }

      sendEvent({
        type: 'progress',
        phase: 'products',
        message: `Fetching product translations...`,
        current: 70,
        total: 100,
        detailMessage: 'Loading locales...'
      });

      // Fetch shop locales
      const localesResponse: Response = await admin.graphql(
        `#graphql
          query getShopLocales {
            shopLocales { locale, name, primary, published }
          }`
      );
      const localesData: any = await localesResponse.json();
      const shopLocales: Array<{ locale: string; name?: string; primary: boolean; published: boolean }> =
        localesData.data?.shopLocales || [];
      const nonPrimaryLocales = shopLocales.filter((l) => !l.primary && l.published);

      if (nonPrimaryLocales.length > 0) {
        const productIds = allProducts.map((p: any) => p.id);
        const BATCH_SIZE = 100;
        const batches: string[][] = [];
        for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
          batches.push(productIds.slice(i, i + BATCH_SIZE));
        }

        let localeIndex = 0;
        for (const locale of nonPrimaryLocales) {
          localeIndex++;
          if (signal.aborted) {
            throw new DOMException("Client disconnected", "AbortError");
          }

          const localeProgress = Math.round(70 + (localeIndex / nonPrimaryLocales.length) * 25);
          sendEvent({
            type: 'progress',
            phase: 'products',
            message: `Fetching product translations...`,
            current: localeProgress,
            total: 100,
            detailMessage: `Fetching translations: ${locale.name || locale.locale} (${localeIndex}/${nonPrimaryLocales.length})`
          });

          const allTranslations: Array<{
            resourceId: string;
            key: string;
            value: string;
            locale: string;
            digest: string | null;
          }> = [];

          for (const batch of batches) {
            try {
              const response: Response = await admin.graphql(
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
                logger.warn(`[SYNC-STREAM] GraphQL error fetching translations for locale ${locale.locale}:`, data.errors[0]?.message);
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
            } catch (batchErr: any) {
              if (batchErr.name === "AbortError") throw batchErr;
              logger.warn(`[SYNC-STREAM] Failed to fetch translation batch for locale ${locale.locale}:`, batchErr.message);
            }
          }

          // Bulk save translations for this locale
          if (allTranslations.length > 0) {
            sendEvent({
              type: 'progress',
              phase: 'products',
              message: `Fetching product translations...`,
              current: localeProgress,
              total: 100,
              detailMessage: `Saving translations: ${locale.name || locale.locale} (${allTranslations.length})`
            });

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

            logger.debug(`[SYNC-STREAM] Saved ${allTranslations.length} product translations for locale ${locale.locale}`);
          }
        }

        // ==========================================
        // Bulk-fetch image alt-text translations
        // ==========================================
        const allMediaIds: string[] = [];
        for (const product of allProducts) {
          const mediaImages = product.media?.edges
            ?.filter((edge: any) => edge.node.id)
            .map((edge: any) => edge.node.id) || [];
          allMediaIds.push(...mediaImages);
        }

        if (allMediaIds.length > 0) {
          sendEvent({
            type: 'progress',
            phase: 'products',
            message: `Fetching product translations...`,
            current: 95,
            total: 100,
            detailMessage: `Fetching image alt-text translations...`
          });

          // Build mediaId → DB imageId mapping
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

          for (const locale of nonPrimaryLocales) {
            if (signal.aborted) {
              throw new DOMException("Client disconnected", "AbortError");
            }

            for (const batch of mediaBatches) {
              try {
                const response: Response = await admin.graphql(
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
                  logger.warn(`[SYNC-STREAM] GraphQL error fetching alt-text for locale ${locale.locale}:`, data.errors[0]?.message);
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
              } catch (batchErr: any) {
                if (batchErr.name === "AbortError") throw batchErr;
                logger.warn(`[SYNC-STREAM] Failed to fetch alt-text batch for locale ${locale.locale}:`, batchErr.message);
              }
            }
          }

          // Bulk save alt-text translations
          if (altTranslations.length > 0) {
            sendEvent({
              type: 'progress',
              phase: 'products',
              message: `Fetching product translations...`,
              current: 97,
              total: 100,
              detailMessage: `Saving ${altTranslations.length} image alt-text translations...`
            });

            await db.productImageAltTranslation.createMany({
              data: altTranslations.map(t => ({
                imageId: t.imageId,
                locale: t.locale,
                altText: t.altText,
              })),
              skipDuplicates: true,
            });

            logger.debug(`[SYNC-STREAM] Saved ${altTranslations.length} image alt-text translations`);
          }
        }
      }
    } catch (translationErr: any) {
      if (translationErr.name === "AbortError") throw translationErr;
      logger.error(`[SYNC-STREAM] Failed to fetch product translations:`, translationErr.message);
      // Non-fatal: products are synced, translations can be loaded on-demand
    }
  }

  sendEvent({
    type: 'progress',
    phase: 'products',
    message: `Synced ${synced} products`,
    current: 100,
    total: 100
  });

  return synced;
}
