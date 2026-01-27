/**
 * GDPR Webhook: shop/redact
 *
 * Shopify sends this webhook when a shop uninstalls the app.
 * We must delete ALL data we have stored for this shop.
 *
 * Deadline: 48 hours (but should be done immediately)
 *
 * IMPORTANT: This deletes EVERYTHING - sessions, products, translations, settings, etc.
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { redactShopData, logGDPRRequest, type GDPRShopRedactRequest } from "../services/gdpr.service";
import { verifyAndParseWebhook } from "../utils/webhook-verification";
import { logger } from "~/utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  logger.debug("[GDPR] Received shop/redact webhook", { context: "GDPR" });

  try {
    // Verify HMAC signature and parse payload
    const { isValid, body: payload, metadata } = await verifyAndParseWebhook<GDPRShopRedactRequest>(request);

    // Reject requests with invalid signature
    if (!isValid) {
      logger.error("[GDPR] Webhook verification failed - Invalid HMAC signature. CRITICAL: Shop deletion prevented by security check", { context: "GDPR" });

      await logGDPRRequest(
        metadata.shop || 'unknown',
        'shop_redact',
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
    logger.warn("[GDPR] Shop redaction request - WARNING: This will DELETE ALL DATA for this shop!", { context: "GDPR", shopDomain: payload.shop_domain });

    // Delete ALL shop data
    await redactShopData(payload);

    // Log for compliance audit trail
    await logGDPRRequest(
      payload.shop_domain,
      'shop_redact'
    );

    logger.debug("[GDPR] Shop data redaction completed successfully", { context: "GDPR" });

    return json({
      success: true,
      message: 'Shop data deleted successfully',
    }, { status: 200 });

  } catch (error) {
    logger.error("[GDPR] Error processing shop redaction", { context: "GDPR", error: error instanceof Error ? error.message : String(error) });

    // Log the error for compliance
    await logGDPRRequest(
      'unknown',
      'shop_redact',
      undefined,
      undefined,
      undefined,
      error instanceof Error ? error.message : String(error)
    );

    return json({
      success: false,
      error: 'Failed to delete shop data',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
};
