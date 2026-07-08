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
import { isThemeContentType } from "~/utils/content-type-groups";
import {
  VALID_CONTENT_TYPES,
  errorMessage,
  errorStack,
  getMissingPreferredKey,
  noAiKeyResponse,
  isAuthError,
  aiAuthErrorResponse,
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
import { handleSeoBulkFix } from "./api-ai-handlers/seo-bulk-fix.handler";
import { handleSeoAudit } from "./api-ai-handlers/seo-audit.handler";
import { handleSeoBulkMeta } from "./api-ai-handlers/seo-bulk-meta.handler";
import { handleGenerateTemplateTitles } from "./api-ai-handlers/template-titles.handler";

// Actions that never call an AI provider — they only read/write the DB
// content cache and/or Shopify directly — so a shop with no AI key
// configured yet must still be able to use them. Kept as a Set (rather than
// growing the single seoAudit ternary below) now that there's more than one.
const NON_AI_ACTIONS = new Set(["seoAudit", "seoBulkMeta"]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const actionType = getFormString(formData, "action");
    const rawContentType = getFormString(formData, "contentType") || "";
    // The theme-content family (system / delivery / sellingPlans /
    // onlineStoreExtras) shares the Templates ThemeContent data model, item id
    // shape (`group_<groupId>`) and handler path. They only differ by their
    // plan-gating contentType, which is NOT in VALID_CONTENT_TYPES and which the
    // AI handlers don't recognise (persistence branches key on
    // `contentType === 'templates'`). Normalise the whole family to 'templates'
    // so the shared handler logic applies uniformly; without this, "Übersetzen"
    // on these rubrics 400s ("Invalid contentType: sellingPlans").
    const contentType = isThemeContentType(rawContentType) ? "templates" : rawContentType;
    if (!VALID_CONTENT_TYPES.has(contentType)) {
      return json({ success: false, error: `Invalid contentType: ${rawContentType}` }, { status: 400 });
    }
    const itemId = getFormString(formData, "itemId") || "unknown";

    const { db } = await import("../db.server");

    // Load AI settings
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop }
    });

    // Compliance gate: never send merchant content to a third-party AI through
    // an operator key. Block early with an actionable code if the shop has no
    // own API key for its preferred provider.
    // NON_AI_ACTIONS are exempt — they only read/write the DB content cache
    // and/or Shopify directly (no provider call at all), so a shop with no AI
    // key configured yet must still be able to use them.
    const missingKey = NON_AI_ACTIONS.has(actionType) ? null : getMissingPreferredKey(settings);
    if (missingKey) {
      return noAiKeyResponse(settings, missingKey);
    }

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
      case "seoBulkFix":
        return handleSeoBulkFix(ctx);
      case "seoAudit":
        return handleSeoAudit(ctx);
      case "seoBulkMeta":
        return handleSeoBulkMeta(ctx);
      case "generateTemplateTitles":
        return handleGenerateTemplateTitles(ctx);
      default:
        return json({ success: false, error: `Unknown action: ${actionType}` }, { status: 400 });
    }
  } catch (error: unknown) {
    // An invalid/expired provider key must always surface as an actionable
    // error — never as a generic 500 (or, worse, a silent success from a
    // handler that swallowed it). Handlers re-throw auth errors for exactly
    // this central translation into a clear INVALID_AI_KEY response.
    if (isAuthError(error)) {
      logger.error("[API-AI] AI request failed — provider rejected the API key", {
        context: "AI",
        error: errorMessage(error),
      });
      return aiAuthErrorResponse(error);
    }
    logger.error("[API-AI] Error processing AI request", {
      context: "AI",
      error: errorMessage(error),
      stack: errorStack(error)
    });
    return json({ success: false, error: "An internal error occurred while processing the AI request." }, { status: 500 });
  }
};
