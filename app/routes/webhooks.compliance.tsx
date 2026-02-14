/**
 * Unified GDPR/Privacy Compliance Webhook Dispatcher
 *
 * Shopify sends all compliance webhooks (customers/data_request,
 * customers/redact, shop/redact) to this single endpoint as configured
 * in shopify.app.toml via compliance_topics.
 *
 * This route dispatches to the appropriate GDPR service handler
 * based on the X-Shopify-Topic header.
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  exportCustomerData,
  redactCustomerData,
  redactShopData,
  logGDPRRequest,
  type GDPRCustomerDataRequest,
  type GDPRCustomerRedactRequest,
  type GDPRShopRedactRequest,
} from "../services/gdpr.service";
import { verifyAndParseWebhook } from "../utils/webhook-verification";
import { logger } from "~/utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const topic = request.headers.get("X-Shopify-Topic") || "";
  logger.debug(`[GDPR] Received compliance webhook: ${topic}`, { context: "GDPR" });

  try {
    switch (topic) {
      case "customers/data_request":
        return await handleCustomerDataRequest(request);
      case "customers/redact":
        return await handleCustomerRedact(request);
      case "shop/redact":
        return await handleShopRedact(request);
      default:
        logger.error(`[GDPR] Unknown compliance topic: ${topic}`, { context: "GDPR" });
        return json({ success: false, error: "Unknown topic" }, { status: 400 });
    }
  } catch (error) {
    logger.error("[GDPR] Error processing compliance webhook", {
      context: "GDPR",
      topic,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ success: false, error: "Internal error" }, { status: 500 });
  }
};

async function handleCustomerDataRequest(request: Request) {
  const { isValid, body: payload, metadata } =
    await verifyAndParseWebhook<GDPRCustomerDataRequest>(request);

  if (!isValid) {
    logger.error("[GDPR] customers/data_request verification failed", { context: "GDPR" });
    await logGDPRRequest(metadata.shop || "unknown", "data_request", undefined, undefined, undefined, "Invalid HMAC");
    return json({ success: false, error: "Webhook verification failed" }, { status: 401 });
  }

  if (!payload) {
    return json({ success: false, error: "Invalid payload" }, { status: 400 });
  }

  const exportedData = await exportCustomerData(payload);

  await logGDPRRequest(
    payload.shop_domain,
    "data_request",
    payload.customer.id,
    payload.customer.email,
    exportedData,
  );

  return json({ success: true, message: "Customer data exported successfully" }, { status: 200 });
}

async function handleCustomerRedact(request: Request) {
  const { isValid, body: payload, metadata } =
    await verifyAndParseWebhook<GDPRCustomerRedactRequest>(request);

  if (!isValid) {
    logger.error("[GDPR] customers/redact verification failed", { context: "GDPR" });
    await logGDPRRequest(metadata.shop || "unknown", "customer_redact", undefined, undefined, undefined, "Invalid HMAC");
    return json({ success: false, error: "Webhook verification failed" }, { status: 401 });
  }

  if (!payload) {
    return json({ success: false, error: "Invalid payload" }, { status: 400 });
  }

  await redactCustomerData(payload);

  await logGDPRRequest(
    payload.shop_domain,
    "customer_redact",
    payload.customer.id,
    payload.customer.email,
  );

  return json({ success: true, message: "Customer data deleted successfully" }, { status: 200 });
}

async function handleShopRedact(request: Request) {
  const { isValid, body: payload, metadata } =
    await verifyAndParseWebhook<GDPRShopRedactRequest>(request);

  if (!isValid) {
    logger.error("[GDPR] shop/redact verification failed", { context: "GDPR" });
    await logGDPRRequest(metadata.shop || "unknown", "shop_redact", undefined, undefined, undefined, "Invalid HMAC");
    return json({ success: false, error: "Webhook verification failed" }, { status: 401 });
  }

  if (!payload) {
    return json({ success: false, error: "Invalid payload" }, { status: 400 });
  }

  logger.warn("[GDPR] Shop redaction - will DELETE ALL DATA", {
    context: "GDPR",
    shopDomain: payload.shop_domain,
  });

  await redactShopData(payload);

  await logGDPRRequest(payload.shop_domain, "shop_redact");

  return json({ success: true, message: "Shop data deleted successfully" }, { status: 200 });
}
