/**
 * Shopify Subscription Webhooks Handler
 *
 * Handles subscription-related webhooks from Shopify:
 * - app_subscriptions/update
 *
 * This route needs an Admin client (checkAndSyncSubscription), so it still goes
 * through the library's authenticate.webhook for the happy case. But the
 * library refreshes the offline token AFTER the HMAC check and fails the
 * request when that refresh fails (dead or expiring token), which answered 500
 * for an authentic webhook. So the signature is verified FIRST by the app itself
 * (verifyWebhookRequest, on a clone: bad signature -> 401). A library failure
 * after that is answered 200 with a warning ONLY when it is terminal for the
 * shop (connection blocked, or the stored offline token is known dead: a retry
 * by Shopify cannot help); any other failure is transient and answers 500 so
 * Shopify redelivers. A deferred event is re-synced by afterAuth (every
 * sign-in / token exchange), the settings loader, the billing callback and the
 * app.tsx loader after `?billing=success` (the scheduler does not sync it).
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from '~/shopify.server';
import { checkAndSyncSubscription } from '~/services/billing.server';
import { verifyWebhookRequest } from '~/utils/webhook-auth.server';
import { getConnectionBlock, isShopConnectionBlockedError, recordWebhookSeen } from '~/utils/shop-connection-state.server';
import { getOfflineAdmin } from '~/utils/offline-admin.server';
import { logger } from '~/utils/logger.server';

/** Is a library failure terminal for this shop (a redelivery cannot succeed)? */
async function failureIsTerminal(shop: string): Promise<boolean> {
  try {
    if (await getConnectionBlock(shop)) return true;
  } catch { /* unknown: not terminal */ }
  try {
    await getOfflineAdmin(shop);
    return false; // our own door works: the library failure looks transient
  } catch (e) {
    // getOfflineAdmin throws the quiet blocked error for the failure that BLOCKS the shop:
    // the first delivery of a newly blocked shop is terminal too (ack, not 500).
    if (isShopConnectionBlockedError(e)) return true;
    const err = e as { code?: unknown; permanent?: unknown };
    return err?.code === "OFFLINE_ADMIN_UNAVAILABLE" && err.permanent === true;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  // Signature first, on a clone so the library can still read the body. A
  // refusal (401 / 400 / 405) is thrown as a Response and passes through.
  const verified = await verifyWebhookRequest(request.clone());
  await recordWebhookSeen(verified.shop, request.headers.get("x-shopify-triggered-at"), { reinstallEvidence: false });

  let ctx: Awaited<ReturnType<typeof authenticate.webhook>>;
  try {
    ctx = await authenticate.webhook(request);
  } catch (error) {
    // The signature is valid: whatever failed is the library's session lookup
    // or token refresh. Terminal for the shop: ack (a redelivery cannot help).
    // Otherwise let Shopify retry.
    if (!(await failureIsTerminal(verified.shop))) {
      logger.warn("Subscription webhook: session refresh failed (transient), answering 500 so Shopify retries", {
        context: "Webhook",
        shop: verified.shop,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error instanceof Response ? error : new Response("Session refresh failed", { status: 500 });
    }
    logger.warn("Subscription webhook: session refresh failed after a valid signature, sync deferred to the next app open", {
      context: "Webhook",
      topic: verified.topic,
      shop: verified.shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response('Webhook processed', { status: 200 });
  }

  const { topic, shop, admin } = ctx;

  if (!admin) {
    return new Response('Webhook processed', { status: 200 });
  }

  logger.debug("Received subscription webhook", { context: "Webhook", topic, shop });

  try {
    switch (topic) {
      case 'APP_SUBSCRIPTIONS_UPDATE':
        // Sync subscription status to database
        await checkAndSyncSubscription(admin, shop);
        logger.debug("Subscription updated", { context: "Webhook", shop });
        break;

      default:
        logger.warn("Unhandled webhook topic", { context: "Webhook", topic });
    }
  } catch (error) {
    logger.error("Error processing subscription webhook", { context: "Webhook", topic, error: error instanceof Error ? error.message : String(error) });
    // Intentional 200: a non-2xx makes Shopify retry and eventually DISABLE the
    // webhook subscription, far worse than one missed event. The subscription
    // state is re-synced by afterAuth and the settings loader (see the header).
  }

  return new Response('Webhook processed', { status: 200 });
};
