import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { ContentSyncService } from "../services/content-sync.service";
import { BackgroundSyncService } from "../services/background-sync.service";
import { db } from "../db.server";
import { getPlanLimits, getSyncScope, canAccessContentType, type Plan } from "../utils/planUtils";
import { logger } from "~/utils/logger.server";
import { SyncContentQuerySchema } from "~/utils/validation";

/**
 * API Route: Sync Content
 *
 * Synchronizes all content from Shopify to local database.
 * This should be called once after app installation or when forcing a re-sync.
 *
 * Supports selective syncing via query parameter:
 * - POST /api/sync-content - Sync everything (default)
 * - POST /api/sync-content?types=pages,policies - Sync only specific types
 *
 * Available types: collections, articles, pages, policies, themes
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);

    // Parse and validate query params for selective sync
    const url = new URL(request.url);
    const queryParsed = SyncContentQuerySchema.safeParse({ types: url.searchParams.get('types') ?? undefined });
    if (!queryParsed.success) {
      const issues = queryParsed.error.issues.map(i => i.message).join(', ');
      return json({ success: false, error: `Invalid query parameters: ${issues}` }, { status: 400 });
    }
    const types = queryParsed.data.types;

    // Load plan limits
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    const plan = (settings?.subscriptionPlan || "free") as Plan;
    const planLimits = getPlanLimits(plan);

    const syncService = new ContentSyncService(admin, session.shop);
    const bgSyncService = new BackgroundSyncService(admin, session.shop);

    const results: Record<string, number> = {};

    // Sync requested content types in parallel
    const promises: Promise<void>[] = [];

    if (types.includes('collections')) {
      promises.push(
        syncService.syncAllCollections(planLimits.maxCollections)
          .then(count => { results.collections = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] Collections sync failed', { context: "SyncContent", error: err.message });
            results.collections = 0;
          })
      );
    }

    if (types.includes('articles')) {
      promises.push(
        syncService.syncAllArticles(planLimits.maxArticles)
          .then(count => { results.articles = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] Articles sync failed', { context: "SyncContent", error: err.message });
            results.articles = 0;
          })
      );
    }

    if (types.includes('pages')) {
      promises.push(
        bgSyncService.syncAllPages(planLimits.maxPages)
          .then(count => { results.pages = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] Pages sync failed', { context: "SyncContent", error: err.message });
            results.pages = 0;
          })
      );
    }

    if (types.includes('policies')) {
      promises.push(
        bgSyncService.syncAllPolicies()
          .then(count => { results.policies = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] Policies sync failed', { context: "SyncContent", error: err.message });
            results.policies = 0;
          })
      );
    }

    if (types.includes('themes')) {
      promises.push(
        bgSyncService.syncAllThemes()
          .then(count => { results.themes = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] Themes sync failed', { context: "SyncContent", error: err.message });
            results.themes = 0;
          })
      );
    }

    // Discovery for the remaining BackgroundSyncService.syncAll() phases, so the
    // list-level "sync from Shopify" button can find newly-created resources for
    // these content types too. Plan-gated off the same source of truth as
    // syncAll() (getSyncScope / canAccessContentType) so a click can never pull
    // content the plan isn't entitled to.
    const scope = getSyncScope(plan);

    if (types.includes('metaobjects') && scope.metaobjects.enabled) {
      promises.push(
        (async () => {
          const { MetaobjectSyncService } = await import("../services/metaobject-sync.service");
          const r = await new MetaobjectSyncService(admin, session.shop).syncAll();
          results.metaobjects = r.metaobjects;
        })().catch(err => {
          logger.error('[SYNC-CONTENT] Metaobjects sync failed', { context: "SyncContent", error: err.message });
          results.metaobjects = 0;
        })
      );
    }

    if (types.includes('menus') && scope.menus.enabled) {
      promises.push(
        syncService.syncAllMenus()
          .then(count => { results.menus = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] Menus sync failed', { context: "SyncContent", error: err.message });
            results.menus = 0;
          })
      );
    }

    if (types.includes('system') && canAccessContentType(plan, 'system')) {
      promises.push(
        bgSyncService.syncSystemContent()
          .then(count => { results.system = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] System sync failed', { context: "SyncContent", error: err.message });
            results.system = 0;
          })
      );
    }

    if (types.includes('delivery') && canAccessContentType(plan, 'delivery')) {
      promises.push(
        bgSyncService.syncDeliveryContent()
          .then(count => { results.delivery = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] Delivery sync failed', { context: "SyncContent", error: err.message });
            results.delivery = 0;
          })
      );
    }

    if (types.includes('sellingPlans') && canAccessContentType(plan, 'sellingPlans')) {
      promises.push(
        bgSyncService.syncSellingPlans()
          .then(count => { results.sellingPlans = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] Selling-Plans sync failed', { context: "SyncContent", error: err.message });
            results.sellingPlans = 0;
          })
      );
    }

    // Online-Store extras (filters + shop metadata) are entitled on every tier.
    if (types.includes('onlineStoreExtras')) {
      promises.push(
        bgSyncService.syncOnlineStoreExtras()
          .then(count => { results.onlineStoreExtras = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] Online-Store-Extras sync failed', { context: "SyncContent", error: err.message });
            results.onlineStoreExtras = 0;
          })
      );
      // The Cookie-Banner tab's config.contentType is also "onlineStoreExtras",
      // but its content is synced by a SEPARATE phase. Mirror syncAll() and run
      // syncCookieBanner() here too, otherwise the Cookie-Banner tab's list-level
      // sync would discover nothing for that tab. It gracefully no-ops when its
      // (unstable) endpoint is unreachable, so it is safe to run unconditionally.
      promises.push(
        bgSyncService.syncCookieBanner()
          .then(count => { results.cookieBanner = count; })
          .catch(err => {
            logger.error('[SYNC-CONTENT] Cookie-Banner sync failed', { context: "SyncContent", error: err.message });
            results.cookieBanner = 0;
          })
      );
    }

    // Wait for all syncs to complete
    await Promise.all(promises);

    const total = Object.values(results).reduce((sum, count) => sum + count, 0);

    logger.info("[SYNC-CONTENT] Complete", { context: "SyncContent", results, total });

    return json({
      success: true,
      message: "Content synced successfully",
      stats: {
        ...results,
        total,
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("[SYNC-CONTENT] Error", { context: "SyncContent", error: msg, stack: error instanceof Error ? error.stack : undefined });
    return json(
      {
        success: false,
        error: "Failed to sync content",
      },
      { status: 500 }
    );
  }
};
