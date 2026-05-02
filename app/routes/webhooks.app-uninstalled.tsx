import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { db } from "~/db.server";
import { syncScheduler } from "~/services/sync-scheduler.service";
import { logger } from "~/utils/logger.server";

/**
 * APP_UNINSTALLED webhook handler
 *
 * Fires immediately when a shop uninstalls the app. Cleans up the session and
 * stops the background sync scheduler so subsequent reinstalls don't inherit
 * a stale, revoked admin token.
 *
 * Full data deletion (products, translations, etc.) is handled by the
 * SHOP_REDACT webhook, which Shopify sends 48 hours after uninstall.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);

  logger.info(`[APP_UNINSTALLED] Received for shop: ${shop}`);

  // Stop background sync immediately — the access token is now revoked.
  if (syncScheduler.isShopActive(shop)) {
    syncScheduler.stopSyncForShop(shop);
    logger.info(`[APP_UNINSTALLED] Stopped sync scheduler for ${shop}`);
  }

  // Delete sessions so a reinstall always starts with a clean OAuth grant.
  try {
    const deleted = await db.session.deleteMany({ where: { shop } });
    logger.info(`[APP_UNINSTALLED] Deleted ${deleted.count} session(s) for ${shop}`);
  } catch (error) {
    logger.error(
      `[APP_UNINSTALLED] Failed to delete sessions for ${shop}:`,
      error instanceof Error ? error.message : String(error),
    );
  }

  return new Response("OK", { status: 200 });
};
