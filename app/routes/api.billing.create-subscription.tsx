/**
 * API Route: Create Billing Subscription
 *
 * Creates a new subscription for the specified plan
 * In development mode, directly updates the database without Shopify Billing API
 */

import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { createSubscription, syncSubscriptionToDatabase } from '~/services/billing.server';
import type { BillingPlan } from '~/config/billing';
import { isPaidPlan } from '~/config/billing';

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { plan } = body as { plan: BillingPlan };

    if (!plan || !isPaidPlan(plan)) {
      return json({ error: 'Invalid plan specified' }, { status: 400 });
    }

    // In development mode, directly update the database without Shopify Billing API
    // This is useful for Custom Apps which cannot use the Billing API
    // APP_ENV allows this behavior even when NODE_ENV=production
    if (process.env.NODE_ENV === 'development' || process.env.APP_ENV === 'development') {
      await syncSubscriptionToDatabase(session.shop, plan);
      return json({
        success: true,
        directUpdate: true,
        message: `Plan changed to ${plan} (development mode)`,
      });
    }

    // Create return URL (where user is redirected after confirming payment)
    const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/billing/callback?plan=${plan}`;

    const result = await createSubscription(admin, session, plan, returnUrl);

    return json({
      success: true,
      confirmationUrl: result.confirmationUrl,
      subscriptionId: result.subscriptionId,
    });
  } catch (error) {
    console.error('Error creating subscription:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to create subscription' },
      { status: 500 }
    );
  }
};
