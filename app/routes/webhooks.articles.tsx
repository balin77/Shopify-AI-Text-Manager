import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { ContentSyncService } from "../services/content-sync.service";
import { logger } from "~/utils/logger.server";

/**
 * Webhook Handler for Shopify Article (Blog) Events
 *
 * Handles: articles/create, articles/update, articles/delete
 *
 * Uses Shopify's built-in authenticate.webhook() for HMAC verification.
 * This automatically returns 401 for invalid HMAC signatures.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  logger.debug("[WEBHOOK] Article webhook received", { context: "Webhook", topic, shop });

  const articlePayload = payload as { id: string | number };
  const articleId = `gid://shopify/Article/${articlePayload.id}`;

  logger.debug("[WEBHOOK] Article ID", { context: "Webhook", articleId });

  // Log webhook to database
  const { db } = await import("../db.server");
  const webhookLog = await db.webhookLog.create({
    data: {
      shop,
      topic: topic.toLowerCase().replace("_", "/"),
      productId: articleId,
      payload: "{}",
      processed: false,
    },
  });

  logger.debug("[WEBHOOK] Logged to database", { context: "Webhook", logId: webhookLog.id });

  // Process webhook asynchronously (don't block Shopify's response)
  processWebhookAsync(webhookLog.id, shop, articleId, topic).catch((err) => {
    logger.error("[WEBHOOK] Background processing error", { context: "Webhook", error: err.message });
  });

  return json({ received: true }, { status: 200 });
};

/**
 * Process webhook in the background
 */
async function processWebhookAsync(
  logId: string,
  shop: string,
  articleId: string,
  topic: string
) {
  logger.debug("[WEBHOOK-ASYNC] Processing webhook", { context: "Webhook", logId, topic });

  const { db } = await import("../db.server");

  try {
    const { createAdminClientFromShop } = await import("../utils/admin-client.server");
    const admin = await createAdminClientFromShop(shop);

    logger.debug("[WEBHOOK-ASYNC] Created admin client", { context: "Webhook", shop });

    const syncService = new ContentSyncService(admin, shop);

    if (topic === "ARTICLES_CREATE" || topic === "ARTICLES_UPDATE") {
      logger.debug("[WEBHOOK-ASYNC] Syncing article", { context: "Webhook", articleId });
      await syncService.syncArticle(articleId);
    } else if (topic === "ARTICLES_DELETE") {
      logger.debug("[WEBHOOK-ASYNC] Deleting article", { context: "Webhook", articleId });
      await syncService.deleteArticle(articleId);
    }

    await db.webhookLog.update({
      where: { id: logId },
      data: { processed: true },
    });

    logger.debug("[WEBHOOK-ASYNC] Successfully processed", { context: "Webhook", logId });
  } catch (error: any) {
    logger.error("[WEBHOOK-ASYNC] Error processing webhook", {
      context: "Webhook",
      logId,
      error: error.message,
    });

    await db.webhookLog.update({
      where: { id: logId },
      data: {
        processed: true,
        error: error.message,
      },
    });

    throw error;
  }
}
