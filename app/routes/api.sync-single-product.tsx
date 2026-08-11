import { data as json } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ProductSyncService } from "../services/product-sync.service";
import { logger } from "~/utils/logger.server";
import { isValidShopifyGID } from "~/utils/validation";

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
  try {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const { getFormString } = await import("../utils/form-data.utils");
    const productId = getFormString(formData, "productId");

    if (!productId) {
      return json({ success: false, error: "Missing required field: productId" }, { status: 400 });
    }

    if (!isValidShopifyGID(productId)) {
      return json({ success: false, error: "Invalid productId format" }, { status: 400 });
    }

    const syncService = new ProductSyncService(admin, session.shop);
    await syncService.syncProduct(productId);

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
        shop: session.shop,
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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("[SYNC-SINGLE-PRODUCT] Error", { context: "SyncSingleProduct", error: msg, stack: error instanceof Error ? error.stack : undefined });
    return json(
      {
        success: false,
        error: "Failed to sync product.",
      },
      { status: 500 }
    );
  }
};
