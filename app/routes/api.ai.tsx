/**
 * Generic AI API Route
 * Handles all AI operations (translate, format, generate) for any content type.
 * This allows parallel AI requests without the page route returning HTML.
 *
 * Action handlers are extracted to:
 *   ./api-ai-handlers/text-translation.handler.ts
 *   ./api-ai-handlers/text-generation.handler.ts
 *   ./api-ai-handlers/alt-text.handler.ts
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { getFormString } from "~/utils/form-data.utils";
import {
  VALID_CONTENT_TYPES,
  errorMessage,
  errorStack,
} from "./api-ai-handlers/shared";
import type { AIActionContext } from "./api-ai-handlers/shared";
import {
  handleTranslateField,
  handleTranslateFieldToAllLocales,
} from "./api-ai-handlers/text-translation.handler";
import {
  handleFormatField,
  handleGenerateAIText,
  handleFormatAIText,
} from "./api-ai-handlers/text-generation.handler";
import {
  handleGenerateAltText,
  handleGenerateAllAltTexts,
  handleTranslateAltText,
  handleTranslateAltTextToAllLocales,
  handleTranslateAllAltTextsToAllLocales,
  handleTranslateAllAltTextsForLocale,
} from "./api-ai-handlers/alt-text.handler";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const actionType = getFormString(formData, "action");
    const rawContentType = getFormString(formData, "contentType") || "";
    if (!VALID_CONTENT_TYPES.has(rawContentType)) {
      return json({ success: false, error: `Invalid contentType: ${rawContentType}` }, { status: 400 });
    }
    const contentType = rawContentType;
    const itemId = getFormString(formData, "itemId") || "unknown";

    const { db } = await import("../db.server");

    // Load AI settings
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop }
    });

    // Compute effective SEO title limit (accounts for shop name suffix appended by Shopify)
    const seoTitleMaxChars = settings?.seoTitleSuffixEnabled && settings.seoTitleSuffix
      ? 60 - settings.seoTitleSuffix.length
      : 60;

    const ctx: AIActionContext = {
      session,
      admin,
      db,
      formData,
      settings,
      seoTitleMaxChars,
      contentType,
      itemId,
    };

    switch (actionType) {
      case "translateField":
        return handleTranslateField(ctx);
      case "translateFieldToAllLocales":
        return handleTranslateFieldToAllLocales(ctx);
      case "formatField":
        return handleFormatField(ctx);
      case "generateAIText":
        return handleGenerateAIText(ctx);
      case "formatAIText":
        return handleFormatAIText(ctx);
      case "generateAltText":
        return handleGenerateAltText(ctx);
      case "generateAllAltTexts":
        return handleGenerateAllAltTexts(ctx);
      case "translateAltText":
        return handleTranslateAltText(ctx);
      case "translateAltTextToAllLocales":
        return handleTranslateAltTextToAllLocales(ctx);
      case "translateAllAltTextsToAllLocales":
        return handleTranslateAllAltTextsToAllLocales(ctx);
      case "translateAllAltTextsForLocale":
        return handleTranslateAllAltTextsForLocale(ctx);
      default:
        return json({ success: false, error: `Unknown action: ${actionType}` }, { status: 400 });
    }
  } catch (error: unknown) {
    logger.error("[API-AI] Error processing AI request", {
      context: "AI",
      error: errorMessage(error),
      stack: errorStack(error)
    });
    return json({ success: false, error: "An internal error occurred while processing the AI request." }, { status: 500 });
  }
};
