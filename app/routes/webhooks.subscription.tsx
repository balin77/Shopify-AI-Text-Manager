/**
 * Shopify Subscription Webhooks Handler
 *
 * Handles subscription-related webhooks from Shopify:
 * - app_subscriptions/update
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from '~/shopify.server';
import { checkAndSyncSubscription } from '~/services/billing.server';
import { logger } from '~/utils/logger.server';

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, admin } = await authenticate.webhook(request);

  if (!admin) {
    // Authenticate.webhook validates the webhook request
    // and returns session + admin if valid
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
    // Review LOW ("returns 200 on internal error"): intentional. A non-2xx
    // makes Shopify retry and, after repeated failures, DISABLE the webhook
    // subscription entirely — far worse than one missed event. Subscription
    // state is not authoritative here anyway: it is reconciled on every
    // afterAuth and by the background scheduler's checkAndSyncSubscription,
    // so a dropped event is self-healing. We log loudly and ack 200.
  }

  return new Response('Webhook processed', { status: 200 });
};
