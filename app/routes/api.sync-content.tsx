import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { ContentSyncService } from "../services/content-sync.service";

/**
 * API Route: Sync Content
 *
 * Synchronizes all content (collections, articles, pages) from Shopify to local database.
 * This should be called once after app installation or when forcing a re-sync.
 *
 * Usage: POST /api/sync-content
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("🔄 [SYNC-CONTENT] Starting content sync...");

  try {
    const { admin, session } = await authenticate.admin(request);

    console.log(`[SYNC-CONTENT] Syncing content for shop: ${session.shop}`);

    const syncService = new ContentSyncService(admin, session.shop);

    // Sync all content types in parallel for better performance
    const [collectionsCount, articlesCount, pagesCount, policiesCount] = await Promise.all([
      syncService.syncAllCollections(),
      syncService.syncAllArticles(),
      syncService.syncAllPages(),
      syncService.syncAllPolicies(),
    ]);

    console.log(`[SYNC-CONTENT] ✓ Sync complete!`);
    console.log(`[SYNC-CONTENT]   Collections: ${collectionsCount}`);
    console.log(`[SYNC-CONTENT]   Articles: ${articlesCount}`);
    console.log(`[SYNC-CONTENT]   Pages: ${pagesCount}`);
    console.log(`[SYNC-CONTENT]   Policies: ${policiesCount}`);

    return json({
      success: true,
      message: "Content synced successfully",
      stats: {
        collections: collectionsCount,
        articles: articlesCount,
        pages: pagesCount,
        policies: policiesCount,
        total: collectionsCount + articlesCount + pagesCount + policiesCount,
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
