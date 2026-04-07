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

  const menuPayload = payload as { id: string | number };
  const menuId = `gid://shopify/Menu/${menuPayload.id}`;

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
  const { db } = await import("../db.server");

  try {
    const { createAdminClientFromShop } = await import("../utils/admin-client.server");
    const admin = await createAdminClientFromShop(shop);

    const syncService = new ContentSyncService(admin, shop);

    if (topic === "MENUS_CREATE" || topic === "MENUS_UPDATE") {
      await syncService.syncMenu(menuId);
    } else if (topic === "MENUS_DELETE") {
      await syncService.deleteMenu(menuId);
    }

    await db.webhookLog.update({
      where: { id: logId },
      data: { processed: true },
    });
  } catch (error: unknown) {
    logger.error("[WEBHOOK-ASYNC] Error processing webhook", {
      context: "Webhook",
      logId,
      error: error instanceof Error ? error.message : String(error),
    });

    await db.webhookLog.update({
      where: { id: logId },
      data: {
        processed: true,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    throw error;
  }
}
