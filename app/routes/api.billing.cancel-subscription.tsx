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
import { resolveDevPlanMode, setDevForcedPlan } from '~/services/dev-plan-override.server';
import { logger } from '~/utils/logger.server';

const MAX_DB_RETRIES = 3;
const RETRY_DELAY_MS = 500;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Custom-app build only: no Billing API exists to cancel. Force the plan
    // back to 'free'; checkAndSyncSubscription then reconciles the cache like a
    // real downgrade. Hard-gated via resolveDevPlanMode() — dead in the public
    // App-Store build.
    if (resolveDevPlanMode(session.shop) === 'override') {
      await setDevForcedPlan(session.shop, 'free');
      logger.warn('[Billing] Override mode — downgraded to free without Shopify (custom-app build)', {
        shop: session.shop,
      });
      return json({ success: true, message: 'Subscription cancelled (dev override)' });
    }

    // Get current subscription
    const subscription = await getCurrentSubscription(admin);

    if (!subscription) {
      return json({ success: false, error: 'No active subscription found' }, { status: 404 });
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
        logger.error(`[Billing] DB update attempt ${attempt}/${MAX_DB_RETRIES} failed`, { error: lastError.message });

        if (attempt < MAX_DB_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt); // Exponential backoff
        }
      }
    }

    if (!dbUpdateSuccess) {
      // Critical: Shopify subscription cancelled but DB not updated
      logger.error('[Billing] CRITICAL: Shopify subscription cancelled but DB update failed after all retries');
      return json(
        {
          success: false,
          error: 'Subscription cancelled but database update failed. Please contact support.',
          shopifyCancelled: true,
          dbUpdateFailed: true
        },
        { status: 500 }
      );
    }

    return json({ success: true, message: 'Subscription cancelled successfully' });
  } catch (error) {
    logger.error('Error cancelling subscription', { error: error instanceof Error ? error.message : String(error) });
    return json(
      { success: false, error: 'Failed to cancel subscription.' },
      { status: 500 }
    );
  }
};
