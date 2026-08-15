import { data as json } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { logger } from "~/utils/logger.server";

/**
 * Webhook Handler for Shopify Product Events
 *
 * Handles: products/create, products/update, products/delete
 *
 * Uses Shopify's built-in authenticate.webhook() for HMAC verification.
 * This automatically returns 401 for invalid HMAC signatures.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const productPayload = payload as { id: string | number };
  const productId = `gid://shopify/Product/${productPayload.id}`;

  // Log webhook to database (metadata only - payload stored only on error)
  const { db } = await import("../db.server");
  const webhookLog = await db.webhookLog.create({
    data: {
      shop,
      topic: topic.toLowerCase().replace("_", "/"),
      productId,
      payload: "{}",
      processed: false,
    },
  });

  // Process webhook asynchronously (don't block Shopify's response)
  processWebhookAsync(webhookLog.id, shop, productId, topic).catch((err) => {
    logger.error("[WEBHOOK] Background processing error", {
      context: "Webhook",
      error: err.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    });
  });

  return json({ received: true }, { status: 200 });
};

/**
 * SEO tab Phase 8: best-effort IndexNow enqueue for a product's storefront URL.
 * Best-effort — never let it break the webhook. `getEnabledConfig` does a
 * single (PK-indexed) query that both gates ("is IndexNow on for this shop")
 * and feeds `enqueueResource`, so shops without IndexNow skip the handle
 * lookup entirely and enabled shops don't load the config row twice.
 */
async function enqueueProductForIndexNow(db: any, shop: string, productId: string): Promise<void> {
  try {
    const { getEnabledConfig, enqueueResource, shouldEnqueueProductStatus } =
      await import("../services/seo/index-now.service");
    const config = await getEnabledConfig(db, shop);
    if (!config) return;
    const prod = await db.product.findUnique({
      where: { id: productId },
      select: { handle: true, status: true },
    });
    // UNLISTED products are excluded — they are served `noindex,nofollow` and
    // absent from sitemap.xml, so asking an engine to crawl them would publish
    // a link the merchant chose to keep unlisted. DRAFT/ARCHIVED are NOT
    // excluded: their storefront URL just turned into a 404, and reporting
    // removals is half of what IndexNow is for. (The BULK path stays
    // ACTIVE-only — see shouldEnqueueProductStatus.) The URL is built on the
    // config's primary-domain host, not on the myshopify domain.
    if (prod?.handle && shouldEnqueueProductStatus(prod.status)) {
      await enqueueResource(db, shop, "product", prod.handle, config);
    }
  } catch { /* ignore */ }
}

/**
 * Process webhook in the background
 */
async function processWebhookAsync(
  logId: string,
  shop: string,
  productId: string,
  topic: string
) {
  const { webhookRetryService } = await import("../services/webhook-retry.service");
  const { ProductSyncService } = await import("../services/product-sync.service");

  const { db } = await import("../db.server");

  try {
    const { createAdminClientFromShop } = await import("../utils/admin-client.server");
    const admin = await createAdminClientFromShop(shop);

    const syncService = new ProductSyncService(admin, shop);

    if (topic === "PRODUCTS_CREATE" || topic === "PRODUCTS_UPDATE") {
      await syncService.syncProduct(productId);
      await enqueueProductForIndexNow(db, shop, productId);
    } else if (topic === "PRODUCTS_DELETE") {
      // IndexNow is meant to be told about removed URLs too, so we must
      // enqueue BEFORE deleteProduct wipes the cache row: Shopify's
      // products/delete payload carries only the numeric id, not the handle,
      // so the handle has to come from our own cache while it still exists.
      await enqueueProductForIndexNow(db, shop, productId);
      await syncService.deleteProduct(productId);
    }

    await db.webhookLog.update({
      where: { id: logId },
      data: { processed: true },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("[WEBHOOK-ASYNC] Error processing webhook", {
      context: "Webhook",
      logId,
      shop,
      productId,
      topic,
      error: msg,
      ...(process.env.NODE_ENV !== 'production' && { stack: error instanceof Error ? error.stack : undefined }),
    });

    await db.webhookLog.update({
      where: { id: logId },
      data: {
        processed: true,
        error: msg,
      },
    });

    // Schedule retry for failed webhook
    await webhookRetryService.scheduleRetry(
      shop,
      topic,
      { productId, logId },
      error instanceof Error ? error : undefined
    );

    throw error;
  }
}
