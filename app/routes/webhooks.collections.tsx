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
 * SEO tab Phase 8: best-effort IndexNow enqueue for a collection's storefront
 * URL. Best-effort — never let it break the webhook. `getEnabledConfig` does a
 * single (PK-indexed) query that both gates ("is IndexNow on for this shop")
 * and feeds `enqueueResource`, so shops without IndexNow skip the handle
 * lookup entirely and enabled shops don't load the config row twice.
 */
async function enqueueCollectionForIndexNow(db: any, shop: string, collectionId: string): Promise<void> {
  try {
    const { getEnabledConfig, enqueueResource } = await import("../services/seo/index-now.service");
    const config = await getEnabledConfig(db, shop);
    if (!config) return;
    const coll = await db.collection.findUnique({ where: { id: collectionId }, select: { handle: true } });
    if (coll?.handle) await enqueueResource(db, shop, shop, "collection", coll.handle, config);
  } catch { /* ignore */ }
}

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
      await enqueueCollectionForIndexNow(db, shop, collectionId);
    } else if (topic === "COLLECTIONS_DELETE") {
      // IndexNow is meant to be told about removed URLs too, so we must
      // enqueue BEFORE deleteCollection wipes the cache row: Shopify's
      // collections/delete payload carries only the numeric id, not the
      // handle, so the handle has to come from our own cache while it exists.
      await enqueueCollectionForIndexNow(db, shop, collectionId);
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
