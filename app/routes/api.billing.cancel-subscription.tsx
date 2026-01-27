/**
 * API Route: Cancel Billing Subscription
 *
 * Cancels the current active subscription
 *
 * IMPORTANT: This operation involves external API calls (Shopify) and DB updates.
 * We prioritize DB update success with retry logic since Shopify cancellation
 * cannot be rolled back.
 */

import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { cancelSubscription, getCurrentSubscription, syncSubscriptionToDatabase } from '~/services/billing.server';

const MAX_DB_RETRIES = 3;
const RETRY_DELAY_MS = 500;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // In development mode, directly update the database without Shopify Billing API
    // This is useful for Custom Apps which cannot use the Billing API
    // APP_ENV allows this behavior even when NODE_ENV=production
    if (process.env.NODE_ENV === 'development' || process.env.APP_ENV === 'development') {
      await syncSubscriptionToDatabase(session.shop, 'free');
      return json({
        success: true,
        directUpdate: true,
        message: 'Plan changed to free (development mode)',
      });
    }

    // Get current subscription
    const subscription = await getCurrentSubscription(admin);

    if (!subscription) {
      return json({ error: 'No active subscription found' }, { status: 404 });
    }

    // Cancel the subscription via Shopify API (cannot be rolled back)
    await cancelSubscription(admin, subscription.id);

    // Update database to free plan with retry logic
    // This ensures DB state is consistent even if first attempt fails
    let dbUpdateSuccess = false;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt++) {
      try {
        await syncSubscriptionToDatabase(session.shop, 'free');
        dbUpdateSuccess = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`[Billing] DB update attempt ${attempt}/${MAX_DB_RETRIES} failed:`, lastError.message);

        if (attempt < MAX_DB_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt); // Exponential backoff
        }
      }
    }

    if (!dbUpdateSuccess) {
      // Critical: Shopify subscription cancelled but DB not updated
      console.error('[Billing] CRITICAL: Shopify subscription cancelled but DB update failed after all retries');
      return json(
        {
          error: 'Subscription cancelled but database update failed. Please contact support.',
          shopifyCancelled: true,
          dbUpdateFailed: true
        },
        { status: 500 }
      );
    }

    return json({ success: true, message: 'Subscription cancelled successfully' });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to cancel subscription' },
      { status: 500 }
    );
  }
};
