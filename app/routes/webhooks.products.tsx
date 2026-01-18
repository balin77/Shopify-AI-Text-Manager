import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import crypto from "crypto";

/**
 * Webhook Handler for Shopify Product Events
 *
 * Handles: products/create, products/update, products/delete
 *
 * This route is called by Shopify when products change.
 * It syncs the product data to our local database for fast access.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { logger } = await import("../utils/logger.server");
  logger.info('Product webhook received', { context: 'Webhook' });

  try {
    // 1. Extract webhook headers
    const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
    const shop = request.headers.get("X-Shopify-Shop-Domain");
    const topic = request.headers.get("X-Shopify-Topic");

    logger.debug('Webhook headers', {
      context: 'Webhook',
      shop,
      topic,
    });

    if (!shop || !topic) {
      logger.error('Missing required webhook headers', { context: 'Webhook' });
      return json({ error: "Missing headers" }, { status: 400 });
    }

    // 2. Verify webhook signature
    const rawBody = await request.text();

    if (!verifyWebhook(rawBody, hmac)) {
      logger.error('Invalid webhook signature', {
        context: 'Webhook',
        shop,
        topic,
      });
      return json({ error: "Invalid signature" }, { status: 401 });
    }

    logger.debug('Webhook signature verified', {
      context: 'Webhook',
      shop,
      topic,
    });

    // 3. Parse payload
    const payload = JSON.parse(rawBody);
    const productId = `gid://shopify/Product/${payload.id}`;

    logger.debug('Webhook payload parsed', {
      context: 'Webhook',
      productId,
    });

    // 4. Log webhook to database (with encrypted payload)
    const { db } = await import("../db.server");
    const { encryptPayload } = await import("../utils/encryption.server");
    const webhookLog = await db.webhookLog.create({
      data: {
        shop,
        topic,
        productId,
        payload: encryptPayload(rawBody) || rawBody, // Encrypt payload for security
        processed: false,
      },
    });

    logger.debug('Webhook logged to database', {
      context: 'Webhook',
      webhookLogId: webhookLog.id,
    });

    // 5. Process webhook asynchronously (don't block Shopify's response)
    // We respond immediately to Shopify, then process in background
    processWebhookAsync(webhookLog.id, shop, productId, topic).catch((err) => {
      logger.error('Background webhook processing error', {
        context: 'Webhook',
        error: err.message,
        stack: err.stack,
      });
    });

    // 6. Respond to Shopify immediately
    logger.info('Webhook accepted, responding to Shopify', {
      context: 'Webhook',
      shop,
      topic,
      productId,
    });
    return json({ received: true }, { status: 200 });
  } catch (error: any) {
    logger.error('Webhook processing error', {
      context: 'Webhook',
      error: error.message,
      stack: error.stack,
    });
    return json({ error: error.message }, { status: 500 });
  }
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
  const { logger } = await import("../utils/logger.server");
  const { webhookRetryService } = await import("../services/webhook-retry.service");
  const { ProductSyncService } = await import("../services/product-sync.service");

  logger.info('Processing webhook asynchronously', {
    context: 'Webhook',
    logId,
    topic,
    shop,
    productId,
  });

  const { db } = await import("../db.server");

  try {
    // 1. Create admin GraphQL client from shop session
    const { createAdminClientFromShop } = await import("../utils/admin-client.server");
    const admin = await createAdminClientFromShop(shop);

    logger.debug('Admin client created', {
      context: 'Webhook',
      shop,
    });

    // 2. Process based on topic
    const syncService = new ProductSyncService(admin, shop);

    if (topic === "products/create" || topic === "products/update") {
      logger.info('Syncing product', {
        context: 'Webhook',
        productId,
        topic,
      });
      await syncService.syncProduct(productId);
    } else if (topic === "products/delete") {
      logger.info('Deleting product', {
        context: 'Webhook',
        productId,
      });
      await syncService.deleteProduct(productId);
    }

    // 3. Mark webhook as processed
    await db.webhookLog.update({
      where: { id: logId },
      data: { processed: true },
    });

    logger.info('Webhook processed successfully', {
      context: 'Webhook',
      logId,
      topic,
      productId,
    });
  } catch (error: any) {
    logger.error('Error processing webhook', {
      context: 'Webhook',
      logId,
      shop,
      productId,
      topic,
      error: error.message,
      stack: error.stack,
    });

    // Log error to database
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

/**
 * Verify Shopify webhook signature
 */
function verifyWebhook(rawBody: string, hmac: string | null): boolean {
  if (!hmac) {
    return false;
  }

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    return false;
  }

  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  return hash === hmac;
}
