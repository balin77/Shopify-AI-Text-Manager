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

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log('📨 [GDPR] Received shop/redact webhook');

  try {
    // Verify HMAC signature and parse payload
    const { isValid, body: payload, metadata } = await verifyAndParseWebhook<GDPRShopRedactRequest>(request);

    // Reject requests with invalid signature
    if (!isValid) {
      console.error('🚫 [GDPR] Webhook verification failed - Invalid HMAC signature');
      console.error('🚫 [GDPR] This could be an unauthorized request attempt');
      console.error('🚫 [GDPR] CRITICAL: Shop deletion prevented by security check');

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
      console.error('❌ [GDPR] Failed to parse webhook payload');
      return json({
        success: false,
        error: 'Invalid payload',
      }, { status: 400 });
    }

    console.log('✅ [GDPR] Webhook signature verified');

    // Parse Shopify's GDPR request

    console.log('📋 [GDPR] Shop redaction request for:', payload.shop_domain);
    console.log('⚠️  [GDPR] WARNING: This will DELETE ALL DATA for this shop!');

    // Delete ALL shop data
    await redactShopData(payload);

    // Log for compliance audit trail
    await logGDPRRequest(
      payload.shop_domain,
      'shop_redact'
    );

    console.log('✅ [GDPR] Shop data redaction completed successfully');

    return json({
      success: true,
      message: 'Shop data deleted successfully',
    }, { status: 200 });

  } catch (error) {
    console.error('❌ [GDPR] Error processing shop redaction:', error);

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
