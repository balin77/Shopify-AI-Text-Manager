/**
 * API Route: Create Billing Subscription
 *
 * Creates a new subscription for the specified plan.
 * Always goes through the Shopify Billing API (appSubscriptionCreate).
 * Development/partner test stores automatically get test charges via the
 * Shopify `test` flag (see billing.server.ts), never a DB-direct write.
 */

import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { createSubscription, getCurrentSubscription } from '~/services/billing.server';
import type { BillingPlan } from '~/config/billing';
import { isPaidPlan } from '~/config/billing';
import { resolveDevPlanMode, setDevForcedPlan } from '~/services/dev-plan-override.server';
import { logger } from '~/utils/logger.server';

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { plan } = body as { plan: BillingPlan };

    if (!plan || !isPaidPlan(plan)) {
      return json({ success: false, error: 'Invalid plan specified' }, { status: 400 });
    }

    // Custom-app build only: the custom-app distribution has NO Billing API,
    // so calling createSubscription would fail. Persist the forced plan and
    // route through the SAME billing callback URL the real flow uses, so the
    // post-billing UI path is exercised end-to-end. resolveDevPlanMode() is
    // hard-gated (dev client_id + APP_ENV !== 'production') — dead in the
    // public App-Store build.
    if (resolveDevPlanMode(session.shop) === 'override') {
      await setDevForcedPlan(session.shop, plan);
      logger.warn('[Billing] Override mode — plan set without Shopify (custom-app build)', {
        plan,
        shop: session.shop,
      });
      const returnUrl = `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing/callback?plan=${plan}`;
      return json({ success: true, confirmationUrl: returnUrl, subscriptionId: null });
    }

    // Check for an existing paid subscription to enable atomic replacement (paid→paid switch).
    const existingSubscription = await getCurrentSubscription(admin);
    const hasExistingSubscription = existingSubscription !== null && existingSubscription.status === 'ACTIVE';

    logger.info('[Billing] Creating subscription', {
      plan,
      shop: session.shop,
      hasExistingSubscription,
      existingPlan: existingSubscription?.name ?? 'none',
    });

    // Route through the billing callback so it can verify the subscription status
    // before deciding whether to redirect to success or declined.
    const returnUrl = `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing/callback?plan=${plan}`;

    const result = await createSubscription(admin, session, plan, returnUrl, hasExistingSubscription);

    return json({
      success: true,
      confirmationUrl: result.confirmationUrl,
      subscriptionId: result.subscriptionId,
    });
  } catch (error) {
    logger.error('Error creating subscription', { error: error instanceof Error ? error.message : String(error) });
    return json(
      { success: false, error: 'Failed to create subscription.' },
      { status: 500 }
    );
  }
};
