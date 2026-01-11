import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { WebhookRegistrationService } from "../services/webhook-registration.service";

/**
 * API Route: Setup Webhooks
 *
 * Registers all required webhooks with Shopify.
 * This should be called once after app installation.
 *
 * Usage: POST /api/setup-webhooks
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("🔧 [SETUP-WEBHOOKS] Starting webhook setup...");

  try {
    const { admin, session } = await authenticate.admin(request);

    console.log(`[SETUP-WEBHOOKS] Setting up webhooks for shop: ${session.shop}`);

    const webhookService = new WebhookRegistrationService(admin);

    // Register ALL webhooks (products + content)
    await webhookService.registerAllWebhooks();

    // List registered webhooks
    const webhooks = await webhookService.listWebhooks();

    console.log(`[SETUP-WEBHOOKS] ✓ Setup complete! Registered ${webhooks.length} webhooks`);

    return json({
      success: true,
      message: "Webhooks registered successfully",
      webhooks: webhooks.map(w => ({
        topic: w.topic,
        callbackUrl: w.endpoint?.callbackUrl,
      })),
    });
  } catch (error: any) {
    console.error("[SETUP-WEBHOOKS] Error:", error);
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
