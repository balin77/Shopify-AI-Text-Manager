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
import { exportCustomerData, logGDPRRequest, type GDPRCustomerDataRequest } from "../../services/gdpr.service";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log('📨 [GDPR] Received customers/data_request webhook');

  try {
    // Parse Shopify's GDPR request
    const payload: GDPRCustomerDataRequest = await request.json();

    console.log('📋 [GDPR] Request details:', {
      shop: payload.shop_domain,
      customerId: payload.customer.id,
      customerEmail: payload.customer.email,
    });

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
    console.error('❌ [GDPR] Error processing data request:', error);

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
