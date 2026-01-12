import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { ContentSyncService } from "../services/content-sync.service";
import { BackgroundSyncService } from "../services/background-sync.service";

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
  console.log("🔄 [SYNC-CONTENT] Starting content sync...");

  try {
    const { admin, session } = await authenticate.admin(request);

    // Parse query params for selective sync
    const url = new URL(request.url);
    const typesParam = url.searchParams.get('types');
    const types = typesParam ? typesParam.split(',').map(t => t.trim()) : ['collections', 'articles', 'pages', 'policies', 'themes'];

    console.log(`[SYNC-CONTENT] Syncing content for shop: ${session.shop}`);
    console.log(`[SYNC-CONTENT] Types to sync: ${types.join(', ')}`);

    const syncService = new ContentSyncService(admin, session.shop);
    const bgSyncService = new BackgroundSyncService(admin, session.shop);

    const results: Record<string, number> = {};

    // Sync requested content types in parallel
    const promises: Promise<void>[] = [];

    if (types.includes('collections')) {
      promises.push(
        syncService.syncAllCollections()
          .then(count => { results.collections = count; })
          .catch(err => {
            console.error('[SYNC-CONTENT] Collections sync failed:', err);
            results.collections = 0;
          })
      );
    }

    if (types.includes('articles')) {
      promises.push(
        syncService.syncAllArticles()
          .then(count => { results.articles = count; })
          .catch(err => {
            console.error('[SYNC-CONTENT] Articles sync failed:', err);
            results.articles = 0;
          })
      );
    }

    if (types.includes('pages')) {
      promises.push(
        bgSyncService.syncAllPages()
          .then(count => { results.pages = count; })
          .catch(err => {
            console.error('[SYNC-CONTENT] Pages sync failed:', err);
            results.pages = 0;
          })
      );
    }

    if (types.includes('policies')) {
      promises.push(
        bgSyncService.syncAllPolicies()
          .then(count => { results.policies = count; })
          .catch(err => {
            console.error('[SYNC-CONTENT] Policies sync failed:', err);
            results.policies = 0;
          })
      );
    }

    if (types.includes('themes')) {
      promises.push(
        bgSyncService.syncAllThemes()
          .then(count => { results.themes = count; })
          .catch(err => {
            console.error('[SYNC-CONTENT] Themes sync failed:', err);
            results.themes = 0;
          })
      );
    }

    // Wait for all syncs to complete
    await Promise.all(promises);

    const total = Object.values(results).reduce((sum, count) => sum + count, 0);

    console.log(`[SYNC-CONTENT] ✓ Sync complete!`);
    Object.entries(results).forEach(([type, count]) => {
      console.log(`[SYNC-CONTENT]   ${type}: ${count}`);
    });

    return json({
      success: true,
      message: "Content synced successfully",
      stats: {
        ...results,
        total,
      },
    });
  } catch (error: any) {
    console.error("[SYNC-CONTENT] Error:", error);
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
