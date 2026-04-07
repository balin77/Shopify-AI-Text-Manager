import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { WebhookRegistrationService } from "../services/webhook-registration.service";
import { logger } from "~/utils/logger.server";

/**
 * API Route: Setup Webhooks
 *
 * Registers all required webhooks with Shopify.
 * This should be called once after app installation.
 *
 * Usage: POST /api/setup-webhooks
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);

    const webhookService = new WebhookRegistrationService(admin);
    await webhookService.registerAllWebhooks();

    const webhooks = await webhookService.listWebhooks();

    return json({
      success: true,
      message: "Webhooks registered successfully",
      webhooks: webhooks.map(w => ({
        topic: w.topic,
        callbackUrl: w.endpoint?.callbackUrl,
      })),
    });
  } catch (error: unknown) {
    logger.error("[SETUP-WEBHOOKS] Error", { context: "SetupWebhooks", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    return json(
      {
        success: false,
        error: "Failed to set up webhooks",
      },
      { status: 500 }
    );
  }
};
