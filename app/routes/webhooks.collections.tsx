import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { ContentSyncService } from "../services/content-sync.service";
import { logger } from "~/utils/logger.server";

/**
 * Webhook Handler for Shopify Collection Events
 *
 * Handles: collections/create, collections/update, collections/delete
 *
 * Uses Shopify's built-in authenticate.webhook() for HMAC verification.
 * This automatically returns 401 for invalid HMAC signatures.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const collectionPayload = payload as { id: string | number };
  const collectionId = `gid://shopify/Collection/${collectionPayload.id}`;

  // Log webhook to database
  const { db } = await import("../db.server");
  const webhookLog = await db.webhookLog.create({
    data: {
      shop,
      topic: topic.toLowerCase().replace("_", "/"),
      productId: collectionId,
      payload: "{}",
      processed: false,
    },
  });

  // Process webhook asynchronously (don't block Shopify's response).
  // Review LOW ("returns 200 on internal error"): intentional and now safe.
  // We must ack fast (Shopify's webhook timeout is short) and a non-2xx would
  // eventually make Shopify disable the subscription. Durability no longer
  // relies on the HTTP status: processing failures persist to webhookLog AND
  // schedule a real retry via webhookRetryService (see processWebhookAsync /
  // N-H7), so a transient error is recovered rather than lost.
  processWebhookAsync(webhookLog.id, shop, collectionId, topic).catch((err) => {
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
  collectionId: string,
  topic: string
) {
  const { db } = await import("../db.server");
  const { webhookRetryService } = await import("../services/webhook-retry.service");

  try {
    const { createAdminClientFromShop } = await import("../utils/admin-client.server");
    const admin = await createAdminClientFromShop(shop);

    const syncService = new ContentSyncService(admin, shop);

    if (topic === "COLLECTIONS_CREATE" || topic === "COLLECTIONS_UPDATE") {
      await syncService.syncCollection(collectionId);
      // SEO tab Phase 8: queue the changed URL for IndexNow (no-op unless the
      // shop enabled IndexNow). Best-effort — never let it break the webhook.
      try {
        const { enqueueResource } = await import("../services/seo/index-now.service");
        const coll = await db.collection.findUnique({ where: { id: collectionId }, select: { handle: true } });
        if (coll?.handle) await enqueueResource(db, shop, shop, "collection", coll.handle);
      } catch { /* ignore */ }
    } else if (topic === "COLLECTIONS_DELETE") {
      await syncService.deleteCollection(collectionId);
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
      error: msg,
    });

    await db.webhookLog.update({
      where: { id: logId },
      data: {
        processed: true,
        error: msg,
      },
    });

    // Schedule retry for failed webhook — parity with webhooks.products so a
    // transient error no longer permanently loses the collection update (N-H7).
    await webhookRetryService.scheduleRetry(
      shop,
      topic,
      { collectionId, logId },
      error instanceof Error ? error : undefined
    );

    throw error;
  }
}
