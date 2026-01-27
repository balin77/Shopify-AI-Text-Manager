import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { ProductSyncService } from "../services/product-sync.service";
import { logger } from "~/utils/logger.server";

/**
 * API Route: Sync Single Product
 *
 * Re-syncs a single product from Shopify to database
 * Useful for testing the updated sync logic
 *
 * Usage: POST /api/sync-single-product
 * Body: { productId: "gid://shopify/Product/123" }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  logger.debug("[SYNC-SINGLE-PRODUCT] Starting single product sync...", { context: "SyncSingleProduct" });

  try {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const productId = formData.get("productId") as string;

    if (!productId) {
      return json({ error: "Missing productId parameter" }, { status: 400 });
    }

    logger.debug("[SYNC-SINGLE-PRODUCT] Syncing product", { context: "SyncSingleProduct", productId });

    const syncService = new ProductSyncService(admin, session.shop);
    await syncService.syncProduct(productId);

    logger.debug("[SYNC-SINGLE-PRODUCT] Sync complete!", { context: "SyncSingleProduct" });

    // Fetch updated product and translations from database
    const { db } = await import("../db.server");
    const product = await db.product.findUnique({
      where: {
        shop_id: {
          shop: session.shop,
          id: productId,
        },
      },
    });

    const translations = await db.contentTranslation.findMany({
      where: {
        resourceId: productId,
        resourceType: "Product",
      },
    });

    const translationsByLocale: Record<string, string[]> = {};
    for (const translation of translations) {
      if (!translationsByLocale[translation.locale]) {
        translationsByLocale[translation.locale] = [];
      }
      translationsByLocale[translation.locale].push(translation.key);
    }

    return json({
      success: true,
      message: `Successfully synced product: ${productId}`,
      translationsCount: translations.length,
      translationsByLocale,
    });
  } catch (error: any) {
    logger.error("[SYNC-SINGLE-PRODUCT] Error", { context: "SyncSingleProduct", error: error.message, stack: error.stack });
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
