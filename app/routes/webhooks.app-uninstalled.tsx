import type { ActionFunctionArgs } from "react-router";
import { verifyWebhookRequest } from "~/utils/webhook-auth.server";
import { logger } from "~/utils/logger.server";
import { markShopUninstalled } from "~/services/shop-uninstall.server";

/**
 * APP_UNINSTALLED webhook handler
 *
 * Fires immediately when a shop uninstalls the app. The cleanup itself lives in
 * markShopUninstalled (shop-uninstall.server.ts), shared with every other path
 * that marks a shop as uninstalled.
 *
 * Full data deletion (products, translations, etc.) is handled by the
 * SHOP_REDACT webhook, which Shopify sends 48 hours after uninstall.
 *
 * Verified by signature only (verifyWebhookRequest): the cleanup needs no
 * session, and the library's token refresh fails once Shopify has revoked the
 * tokens.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await verifyWebhookRequest(request);

  logger.info(`[APP_UNINSTALLED] Received for shop: ${shop}`);
  await markShopUninstalled(shop, { source: "webhook" });

  return new Response("OK", { status: 200 });
};
