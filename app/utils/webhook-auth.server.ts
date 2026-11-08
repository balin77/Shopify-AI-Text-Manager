/**
 * Webhook authentication that survives a failing session refresh.
 *
 * The library's `authenticate.webhook` does two things in this order:
 *   1. validates the signature (HMAC) and answers 405 / 400 / 401 on failure,
 *   2. THEN loads the shop's offline session and, with expiring offline tokens,
 *      refreshes it (`ensureValidOfflineSession`).
 *
 * After an uninstall Shopify has already revoked the tokens, so step 2 can
 * throw for a perfectly valid webhook, and `app/uninstalled` / `shop/redact`
 * answered 500 although the request was authentic and the cleanup needs
 * nothing from the session. This wrapper keeps step 1's refusals as they are
 * and, when anything else goes wrong, VERIFIES THE SIGNATURE ITSELF before it
 * tolerates the error: an unsigned or tampered request is still refused, a
 * signed one carries on with the data taken from the validated headers/body.
 *
 * DEPENDENCY ON THE LIBRARY'S ORDERING: the tolerance is only safe because
 * nothing in `authenticate.webhook` has a side effect before the session step
 * that this wrapper would skip, and because the signature is checked here again
 * independently. If a library update changes either (for example it starts
 * doing work after the HMAC check that callers rely on), re-read
 * node_modules/@shopify/shopify-app-react-router/dist/cjs/server/authenticate/webhooks/authenticate.js.
 * The unit test for this module pins the behaviour.
 *
 * The returned context has NO `session` and NO `admin` (a tolerated failure
 * means there is no usable one); callers of the wrapper must not need them.
 */

import { WebhookValidationErrorReason } from "@shopify/shopify-api";
import { authenticate, validateWebhookRequest } from "~/shopify.server";
import { logger } from "~/utils/logger.server";

export interface TolerantWebhookContext {
  shop: string;
  topic: string;
  webhookId: string;
  payload: Record<string, unknown>;
  /** True when the session step failed and the context was rebuilt from the verified request. */
  tolerated: boolean;
}

export async function authenticateWebhookTolerant(request: Request): Promise<TolerantWebhookContext> {
  // The library consumes the body of what it is given; keep the original unread.
  const forLibrary = request.clone();
  const forVerification = request.clone();

  try {
    const ctx = await authenticate.webhook(forLibrary);
    return {
      shop: ctx.shop,
      topic: ctx.topic as string,
      webhookId: (ctx as { webhookId?: string }).webhookId ?? "",
      payload: ctx.payload as Record<string, unknown>,
      tolerated: false,
    };
  } catch (error) {
    // Only a refusal of the library's own signature step is passed through
    // unchanged; whether anything else may be tolerated is decided below by an
    // independent signature check, never by the shape of the error alone.
    if (request.method !== "POST") throw error;

    const rawBody = await forVerification.text();
    const check = await validateWebhookRequest({ rawBody, rawRequest: forVerification });
    if (!check.valid) {
      if (error instanceof Response) throw error;
      throw new Response(undefined, {
        status: check.reason === WebhookValidationErrorReason.InvalidHmac ? 401 : 400,
        statusText: check.reason === WebhookValidationErrorReason.InvalidHmac ? "Unauthorized" : "Bad Request",
      });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new Response(undefined, { status: 400, statusText: "Bad Request" });
    }

    logger.warn("[webhook-auth] Valid signature, session step failed - continuing without a session", {
      context: "WebhookAuth",
      shop: check.domain,
      topic: check.topic,
      error: error instanceof Error ? error.message : error instanceof Response ? `HTTP ${error.status}` : String(error),
    });

    return {
      shop: check.domain,
      topic: check.topic,
      webhookId: check.webhookId,
      payload,
      tolerated: true,
    };
  }
}
