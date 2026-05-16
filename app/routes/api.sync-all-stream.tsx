import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { getPlanLimits, type Plan } from "../utils/planUtils";
import { ProductSyncService } from "../services/product-sync.service";
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
          metaobjects: 'syncEmptyResponseMetaobjects' as any,
        };

        function getSyncErrorMessage(phase: string, err: unknown): string {
          const msg = (err instanceof Error ? err.message : String(err)) || '';
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
          metaobjects: 0,
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

        // Gate the products+translations phase on the explicit "initial full
        // sync completed" marker — NOT on db.product.count. A Remix prefetch of
        // the products loader populates db.product before this runs, so a
        // count-based gate would skip the only bulk-translation fetch forever.
        if (!force) {
          const installState = await db.shopInstallState.findUnique({
            where: { shop },
            select: { initialSyncCompletedAt: true },
          });
          if (installState?.initialSyncCompletedAt) {
            sendEvent({
              type: 'progress',
              phase: 'products',
              message: `Initial sync already completed, skipping products...`,
              current: 100,
              total: 100
            });
            stats.products = 0;
          } else {
            const productSyncService = new ProductSyncService(admin, shop);
            stats.products = await productSyncService.syncAllProducts({
              maxProducts: planLimits.maxProducts === Infinity ? 10000 : planLimits.maxProducts,
              cacheProductImages: planLimits.cacheEnabled.productImages,
              signal,
              onProgress: (info) => {
                checkAborted();
                sendEvent({
                  type: 'progress',
                  phase: 'products',
                  message: 'Syncing products...',
                  current: info.overallPercent,
                  total: 100,
                  detailCurrent: info.detailCurrent,
                  detailTotal: info.detailTotal,
                  detailMessage: info.message
                });
              },
            });
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
          const productSyncService = new ProductSyncService(admin, shop);
          stats.products = await productSyncService.syncAllProducts({
            maxProducts: planLimits.maxProducts === Infinity ? 10000 : planLimits.maxProducts,
            cacheProductImages: planLimits.cacheEnabled.productImages,
            signal,
            onProgress: (info) => {
              checkAborted();
              sendEvent({
                type: 'progress',
                phase: 'products',
                message: 'Syncing products...',
                current: info.overallPercent,
                total: 100,
                detailCurrent: info.detailCurrent,
                detailTotal: info.detailTotal,
                detailMessage: info.message
              });
            },
          });
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
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") throw err;
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
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") throw err;
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
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") throw err;
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
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") throw err;
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
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") throw err;
          sendEvent({
            type: 'progress',
            phase: 'themes',
            message: getSyncErrorMessage('themes', err),
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // PHASE 7: Sync Metaobjects
        // ==========================================
        checkAborted();
        sendEvent({
          type: 'progress',
          phase: 'metaobjects',
          message: 'Syncing metaobjects...',
          current: 0,
          total: 100
        });

        try {
          const { MetaobjectSyncService } = await import("../services/metaobject-sync.service");
          const metaobjectSync = new MetaobjectSyncService(admin, shop);
          const metaResult = await metaobjectSync.syncAll((current, total, message) => {
            checkAborted();
            sendEvent({
              type: 'progress',
              phase: 'metaobjects',
              message: 'Syncing metaobjects...',
              current: Math.round((current / total) * 100),
              total: 100,
              detailCurrent: current,
              detailTotal: total,
              detailMessage: message
            });
          });
          stats.metaobjects = metaResult.metaobjects;
          sendEvent({
            type: 'progress',
            phase: 'metaobjects',
            message: `Synced ${metaResult.definitions} definitions, ${metaResult.metaobjects} metaobjects`,
            current: 100,
            total: 100
          });
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") throw err;
          sendEvent({
            type: 'progress',
            phase: 'metaobjects',
            message: getSyncErrorMessage('metaobjects', err),
            current: 100,
            total: 100
          });
        }

        // ==========================================
        // COMPLETE
        // ==========================================
        // Mark the initial full sync as completed. This is what onboarding
        // (app._index) and the products gate above key off — set ONLY here,
        // after a fully successful run. A client disconnect/abort throws
        // AbortError into the outer catch and skips this block, leaving the
        // marker unset (the safe state → onboarding re-runs). Written BEFORE
        // the 'complete' event so the client's redirect only fires once the
        // marker is durably persisted (closes the re-nav / multi-tab race).
        try {
          await db.shopInstallState.upsert({
            where: { shop },
            create: { shop, initialSyncCompletedAt: new Date() },
            update: { initialSyncCompletedAt: new Date() },
          });
        } catch (e) {
          logger.warn("[SYNC-STREAM] Failed to set initialSyncCompletedAt", {
            shop, error: e instanceof Error ? e.message : String(e),
          });
        }

        sendEvent({
          type: 'complete',
          phase: 'done',
          message: 'Sync complete!',
          stats
        });

      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          logger.info("[SYNC-STREAM] Sync aborted due to client disconnection", { shop });
        } else {
          logger.error("[SYNC-STREAM] Sync failed", { error: error instanceof Error ? error.message : String(error), shop });
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

