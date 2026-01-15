/**
 * Product Actions Router
 *
 * Central entry point for all product-related actions.
 * Routes requests to appropriate handlers based on action type.
 *
 * This replaces the monolithic product.actions.ts (1,675 lines)
 * with a modular, maintainable structure.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { logger } from "~/utils/logger.server";
import { prepareActionContext } from "./shared/action-context";

// Import action handlers
import {
  handleGenerateAIText,
  handleFormatAIText,
} from "./ai-generation.actions.EXAMPLE";

// TODO: Import other actions as they are migrated
// import { handleTranslateField, handleTranslateSuggestion } from "./translation.actions";
// import { handleTranslateAll, handleTranslateFieldToAllLocales } from "./translation-bulk.actions";
// import { handleUpdateProduct } from "./update.actions";
// import { handleTranslateOption } from "./options.actions";
// import { handleGenerateAltText, handleGenerateAllAltTexts, handleTranslateAltText } from "./alt-text.actions";

/**
 * Main product actions handler
 *
 * This function:
 * 1. Authenticates the request
 * 2. Prepares shared context (AI settings, instructions, services)
 * 3. Routes to appropriate action handler
 */
export async function handleProductActions({
  request,
}: ActionFunctionArgs): Promise<Response> {
  logger.info("Product action requested", {
    context: "ProductActions",
    method: request.method,
    url: request.url,
  });

  try {
    // Authenticate with Shopify
    const { admin, session } = await authenticate.admin(request);

    // Parse form data
    const formData = await request.formData();
    const action = formData.get("action") as string;
    const productId = formData.get("productId") as string;

    logger.info("Action details", {
      context: "ProductActions",
      action,
      productId,
      shop: session.shop,
    });

    // Prepare shared context (AI settings, instructions, services)
    const context = await prepareActionContext(admin, session);

    // Route to appropriate handler
    switch (action) {
      // AI Generation Actions
      case "generateAIText":
        return handleGenerateAIText(context, formData, productId);

      case "formatAIText":
        return handleFormatAIText(context, formData, productId);

      // Translation Actions (TODO: Migrate)
      case "translateField":
        // TODO: return handleTranslateField(context, formData);
        return json(
          { success: false, error: "Action not yet migrated" },
          { status: 501 }
        );

      case "translateFieldToAllLocales":
        // TODO: return handleTranslateFieldToAllLocales(context, formData);
        return json(
          { success: false, error: "Action not yet migrated" },
          { status: 501 }
        );

      case "translateSuggestion":
        // TODO: return handleTranslateSuggestion(context, formData);
        return json(
          { success: false, error: "Action not yet migrated" },
          { status: 501 }
        );

      case "translateAll":
        // TODO: return handleTranslateAll(context, formData, productId);
        return json(
          { success: false, error: "Action not yet migrated" },
          { status: 501 }
        );

      // Update Action (TODO: Migrate)
      case "updateProduct":
        // TODO: return handleUpdateProduct(context, formData, productId);
        return json(
          { success: false, error: "Action not yet migrated" },
          { status: 501 }
        );

      // Options Action (TODO: Migrate)
      case "translateOption":
        // TODO: return handleTranslateOption(context, formData);
        return json(
          { success: false, error: "Action not yet migrated" },
          { status: 501 }
        );

      // Alt-Text Actions (TODO: Migrate)
      case "generateAltText":
        // TODO: return handleGenerateAltText(context, formData, productId);
        return json(
          { success: false, error: "Action not yet migrated" },
          { status: 501 }
        );

      case "generateAllAltTexts":
        // TODO: return handleGenerateAllAltTexts(context, formData, productId);
        return json(
          { success: false, error: "Action not yet migrated" },
          { status: 501 }
        );

      case "translateAltText":
        // TODO: return handleTranslateAltText(context, formData);
        return json(
          { success: false, error: "Action not yet migrated" },
          { status: 501 }
        );

      // Unknown action
      default:
        logger.warn("Unknown action requested", {
          context: "ProductActions",
          action,
        });
        return json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error: any) {
    logger.error("Product action failed", {
      context: "ProductActions",
      error: error.message,
      stack: error.stack,
    });

    return json(
      {
        success: false,
        error: "An unexpected error occurred. Please try again.",
      },
      { status: 500 }
    );
  }
}
