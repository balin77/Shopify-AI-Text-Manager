import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { getPlanLimits, type Plan } from "../utils/planUtils";
import { ContentSyncService } from "../services/content-sync.service";
import { BackgroundSyncService } from "../services/background-sync.service";

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
    console.error("[SYNC-STREAM] Authentication failed:", error);
    return new Response(JSON.stringify({ error: "Authentication failed" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "true";

  // Create a streaming response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = (data: {
        type: 'progress' | 'complete' | 'error';
        phase: string;
        current?: number;
        total?: number;
        message: string;
        stats?: any;
      }) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Get plan limits
        const settings = await db.aISettings.findUnique({
          where: { shop },
        });
        const plan = (settings?.subscriptionPlan || "basic") as Plan;
        const planLimits = getPlanLimits(plan);

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
            stats.products = await syncProductsWithProgress(admin, shop, planLimits, sendEvent);
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

          stats.products = await syncProductsWithProgress(admin, shop, planLimits, sendEvent);
        }

        // ==========================================
        // PHASE 2: Sync Collections
        // ==========================================
        sendEvent({
          type: 'progress',
          phase: 'collections',
          message: 'Syncing collections...',
          current: 0,
          total: 100
        });

        try {
          const syncService = new ContentSyncService(admin, shop);
          stats.collections = await syncService.syncAllCollections(planLimits.maxCollections);
          sendEvent({
            type: 'progress',
            phase: 'collections',
            message: `Synced ${stats.collections} collections`,
            current: 100,
            total: 100
          });
        } catch (err: any) {
          sendEvent({
            type: 'progress',
            phase: 'collections',
            message: `Collections sync failed: ${err.message}`,
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // PHASE 3: Sync Articles
        // ==========================================
        sendEvent({
          type: 'progress',
          phase: 'articles',
          message: 'Syncing articles...',
          current: 0,
          total: 100
        });

        try {
          const syncService = new ContentSyncService(admin, shop);
          stats.articles = await syncService.syncAllArticles(planLimits.maxArticles);
          sendEvent({
            type: 'progress',
            phase: 'articles',
            message: `Synced ${stats.articles} articles`,
            current: 100,
            total: 100
          });
        } catch (err: any) {
          sendEvent({
            type: 'progress',
            phase: 'articles',
            message: `Articles sync failed: ${err.message}`,
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // PHASE 4: Sync Pages
        // ==========================================
        sendEvent({
          type: 'progress',
          phase: 'pages',
          message: 'Syncing pages...',
          current: 0,
          total: 100
        });

        try {
          const bgSyncService = new BackgroundSyncService(admin, shop);
          stats.pages = await bgSyncService.syncAllPages(planLimits.maxPages);
          sendEvent({
            type: 'progress',
            phase: 'pages',
            message: `Synced ${stats.pages} pages`,
            current: 100,
            total: 100
          });
        } catch (err: any) {
          sendEvent({
            type: 'progress',
            phase: 'pages',
            message: `Pages sync failed: ${err.message}`,
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // PHASE 5: Sync Policies
        // ==========================================
        sendEvent({
          type: 'progress',
          phase: 'policies',
          message: 'Syncing policies...',
          current: 0,
          total: 100
        });

        try {
          const bgSyncService = new BackgroundSyncService(admin, shop);
          stats.policies = await bgSyncService.syncAllPolicies();
          sendEvent({
            type: 'progress',
            phase: 'policies',
            message: `Synced ${stats.policies} policies`,
            current: 100,
            total: 100
          });
        } catch (err: any) {
          sendEvent({
            type: 'progress',
            phase: 'policies',
            message: `Policies sync failed: ${err.message}`,
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // PHASE 6: Sync Themes
        // ==========================================
        sendEvent({
          type: 'progress',
          phase: 'themes',
          message: 'Syncing themes...',
          current: 0,
          total: 100
        });

        try {
          const bgSyncService = new BackgroundSyncService(admin, shop);
          stats.themes = await bgSyncService.syncAllThemes();
          sendEvent({
            type: 'progress',
            phase: 'themes',
            message: `Synced ${stats.themes} themes`,
            current: 100,
            total: 100
          });
        } catch (err: any) {
          sendEvent({
            type: 'progress',
            phase: 'themes',
            message: `Themes sync failed: ${err.message}`,
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
        sendEvent({
          type: 'error',
          phase: 'error',
          message: error.message
        });
      } finally {
        controller.close();
      }
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
  sendEvent: (data: any) => void
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

        // Save metafields
        const metafields = product.metafields?.edges?.map((edge: any) => edge.node) || [];
        if (metafields.length > 0) {
          await tx.productMetafield.deleteMany({ where: { productId: product.id } });
          await tx.productMetafield.createMany({
            data: metafields.map((mf: any) => ({
              id: mf.id,
              productId: product.id,
              namespace: mf.namespace,
              key: mf.key,
              value: mf.value,
              type: mf.type,
            })),
          });
        }
      });

      synced++;

      // Send progress update every 10 products or at the end
      if (synced % 10 === 0 || synced === total) {
        const progress = Math.round(20 + (synced / total) * 80);
        sendEvent({
          type: 'progress',
          phase: 'products',
          message: `Saving products: ${synced}/${total}`,
          current: progress,
          total: 100
        });
      }
    } catch (err: any) {
      console.error(`[SYNC-STREAM] Failed to save product ${product.id}:`, err.message);
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
