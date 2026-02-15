import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
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

  logger.info("[WEBHOOK] Product webhook received", { context: "Webhook", topic, shop });

  const productPayload = payload as { id: string | number };
  const productId = `gid://shopify/Product/${productPayload.id}`;

  logger.debug("[WEBHOOK] Product ID", { context: "Webhook", productId });

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

  logger.debug("[WEBHOOK] Logged to database", { context: "Webhook", webhookLogId: webhookLog.id });

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

  logger.info("[WEBHOOK-ASYNC] Processing webhook", {
    context: "Webhook",
    logId,
    topic,
    shop,
    productId,
  });

  const { db } = await import("../db.server");

  try {
    const { createAdminClientFromShop } = await import("../utils/admin-client.server");
    const admin = await createAdminClientFromShop(shop);

    logger.debug("[WEBHOOK-ASYNC] Admin client created", { context: "Webhook", shop });

    const syncService = new ProductSyncService(admin, shop);

    if (topic === "PRODUCTS_CREATE" || topic === "PRODUCTS_UPDATE") {
      logger.debug("[WEBHOOK-ASYNC] Syncing product", { context: "Webhook", productId, topic });
      await syncService.syncProduct(productId);
    } else if (topic === "PRODUCTS_DELETE") {
      logger.info("[WEBHOOK-ASYNC] Deleting product", { context: "Webhook", productId });
      await syncService.deleteProduct(productId);
    }

    await db.webhookLog.update({
      where: { id: logId },
      data: { processed: true },
    });

    logger.info("[WEBHOOK-ASYNC] Successfully processed", { context: "Webhook", logId, topic, productId });
  } catch (error: any) {
    logger.error("[WEBHOOK-ASYNC] Error processing webhook", {
      context: "Webhook",
      logId,
      shop,
      productId,
      topic,
      error: error.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: error.stack }),
    });

    await db.webhookLog.update({
      where: { id: logId },
      data: {
        processed: true,
        error: error.message,
      },
    });

    // Schedule retry for failed webhook
    await webhookRetryService.scheduleRetry(
      shop,
      topic,
      { productId, logId },
      error
    );

    throw error;
  }
}
