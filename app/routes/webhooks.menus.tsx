import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import crypto from "crypto";
import { ContentSyncService } from "../services/content-sync.service";

/**
 * Webhook Handler for Shopify Menu Events
 *
 * Handles: menus/create, menus/update, menus/delete
 *
 * This route is called by Shopify when menus change.
 * It syncs the menu data to our local database for fast access.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("🎣 [WEBHOOK] === MENU WEBHOOK RECEIVED ===");

  try {
    // 1. Extract webhook headers
    const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
    const shop = request.headers.get("X-Shopify-Shop-Domain");
    const topic = request.headers.get("X-Shopify-Topic");

    console.log(`[WEBHOOK] Shop: ${shop}, Topic: ${topic}`);

    if (!shop || !topic) {
      console.error("[WEBHOOK] Missing required headers");
      return json({ error: "Missing headers" }, { status: 400 });
    }

    // 2. Verify webhook signature
    const rawBody = await request.text();

    if (!verifyWebhook(rawBody, hmac)) {
      console.error("[WEBHOOK] Invalid signature");
      return json({ error: "Invalid signature" }, { status: 401 });
    }

    console.log("[WEBHOOK] Signature verified ✓");

    // 3. Parse payload
    const payload = JSON.parse(rawBody);
    const menuId = `gid://shopify/Menu/${payload.id}`;

    console.log(`[WEBHOOK] Menu ID: ${menuId}`);

    // 4. Log webhook to database
    const { db } = await import("../db.server");
    const webhookLog = await db.webhookLog.create({
      data: {
        shop,
        topic,
        productId: menuId, // Reuse productId field for menu ID
        payload: rawBody,
        processed: false,
      },
    });

    console.log(`[WEBHOOK] Logged to database: ${webhookLog.id}`);

    // 5. Process webhook asynchronously (don't block Shopify's response)
    processWebhookAsync(webhookLog.id, shop, menuId, topic).catch((err) => {
      console.error("[WEBHOOK] Background processing error:", err);
    });

    // 6. Respond to Shopify immediately
    console.log("[WEBHOOK] Responding to Shopify with 200 OK");
    return json({ received: true }, { status: 200 });
  } catch (error: any) {
    console.error("[WEBHOOK] Error:", error);
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
  console.log(`[WEBHOOK-ASYNC] Processing webhook ${logId} for ${topic}`);

  const { db } = await import("../db.server");

  try {
    // 1. Get admin session for this shop
    const session = await db.session.findFirst({
      where: { shop },
      orderBy: { id: "desc" },
    });

    if (!session) {
      throw new Error(`No session found for shop: ${shop}`);
    }

    console.log(`[WEBHOOK-ASYNC] Found session for shop: ${shop}`);

    // 2. Create admin GraphQL client
    const { authenticate } = await import("../shopify.server");

    // Create a mock request with the session
    const mockRequest = new Request("https://fake.url", {
      headers: {
        "Authorization": `Bearer ${session.accessToken}`,
      },
    });

    const { admin } = await authenticate.admin(mockRequest);

    // 3. Process based on topic
    const syncService = new ContentSyncService(admin, shop);

    if (topic === "menus/create" || topic === "menus/update") {
      console.log(`[WEBHOOK-ASYNC] Syncing menu: ${menuId}`);
      await syncService.syncMenu(menuId);
    } else if (topic === "menus/delete") {
      console.log(`[WEBHOOK-ASYNC] Deleting menu: ${menuId}`);
      await syncService.deleteMenu(menuId);
    }

    // 4. Mark webhook as processed
    await db.webhookLog.update({
      where: { id: logId },
      data: { processed: true },
    });

    console.log(`[WEBHOOK-ASYNC] Successfully processed webhook ${logId}`);
  } catch (error: any) {
    console.error(`[WEBHOOK-ASYNC] Error processing webhook ${logId}:`, error);

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
    console.warn("[WEBHOOK] No HMAC provided");
    return false;
  }

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    console.error("[WEBHOOK] SHOPIFY_API_SECRET not configured");
    return false;
  }

  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const verified = hash === hmac;

  if (!verified) {
    console.warn("[WEBHOOK] Signature mismatch");
    console.warn(`[WEBHOOK] Expected: ${hash}`);
    console.warn(`[WEBHOOK] Received: ${hmac}`);
  }

  return verified;
}
