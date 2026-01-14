/**
 * API Route: Cancel Billing Subscription
 *
 * Cancels the current active subscription
 */

import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { cancelSubscription, getCurrentSubscription, syncSubscriptionToDatabase } from '~/services/billing.server';

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Get current subscription
    const subscription = await getCurrentSubscription(admin);

    if (!subscription) {
      return json({ error: 'No active subscription found' }, { status: 404 });
    }

    // Cancel the subscription
    await cancelSubscription(admin, subscription.id);

    // Update database to free plan
    await syncSubscriptionToDatabase(session.shop, 'free');

    return json({ success: true, message: 'Subscription cancelled successfully' });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to cancel subscription' },
      { status: 500 }
    );
  }
};
