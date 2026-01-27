/**
 * Shopify Subscription Webhooks Handler
 *
 * Handles subscription-related webhooks from Shopify:
 * - app_subscriptions/update
 */

import type { ActionFunctionArgs } from '@remix-run/node';
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
    // Still return 200 to prevent Shopify from retrying
  }

  return new Response('Webhook processed', { status: 200 });
};
