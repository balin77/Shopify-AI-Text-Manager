import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { ContentSyncService } from "../services/content-sync.service";
import { logger } from "~/utils/logger.server";

/**
 * Webhook Handler for Shopify Menu Events
 *
 * Handles: menus/create, menus/update, menus/delete
 *
 * Uses Shopify's built-in authenticate.webhook() for HMAC verification.
 * This automatically returns 401 for invalid HMAC signatures.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  logger.debug("[WEBHOOK] Menu webhook received", { context: "Webhook", topic, shop });

  const menuPayload = payload as { id: string | number };
  const menuId = `gid://shopify/Menu/${menuPayload.id}`;

  logger.debug("[WEBHOOK] Menu ID", { context: "Webhook", menuId });

  // Log webhook to database
  const { db } = await import("../db.server");
  const webhookLog = await db.webhookLog.create({
    data: {
      shop,
      topic: topic.toLowerCase().replace("_", "/"),
      productId: menuId,
      payload: "{}",
      processed: false,
    },
  });

  logger.debug("[WEBHOOK] Logged to database", { context: "Webhook", logId: webhookLog.id });

  // Process webhook asynchronously (don't block Shopify's response)
  processWebhookAsync(webhookLog.id, shop, menuId, topic).catch((err) => {
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
  menuId: string,
  topic: string
) {
  logger.debug("[WEBHOOK-ASYNC] Processing webhook", { context: "Webhook", logId, topic });

  const { db } = await import("../db.server");

  try {
    const { createAdminClientFromShop } = await import("../utils/admin-client.server");
    const admin = await createAdminClientFromShop(shop);

    logger.debug("[WEBHOOK-ASYNC] Created admin client", { context: "Webhook", shop });

    const syncService = new ContentSyncService(admin, shop);

    if (topic === "MENUS_CREATE" || topic === "MENUS_UPDATE") {
      logger.debug("[WEBHOOK-ASYNC] Syncing menu", { context: "Webhook", menuId });
      await syncService.syncMenu(menuId);
    } else if (topic === "MENUS_DELETE") {
      logger.debug("[WEBHOOK-ASYNC] Deleting menu", { context: "Webhook", menuId });
      await syncService.deleteMenu(menuId);
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
