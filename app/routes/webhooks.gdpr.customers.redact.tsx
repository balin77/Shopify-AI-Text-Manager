/**
 * GDPR Webhook: customers/redact
 *
 * Shopify sends this webhook when a customer requests deletion of their data.
 * We must delete all personal data we have stored for this customer.
 *
 * Deadline: 30 days (but should be done immediately)
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { redactCustomerData, logGDPRRequest, type GDPRCustomerRedactRequest } from "../services/gdpr.service";
import { verifyAndParseWebhook } from "../utils/webhook-verification";
import { logger } from "~/utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  logger.debug("[GDPR] Received customers/redact webhook", { context: "GDPR" });

  try {
    // Verify HMAC signature and parse payload
    const { isValid, body: payload, metadata } = await verifyAndParseWebhook<GDPRCustomerRedactRequest>(request);

    // Reject requests with invalid signature
    if (!isValid) {
      logger.error("[GDPR] Webhook verification failed - Invalid HMAC signature. This could be an unauthorized request attempt", { context: "GDPR" });

      await logGDPRRequest(
        metadata.shop || 'unknown',
        'customer_redact',
        undefined,
        undefined,
        undefined,
        'Webhook verification failed: Invalid HMAC signature'
      );

      return json({
        success: false,
        error: 'Webhook verification failed',
      }, { status: 401 });
    }

    if (!payload) {
      logger.error("[GDPR] Failed to parse webhook payload", { context: "GDPR" });
      return json({
        success: false,
        error: 'Invalid payload',
      }, { status: 400 });
    }

    logger.debug("[GDPR] Webhook signature verified", { context: "GDPR" });

    // Parse Shopify's GDPR request
    logger.debug("[GDPR] Redaction request details", { context: "GDPR", shop: payload.shop_domain, customerId: payload.customer.id, customerEmail: payload.customer.email });

    // Delete all customer data
    await redactCustomerData(payload);

    // Log for compliance audit trail
    await logGDPRRequest(
      payload.shop_domain,
      'customer_redact',
      payload.customer.id,
      payload.customer.email
    );

    logger.debug("[GDPR] Customer data redaction completed successfully", { context: "GDPR" });

    return json({
      success: true,
      message: 'Customer data deleted successfully',
    }, { status: 200 });

  } catch (error) {
    logger.error("[GDPR] Error processing customer redaction", { context: "GDPR", error: error instanceof Error ? error.message : String(error) });

    // Log the error for compliance
    await logGDPRRequest(
      'unknown',
      'customer_redact',
      undefined,
      undefined,
      undefined,
      error instanceof Error ? error.message : String(error)
    );

    return json({
      success: false,
      error: 'Failed to delete customer data',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
};
