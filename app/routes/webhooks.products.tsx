import { data as json } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { verifyWebhookRequest } from "~/utils/webhook-auth.server";
import {
  getConnectionBlock,
  isShopConnectionBlockedError,
  noteDroppedWebhook,
  recordWebhookSeen,
  ShopConnectionBlockedError,
} from "~/utils/shop-connection-state.server";
import { logger } from "~/utils/logger.server";

/**
 * Webhook Handler for Shopify Product Events
 *
 * Handles: products/create, products/update, products/delete
 *
 * Verified by signature only (verifyWebhookRequest -> 401 for an invalid HMAC):
 * this route never reads the library's session/admin, and the library's offline
 * token refresh after the HMAC check answered 500 for shops whose token is dead.
 * The Admin client is created in the background processing only.
 *
 * A shop with a BLOCKED connection gets 200 and no Admin API call: a delete is
 * applied locally (DB only), a create/update is only counted
 * (noteDroppedWebhook -> a catch-up is owed after the next sign-in). No retry
 * row, no WebhookLog error row, debug log only.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const verified = await verifyWebhookRequest(request);
  const { shop, payload } = verified;
  // The library spells topics PRODUCTS_UPDATE, the header products/update.
  const topic = verified.topic.toUpperCase().replace("/", "_");
  await recordWebhookSeen(shop, request.headers.get("x-shopify-triggered-at"));

  const blocked = await getConnectionBlock(shop);
  if (blocked && topic !== "PRODUCTS_DELETE") {
    await noteDroppedWebhook(shop);
    logger.debug("[WEBHOOK] Product webhook of a blocked shop counted, not processed", {
      context: "Webhook",
      shop,
      topic,
    });
    return json({ received: true }, { status: 200 });
  }

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

/** Placeholder client for the DB-only delete path: any Shopify call is a bug and fails loudly. */
function unusableAdmin(shop: string) {
  return {
    graphql: async () => {
      throw new ShopConnectionBlockedError(shop, { state: "needs_reauth", reason: "webhook_delete_no_admin", since: null });
    },
  };
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
    // A delete touches the database only (deleteProduct never calls Shopify),
    // so it needs no Admin client: it must work for a blocked shop too.
    let admin: any;
    if (topic === "PRODUCTS_DELETE") {
      admin = unusableAdmin(shop);
    } else {
      const { createAdminClientFromShop } = await import("../utils/admin-client.server");
      admin = await createAdminClientFromShop(shop);
    }

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
      //
      // A products/UPDATE webhook is also THE "the primary text changed"
      // event, so the sync reconciles now-stale foreign translations (delete,
      // or re-translate on Max) — see
      // services/translations/stale-translation-sync.server.ts. A CREATE is a
      // first sync, never a change event.
      await syncService.syncProduct(productId, false, {
        reconcileTranslations: topic === "PRODUCTS_UPDATE",
      });
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
    // The connection got blocked after the request was accepted: the same quiet
    // path as a blocked shop at the door (counted, no error row, no retry).
    if (isShopConnectionBlockedError(error)) {
      logger.debug("[WEBHOOK-ASYNC] Shop connection blocked, webhook counted", { context: "Webhook", shop, topic });
      await noteDroppedWebhook(shop);
      await db.webhookLog.update({ where: { id: logId }, data: { processed: true } }).catch(() => undefined);
      return;
    }
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
