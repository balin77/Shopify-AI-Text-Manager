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
  logger.debug("[SETUP-WEBHOOKS] Starting webhook setup...", { context: "SetupWebhooks" });

  try {
    const { admin, session } = await authenticate.admin(request);

    logger.debug("[SETUP-WEBHOOKS] Setting up webhooks for shop", { context: "SetupWebhooks", shop: session.shop });

    const webhookService = new WebhookRegistrationService(admin);

    // Register ALL webhooks (products + content)
    await webhookService.registerAllWebhooks();

    // List registered webhooks
    const webhooks = await webhookService.listWebhooks();

    logger.debug("[SETUP-WEBHOOKS] Setup complete!", { context: "SetupWebhooks", webhookCount: webhooks.length });

    return json({
      success: true,
      message: "Webhooks registered successfully",
      webhooks: webhooks.map(w => ({
        topic: w.topic,
        callbackUrl: w.endpoint?.callbackUrl,
      })),
    });
  } catch (error: any) {
    logger.error("[SETUP-WEBHOOKS] Error", { context: "SetupWebhooks", error: error.message, stack: error.stack });
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
