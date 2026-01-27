import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import crypto from "crypto";
import { ContentSyncService } from "../services/content-sync.service";
import { encryptPayload } from "../utils/encryption.server";
import { logger } from "~/utils/logger.server";

/**
 * Webhook Handler for Shopify Menu Events
 *
 * Handles: menus/create, menus/update, menus/delete
 *
 * This route is called by Shopify when menus change.
 * It syncs the menu data to our local database for fast access.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  logger.debug("[WEBHOOK] MENU WEBHOOK RECEIVED", { context: "Webhook" });

  try {
    // 1. Extract webhook headers
    const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
    const shop = request.headers.get("X-Shopify-Shop-Domain");
    const topic = request.headers.get("X-Shopify-Topic");

    logger.debug("[WEBHOOK] Menu webhook details", { context: "Webhook", shop, topic });

    if (!shop || !topic) {
      logger.error("[WEBHOOK] Missing required headers", { context: "Webhook" });
      return json({ error: "Missing headers" }, { status: 400 });
    }

    // 2. Verify webhook signature
    const rawBody = await request.text();

    if (!verifyWebhook(rawBody, hmac)) {
      logger.error("[WEBHOOK] Invalid signature", { context: "Webhook" });
      return json({ error: "Invalid signature" }, { status: 401 });
    }

    logger.debug("[WEBHOOK] Signature verified", { context: "Webhook" });

    // 3. Parse payload
    const payload = JSON.parse(rawBody);
    const menuId = `gid://shopify/Menu/${payload.id}`;

    logger.debug("[WEBHOOK] Menu ID", { context: "Webhook", menuId });

    // 4. Log webhook to database
    const { db } = await import("../db.server");
    const webhookLog = await db.webhookLog.create({
      data: {
        shop,
        topic,
        productId: menuId, // Reuse productId field for menu ID
        payload: encryptPayload(rawBody) || rawBody, // Encrypt payload for security
        processed: false,
      },
    });

    logger.debug("[WEBHOOK] Logged to database", { context: "Webhook", logId: webhookLog.id });

    // 5. Process webhook asynchronously (don't block Shopify's response)
    processWebhookAsync(webhookLog.id, shop, menuId, topic).catch((err) => {
      logger.error("[WEBHOOK] Background processing error", { context: "Webhook", error: err.message });
    });

    // 6. Respond to Shopify immediately
    logger.debug("[WEBHOOK] Responding to Shopify with 200 OK", { context: "Webhook" });
    return json({ received: true }, { status: 200 });
  } catch (error: any) {
    logger.error("[WEBHOOK] Error", { context: "Webhook", error: error.message, stack: error.stack });
    return json({ error: error.message }, { status: 500 });
  }
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
    // 1. Create admin GraphQL client from shop session
    const { createAdminClientFromShop } = await import("../utils/admin-client.server");
    const admin = await createAdminClientFromShop(shop);

    logger.debug("[WEBHOOK-ASYNC] Created admin client for shop", { context: "Webhook", shop });

    // 2. Process based on topic
    const syncService = new ContentSyncService(admin, shop);

    if (topic === "menus/create" || topic === "menus/update") {
      logger.debug("[WEBHOOK-ASYNC] Syncing menu", { context: "Webhook", menuId });
      await syncService.syncMenu(menuId);
    } else if (topic === "menus/delete") {
      logger.debug("[WEBHOOK-ASYNC] Deleting menu", { context: "Webhook", menuId });
      await syncService.deleteMenu(menuId);
    }

    // 3. Mark webhook as processed
    await db.webhookLog.update({
      where: { id: logId },
      data: { processed: true },
    });

    logger.debug("[WEBHOOK-ASYNC] Successfully processed webhook", { context: "Webhook", logId });
  } catch (error: any) {
    logger.error("[WEBHOOK-ASYNC] Error processing webhook", { context: "Webhook", logId, error: error.message });

    // Log error to database
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

/**
 * Verify Shopify webhook signature
 */
function verifyWebhook(rawBody: string, hmac: string | null): boolean {
  if (!hmac) {
    logger.warn("[WEBHOOK] No HMAC provided", { context: "Webhook" });
    return false;
  }

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    logger.error("[WEBHOOK] SHOPIFY_API_SECRET not configured", { context: "Webhook" });
    return false;
  }

  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const verified = hash === hmac;

  if (!verified) {
    logger.warn("[WEBHOOK] Signature mismatch", { context: "Webhook", expected: hash, received: hmac });
  }

  return verified;
}
