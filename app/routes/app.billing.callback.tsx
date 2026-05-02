/**
 * Billing Callback Route
 *
 * Handles the redirect after merchant confirms or declines a subscription.
 * Verifies the actual subscription status before deciding the final redirect
 * so that a declined payment never lands on a "success" screen.
 */

import type { LoaderFunctionArgs } from '@remix-run/node';
import { redirect } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { checkAndSyncSubscription } from '~/services/billing.server';
import { logger } from '~/utils/logger.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return redirect('/app');
  }

  const url = new URL(request.url);
  const plan = url.searchParams.get('plan') || 'unknown';

  try {
    // Sync with Shopify and get the now-active plan (returns 'free' when declined).
    const activePlan = await checkAndSyncSubscription(admin, session.shop);

    // If the active plan doesn't match what the merchant was trying to subscribe to,
    // the request was declined (or is still pending). Send them back to settings
    // with a declined status so the UI can prompt them to try again.
    if (activePlan === 'free' || activePlan !== plan) {
      logger.info('[Billing] Subscription not activated after callback', {
        expected: plan,
        active: activePlan,
        shop: session.shop,
      });
      return redirect(`/app/settings?billing=declined&plan=${plan}`);
    }

    return redirect(`/app/settings?billing=success&plan=${plan}`);
  } catch (error) {
    logger.error('Error in billing callback', { error: error instanceof Error ? error.message : String(error) });
    return redirect('/app/settings?billing=error');
  }
};
