/**
 * Billing Callback Route
 *
 * Handles the redirect after merchant confirms subscription payment
 */

import type { LoaderFunctionArgs } from '@remix-run/node';
import { redirect } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { checkAndSyncSubscription } from '~/services/billing.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return redirect('/app');
  }

  const url = new URL(request.url);
  const plan = url.searchParams.get('plan');
  const charge_id = url.searchParams.get('charge_id');

  try {
    // Sync the subscription to verify it's active and update database
    await checkAndSyncSubscription(admin, session.shop);

    // Redirect to settings page with success message
    return redirect('/app/settings?billing=success&plan=' + (plan || 'unknown'));
  } catch (error) {
    console.error('Error in billing callback:', error);
    return redirect('/app/settings?billing=error');
  }
};
