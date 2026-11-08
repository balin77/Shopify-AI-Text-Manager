/**
 * Signature-only webhook verification for webhooks that need no session.
 *
 * The library's `authenticate.webhook` validates the signature (HMAC) and THEN
 * loads and, with expiring offline tokens, refreshes the shop's offline
 * session. After an uninstall Shopify has already revoked the tokens, so that
 * refresh throws and `app/uninstalled` / `shop/redact` answered 500 for a
 * perfectly authentic request; on `customers/*` of a live shop it is a refresh
 * outside the single-flight of offline-admin.server.ts. The routes using this
 * module read only `shop`, `topic`, `webhookId` and `payload` from the context
 * (never `session` or `admin`), so they verify the signature directly and never
 * touch the session at all. That also removes any dependency on the library's
 * internal ordering.
 *
 * Refusals mirror the library: non-POST -> 405; invalid HMAC -> 401; any other
 * validation failure (a required header missing, e.g. the HMAC, topic or shop domain) -> 400; a body
 * that is not JSON -> 400. Nothing is ever let through without a valid HMAC.
 *
 * A route that needs `admin`/`session` must NOT use this: it goes through
 * `authenticate.webhook`.
 */

import { WebhookValidationErrorReason } from "@shopify/shopify-api";
import { validateWebhookRequest } from "~/shopify.server";
import { logger } from "~/utils/logger.server";

export interface VerifiedWebhook {
  shop: string;
  topic: string;
  webhookId: string;
  payload: Record<string, unknown>;
}

// One warn line per refusal: reason code and topic header only - never the
// HMAC, the body or the secret.
function refuse(status: number, statusText: string, reason: string, request: Request): never {
  logger.warn("[webhook-auth] Webhook refused", {
    context: "WebhookAuth",
    status,
    reason,
    topic: request.headers.get("x-shopify-topic") ?? undefined,
  });
  throw new Response(undefined, { status, statusText });
}

export async function verifyWebhookRequest(request: Request): Promise<VerifiedWebhook> {
  if (request.method !== "POST") {
    refuse(405, "Method not allowed", "method_not_allowed", request);
  }

  const rawBody = await request.text();
  const check = await validateWebhookRequest({ rawBody, rawRequest: request });

  if (!check.valid) {
    if (check.reason === WebhookValidationErrorReason.InvalidHmac) {
      refuse(401, "Unauthorized", "invalid_hmac", request);
    }
    refuse(400, "Bad Request", String(check.reason), request);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    refuse(400, "Bad Request", "body_not_json", request);
  }

  return { shop: check.domain, topic: check.topic, webhookId: check.webhookId, payload };
}
