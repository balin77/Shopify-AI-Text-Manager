/**
 * Unified GDPR/Privacy Compliance Webhook Dispatcher
 *
 * Shopify sends all compliance webhooks (customers/data_request,
 * customers/redact, shop/redact) to this single endpoint as configured
 * in shopify.app.toml via compliance_topics.
 *
 * Uses Shopify's built-in authenticate.webhook() for HMAC verification.
 * This automatically returns 401 for invalid HMAC signatures.
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import {
  exportCustomerData,
  redactCustomerData,
  redactShopData,
  logGDPRRequest,
  type GDPRCustomerDataRequest,
  type GDPRCustomerRedactRequest,
  type GDPRShopRedactRequest,
} from "../services/gdpr.service";
import { logger } from "~/utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook() verifies HMAC signature automatically.
  // Throws 401 Response if signature is invalid.
  const { topic, shop, payload } = await authenticate.webhook(request);

  logger.debug(`[GDPR] Received compliance webhook: ${topic}`, { context: "GDPR", shop });

  try {
    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST": {
        const typedPayload = payload as unknown as GDPRCustomerDataRequest;
        const exportedData = await exportCustomerData(typedPayload);
        await logGDPRRequest(
          shop,
          "data_request",
          typedPayload.customer.id,
          typedPayload.customer.email,
          exportedData,
        );
        break;
      }
      case "CUSTOMERS_REDACT": {
        const typedPayload = payload as unknown as GDPRCustomerRedactRequest;
        await redactCustomerData(typedPayload);
        await logGDPRRequest(
          shop,
          "customer_redact",
          typedPayload.customer.id,
          typedPayload.customer.email,
        );
        break;
      }
      case "SHOP_REDACT": {
        const typedPayload = payload as unknown as GDPRShopRedactRequest;
        logger.warn("[GDPR] Shop redaction - will DELETE ALL DATA", {
          context: "GDPR",
          shopDomain: shop,
        });
        await redactShopData(typedPayload);
        await logGDPRRequest(shop, "shop_redact");
        break;
      }
      default:
        logger.warn(`[GDPR] Unhandled compliance topic: ${topic}`, { context: "GDPR" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[GDPR] Error processing compliance webhook", {
      context: "GDPR",
      topic,
      shop,
      error: message,
    });

    // Best-effort failed audit entry. Wrapped separately so a logging failure
    // can never mask the 500 — returning 500 is what guarantees Shopify
    // redelivers the webhook per its retry policy (without a retry the data
    // would be retained forever; the 30-day reaper is the final fallback).
    const auditType =
      topic === "CUSTOMERS_DATA_REQUEST"
        ? "data_request"
        : topic === "CUSTOMERS_REDACT"
          ? "customer_redact"
          : topic === "SHOP_REDACT"
            ? "shop_redact"
            : null;
    if (auditType) {
      try {
        await logGDPRRequest(shop, auditType, undefined, undefined, undefined, message);
      } catch (auditError) {
        logger.error("[GDPR] Failed to persist failed-request audit entry", {
          context: "GDPR",
          topic,
          shop,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        });
      }
    }

    // 500 → Shopify retries. redactShopData/redactCustomerData are
    // deleteMany-based inside a transaction, so a redelivered request is
    // idempotent (a second pass simply deletes 0 rows).
    return new Response("Internal Server Error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
};
