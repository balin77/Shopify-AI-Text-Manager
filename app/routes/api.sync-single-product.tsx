import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { ProductSyncService } from "../services/product-sync.service";

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
  console.log("🔄 [SYNC-SINGLE-PRODUCT] Starting single product sync...");

  try {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const productId = formData.get("productId") as string;

    if (!productId) {
      return json({ error: "Missing productId parameter" }, { status: 400 });
    }

    console.log(`[SYNC-SINGLE-PRODUCT] Syncing product: ${productId}`);

    const syncService = new ProductSyncService(admin, session.shop);
    await syncService.syncProduct(productId);

    console.log(`[SYNC-SINGLE-PRODUCT] ✓ Sync complete!`);

    // Fetch updated product from database
    const { db } = await import("../db.server");
    const product = await db.product.findUnique({
      where: {
        shop_id: {
          shop: session.shop,
          id: productId,
        },
      },
      include: {
        translations: true,
      },
    });

    const translationsByLocale: Record<string, string[]> = {};
    for (const translation of product?.translations || []) {
      if (!translationsByLocale[translation.locale]) {
        translationsByLocale[translation.locale] = [];
      }
      translationsByLocale[translation.locale].push(translation.key);
    }

    return json({
      success: true,
      message: `Successfully synced product: ${productId}`,
      translationsCount: product?.translations.length || 0,
      translationsByLocale,
    });
  } catch (error: any) {
    console.error("[SYNC-SINGLE-PRODUCT] Error:", error);
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
