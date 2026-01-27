/**
 * GDPR Webhook: customers/data_request
 *
 * Shopify sends this webhook when a customer requests their data.
 * We must return all personal data we have stored for this customer.
 *
 * Deadline: 30 days
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { exportCustomerData, logGDPRRequest, type GDPRCustomerDataRequest } from "../services/gdpr.service";
import { verifyAndParseWebhook } from "../utils/webhook-verification";
import { logger } from "~/utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  logger.debug("[GDPR] Received customers/data_request webhook", { context: "GDPR" });

  try {
    // Verify HMAC signature and parse payload
    const { isValid, body: payload, metadata } = await verifyAndParseWebhook<GDPRCustomerDataRequest>(request);

    // Reject requests with invalid signature
    if (!isValid) {
      logger.error("[GDPR] Webhook verification failed - Invalid HMAC signature. This could be an unauthorized request attempt", { context: "GDPR" });

      await logGDPRRequest(
        metadata.shop || 'unknown',
        'data_request',
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
    logger.debug("[GDPR] Request details", { context: "GDPR", shop: payload.shop_domain, customerId: payload.customer.id, customerEmail: payload.customer.email });

    // Export all customer data
    const exportedData = await exportCustomerData(payload);

    // Log for compliance audit trail
    await logGDPRRequest(
      payload.shop_domain,
      'data_request',
      payload.customer.id,
      payload.customer.email,
      exportedData
    );

    // Return the exported data to Shopify
    return json({
      success: true,
      message: 'Customer data exported successfully',
      data: exportedData,
    }, { status: 200 });

  } catch (error) {
    logger.error("[GDPR] Error processing data request", { context: "GDPR", error: error instanceof Error ? error.message : String(error) });

    // Log the error for compliance
    await logGDPRRequest(
      'unknown',
      'data_request',
      undefined,
      undefined,
      undefined,
      error instanceof Error ? error.message : String(error)
    );

    return json({
      success: false,
      error: 'Failed to export customer data',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
};
