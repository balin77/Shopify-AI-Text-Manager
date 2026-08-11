/**
 * API Route: Check Billing Status
 *
 * Returns the current subscription status and plan
 */

import type { LoaderFunctionArgs } from "react-router";
import { data as json } from "react-router";
import { authenticate } from '~/shopify.server';
import { getCurrentSubscription, getPlanFromSubscription } from '~/services/billing.server';
import { logger } from '~/utils/logger.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const subscription = await getCurrentSubscription(admin, session.shop);
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
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error('Error checking billing status', { error: error instanceof Error ? error.message : String(error) });
    return json(
      { success: false, error: 'Failed to check billing status.' },
      { status: 500 }
    );
  }
};
