/**
 * API Route: Check Billing Status
 *
 * Returns the current subscription status and plan
 */

import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { getCurrentSubscription, getPlanFromSubscription } from '~/services/billing.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const subscription = await getCurrentSubscription(admin);
    const plan = getPlanFromSubscription(subscription);

    return json({
      success: true,
      plan,
      subscription: subscription
        ? {
            id: subscription.id,
            name: subscription.name,
            status: subscription.status,
            test: subscription.test,
            currentPeriodEnd: subscription.currentPeriodEnd,
            trialDays: subscription.trialDays,
          }
        : null,
    });
  } catch (error) {
    console.error('Error checking billing status:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to check billing status' },
      { status: 500 }
    );
  }
};
