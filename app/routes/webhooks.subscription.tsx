/**
 * Shopify Subscription Webhooks Handler
 *
 * Handles subscription-related webhooks from Shopify:
 * - app_subscriptions/update
 *
 * This route needs an Admin client (checkAndSyncSubscription), so it still goes
 * through the library's authenticate.webhook for the happy case. But the
 * library refreshes the offline token AFTER the HMAC check and fails the
 * request when that refresh fails (dead or expiring token), which answered 500
 * for an authentic webhook. So the signature is verified FIRST by the app itself
 * (verifyWebhookRequest, on a clone: bad signature -> 401), and a library
 * failure after that is answered 200 with a warning: the subscription state is
 * re-synced by afterAuth (every sign-in / token exchange) and by the settings
 * page loader, so a deferred event is self-healing.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from '~/shopify.server';
import { checkAndSyncSubscription } from '~/services/billing.server';
import { verifyWebhookRequest } from '~/utils/webhook-auth.server';
import { recordWebhookSeen } from '~/utils/shop-connection-state.server';
import { logger } from '~/utils/logger.server';

export const action = async ({ request }: ActionFunctionArgs) => {
  // Signature first, on a clone so the library can still read the body. A
  // refusal (401 / 400 / 405) is thrown as a Response and passes through.
  const verified = await verifyWebhookRequest(request.clone());
  await recordWebhookSeen(verified.shop, request.headers.get("x-shopify-triggered-at"));

  let ctx: Awaited<ReturnType<typeof authenticate.webhook>>;
  try {
    ctx = await authenticate.webhook(request);
  } catch (error) {
    // The signature is valid: whatever failed is the library's session lookup
    // or token refresh. Never answer an error for that.
    logger.warn("Subscription webhook: session refresh failed after a valid signature, sync deferred to the next app open", {
      context: "Webhook",
      topic: verified.topic,
      shop: verified.shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response('Webhook processed', { status: 200 });
  }

  const { topic, shop, admin } = ctx;

  if (!admin) {
    return new Response('Webhook processed', { status: 200 });
  }

  logger.debug("Received subscription webhook", { context: "Webhook", topic, shop });

  try {
    switch (topic) {
      case 'APP_SUBSCRIPTIONS_UPDATE':
        // Sync subscription status to database
        await checkAndSyncSubscription(admin, shop);
        logger.debug("Subscription updated", { context: "Webhook", shop });
        break;

      default:
        logger.warn("Unhandled webhook topic", { context: "Webhook", topic });
    }
  } catch (error) {
    logger.error("Error processing subscription webhook", { context: "Webhook", topic, error: error instanceof Error ? error.message : String(error) });
    // Intentional 200: a non-2xx makes Shopify retry and eventually DISABLE the
    // webhook subscription, far worse than one missed event. The subscription
    // state is re-synced by afterAuth and the settings loader (see the header).
  }

  return new Response('Webhook processed', { status: 200 });
};
