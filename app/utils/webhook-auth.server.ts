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
 * validation failure (missing headers, unknown shop domain, ...) -> 400; a body
 * that is not JSON -> 400. Nothing is ever let through without a valid HMAC.
 *
 * A route that needs `admin`/`session` must NOT use this: it goes through
 * `authenticate.webhook`.
 */

import { WebhookValidationErrorReason } from "@shopify/shopify-api";
import { validateWebhookRequest } from "~/shopify.server";

export interface VerifiedWebhook {
  shop: string;
  topic: string;
  webhookId: string;
  payload: Record<string, unknown>;
}

export async function verifyWebhookRequest(request: Request): Promise<VerifiedWebhook> {
  if (request.method !== "POST") {
    throw new Response(undefined, { status: 405, statusText: "Method not allowed" });
  }

  const rawBody = await request.text();
  const check = await validateWebhookRequest({ rawBody, rawRequest: request });

  if (!check.valid) {
    if (check.reason === WebhookValidationErrorReason.InvalidHmac) {
      throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
    }
    throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  }

  return { shop: check.domain, topic: check.topic, webhookId: check.webhookId, payload };
}
