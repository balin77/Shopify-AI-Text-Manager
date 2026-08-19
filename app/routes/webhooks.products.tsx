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

/** What the cache held BEFORE the sync overwrote it (null when IndexNow is off). */
type IndexNowSnapshot = { handle: string | null; status: string | null } | null;

/**
 * SEO tab Phase 8: read the product's PREVIOUS cached state, if this shop has
 * IndexNow enabled. Must run BEFORE the sync, because "was this product live
 * until now?" is exactly what decides whether an unpublish is worth reporting —
 * and the sync overwrites that. Returns null (and skips the read entirely) for
 * every shop without IndexNow, so the common case costs one PK-indexed query.
 */
async function loadIndexNowSnapshot(db: any, shop: string, productId: string): Promise<IndexNowSnapshot> {
  try {
    const { getEnabledConfig } = await import("../services/seo/index-now.service");
    if (!(await getEnabledConfig(db, shop))) return null;
    const prev = await db.product.findUnique({
      where: { id: productId },
      select: { handle: true, status: true },
    });
    return { handle: prev?.handle ?? null, status: prev?.status ?? null };
  } catch {
    return null;
  }
}

/**
 * Best-effort IndexNow enqueue for a product's storefront URL — never let it
 * break the webhook. The URL is built on the config's primary-domain host, not
 * on the myshopify domain. `before` is the pre-sync snapshot; a product that
 * was live and no longer is gets its (now dead) URL reported, while one that
 * was never live is skipped — see shouldEnqueueProductChange.
 */
async function enqueueProductForIndexNow(
  db: any,
  shop: string,
  productId: string,
  before: IndexNowSnapshot,
): Promise<void> {
  try {
    const { getEnabledConfig, enqueueResource, shouldEnqueueProductChange } =
      await import("../services/seo/index-now.service");
    const config = await getEnabledConfig(db, shop);
    if (!config) return;
    const prod = await db.product.findUnique({
      where: { id: productId },
      select: { handle: true, status: true },
    });
    if (prod?.handle && shouldEnqueueProductChange(before?.status, prod.status)) {
      await enqueueResource(db, shop, "product", prod.handle, config);
    }
    // A renamed handle leaves the OLD URL behind as a 404/redirect — report it
    // too, but only if that URL was ever live.
    if (before?.handle && before.handle !== prod?.handle && before.status === "ACTIVE") {
      await enqueueResource(db, shop, "product", before.handle, config);
    }
  } catch { /* ignore */ }
}

/**
 * Delete path: the product row is about to disappear, so the cached state IS
 * the "before" and there is no "after".
 */
async function enqueueDeletedProductForIndexNow(db: any, shop: string, productId: string): Promise<void> {
  try {
    const { getEnabledConfig, enqueueResource, shouldEnqueueProductChange } =
      await import("../services/seo/index-now.service");
    const config = await getEnabledConfig(db, shop);
    if (!config) return;
    const prod = await db.product.findUnique({
      where: { id: productId },
      select: { handle: true, status: true },
    });
    if (prod?.handle && shouldEnqueueProductChange(prod.status, null)) {
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
      // Snapshot first: the sync is what erases the previous status/handle,
      // and both decide what IndexNow should hear about.
      const before = await loadIndexNowSnapshot(db, shop, productId);
      // This run writes the video-date metafield like every other sync path.
      // It may well BE the echo of our own write, but the pass is diff-driven
      // and the mirror has already advanced, so the echo run writes nothing
      // and the sequence stops — while a merchant who added a video in the
      // admin fires only this webhook, and suppressing it here left that
      // product without an uploadDate until the next full sync.
      await syncService.syncProduct(productId, false);
      await enqueueProductForIndexNow(db, shop, productId, before);
    } else if (topic === "PRODUCTS_DELETE") {
      // IndexNow is meant to be told about removed URLs too, so we must
      // enqueue BEFORE deleteProduct wipes the cache row: Shopify's
      // products/delete payload carries only the numeric id, not the handle,
      // so the handle has to come from our own cache while it still exists.
      await enqueueDeletedProductForIndexNow(db, shop, productId);
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
