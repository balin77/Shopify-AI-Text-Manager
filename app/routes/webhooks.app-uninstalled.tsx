import type { ActionFunctionArgs } from "react-router";
import { verifyWebhookRequest } from "~/utils/webhook-auth.server";
import { logger } from "~/utils/logger.server";
import { db } from "~/db.server";
import { markShopUninstalled } from "~/services/shop-uninstall.server";
import {
  isStaleUninstall,
  isUninstallTopic,
  payloadMatchesShop,
} from "~/services/uninstall-webhook-guard.shared";

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
 *
 * Beyond the signature: the topic must be APP_UNINSTALLED and the payload must
 * name the signed shop, or nothing is touched. Those refusals answer 200 with a
 * warn line: the request is authentic, so a 4xx would only make Shopify retry
 * for 48 h something that can never succeed. A delivery older than the shop's
 * last sign-in (a late redelivery after a quick reinstall) is skipped the same
 * way, with one info line.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await verifyWebhookRequest(request);

  if (!isUninstallTopic(topic)) {
    logger.warn(`[APP_UNINSTALLED] Ignored: topic "${String(topic).slice(0, 60)}" is not APP_UNINSTALLED (shop ${shop})`);
    return new Response("OK", { status: 200 });
  }
  if (!payloadMatchesShop(payload, shop)) {
    logger.warn(`[APP_UNINSTALLED] Ignored: payload shop does not match the signed shop ${shop}`);
    return new Response("OK", { status: 200 });
  }

  try {
    const state = await db.shopInstallState.findUnique({ where: { shop }, select: { lastAuthAt: true } });
    const triggeredAt = request.headers.get("x-shopify-triggered-at");
    if (isStaleUninstall(triggeredAt, state?.lastAuthAt)) {
      logger.info(
        `[APP_UNINSTALLED] Skipped for ${shop}: delivery (triggered ${triggeredAt}) is older than the last sign-in`,
      );
      return new Response("OK", { status: 200 });
    }
  } catch (error) {
    // Unknown sign-in time: current behaviour (mark uninstalled).
    logger.warn(
      `[APP_UNINSTALLED] Could not read the last sign-in of ${shop}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  logger.info(`[APP_UNINSTALLED] Received for shop: ${shop}`);
  await markShopUninstalled(shop, { source: "webhook" });

  return new Response("OK", { status: 200 });
};
