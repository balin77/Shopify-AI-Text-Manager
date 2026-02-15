/**
 * Webhook HMAC Verification Utility
 *
 * Verifies that webhooks are actually sent by Shopify using HMAC-SHA256 signatures.
 *
 * Security:
 * - Prevents unauthorized webhook requests
 * - Protects against replay attacks (when combined with timestamp checking)
 * - Ensures data integrity
 *
 * Usage:
 * ```typescript
 * const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
 * const rawBody = await request.text();
 * const isValid = verifyShopifyWebhook(rawBody, hmac);
 * ```
 */

import * as crypto from "crypto";
import { loggers } from '~/utils/logger.server';

/**
 * Verify Shopify webhook signature using HMAC-SHA256
 *
 * @param rawBody - Raw request body as string (must be unparsed)
 * @param hmac - HMAC signature from X-Shopify-Hmac-Sha256 header
 * @returns true if signature is valid, false otherwise
 */
export function verifyShopifyWebhook(
  rawBody: string,
  hmac: string | null
): boolean {
  if (!hmac) {
    loggers.webhook("warn", "No HMAC signature provided");
    return false;
  }

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    loggers.webhook("error", "SHOPIFY_API_SECRET environment variable not configured");
    return false;
  }

  // Calculate expected HMAC
  const calculatedHmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  // Use timing-safe comparison to prevent timing attacks
  // Both buffers must have the same length for timingSafeEqual
  let verified = false;
  try {
    if (calculatedHmac.length === hmac.length) {
      verified = crypto.timingSafeEqual(
        Buffer.from(calculatedHmac),
        Buffer.from(hmac)
      );
    } else {
      // Lengths don't match, so HMACs are definitely different
      verified = false;
    }
  } catch (error) {
    // timingSafeEqual throws if buffers have different lengths
    loggers.webhook("warn", "Error during comparison", { error });
    verified = false;
  }

  if (!verified) {
    loggers.webhook("warn", "HMAC signature mismatch - possible unauthorized request", {
      possibleCauses: ["Request not from Shopify", "Man-in-the-middle attack", "Wrong SHOPIFY_API_SECRET configured"],
      expectedPrefix: calculatedHmac.substring(0, 20) + "...",
      receivedPrefix: hmac.substring(0, 20) + "..."
    });
  }

  return verified;
}

/** Maximum allowed age for a webhook (5 minutes) */
const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Check if a webhook timestamp is within the acceptable tolerance.
 * Rejects webhooks older than WEBHOOK_TIMESTAMP_TOLERANCE_MS to prevent replay attacks.
 *
 * @param triggeredAt - Value of the X-Shopify-Triggered-At header (ISO 8601)
 * @returns true if the timestamp is fresh enough, false otherwise
 */
export function isWebhookTimestampValid(triggeredAt: string | null): boolean {
  if (!triggeredAt) {
    loggers.webhook("warn", "No X-Shopify-Triggered-At header — skipping timestamp check");
    // Allow webhooks without timestamp to avoid breaking existing flows,
    // but log the event for monitoring.
    return true;
  }

  const webhookTime = new Date(triggeredAt).getTime();
  if (Number.isNaN(webhookTime)) {
    loggers.webhook("warn", "Invalid X-Shopify-Triggered-At value", { triggeredAt });
    return false;
  }

  const age = Date.now() - webhookTime;
  if (age > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    loggers.webhook("warn", "Webhook too old — possible replay attack", {
      triggeredAt,
      ageMs: age,
      toleranceMs: WEBHOOK_TIMESTAMP_TOLERANCE_MS,
    });
    return false;
  }

  // Also reject timestamps significantly in the future (clock skew > 1 min)
  if (age < -60_000) {
    loggers.webhook("warn", "Webhook timestamp is in the future", { triggeredAt, ageMs: age });
    return false;
  }

  return true;
}

/**
 * Extract webhook metadata from request headers
 *
 * @param request - Remix request object
 * @returns Webhook metadata
 */
export function extractWebhookHeaders(request: Request): {
  hmac: string | null;
  shop: string | null;
  topic: string | null;
  webhookId: string | null;
  triggeredAt: string | null;
} {
  return {
    hmac: request.headers.get("X-Shopify-Hmac-Sha256"),
    shop: request.headers.get("X-Shopify-Shop-Domain"),
    topic: request.headers.get("X-Shopify-Topic"),
    webhookId: request.headers.get("X-Shopify-Webhook-Id"),
    triggeredAt: request.headers.get("X-Shopify-Triggered-At"),
  };
}

/**
 * Verify webhook and extract body in one call
 *
 * @param request - Remix request object
 * @returns Object with verification result, body, and metadata
 */
export async function verifyAndParseWebhook<T = any>(
  request: Request
): Promise<{
  isValid: boolean;
  body: T | null;
  rawBody: string;
  metadata: {
    hmac: string | null;
    shop: string | null;
    topic: string | null;
    webhookId: string | null;
    triggeredAt: string | null;
  };
}> {
  const metadata = extractWebhookHeaders(request);
  const rawBody = await request.text();
  const hmacValid = verifyShopifyWebhook(rawBody, metadata.hmac);
  const timestampValid = isWebhookTimestampValid(metadata.triggeredAt);
  const isValid = hmacValid && timestampValid;

  let body: T | null = null;
  if (isValid && rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      loggers.webhook("error", "Failed to parse JSON body", { error });
    }
  }

  return {
    isValid,
    body,
    rawBody,
    metadata,
  };
}
