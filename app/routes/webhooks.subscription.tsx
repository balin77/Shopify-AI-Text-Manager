/**
 * Shopify Subscription Webhooks Handler
 *
 * Handles subscription-related webhooks from Shopify:
 * - app_subscriptions/update
 */

import type { ActionFunctionArgs } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { checkAndSyncSubscription } from '~/services/billing.server';

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, admin } = await authenticate.webhook(request);

  if (!admin) {
    // Authenticate.webhook validates the webhook request
    // and returns session + admin if valid
    return new Response('Webhook processed', { status: 200 });
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    switch (topic) {
      case 'APP_SUBSCRIPTIONS_UPDATE':
        // Sync subscription status to database
        await checkAndSyncSubscription(admin, shop);
        console.log(`Subscription updated for ${shop}`);
        break;

      default:
        console.log(`Unhandled webhook topic: ${topic}`);
    }
  } catch (error) {
    console.error(`Error processing ${topic} webhook:`, error);
    // Still return 200 to prevent Shopify from retrying
  }

  return new Response('Webhook processed', { status: 200 });
};
