/**
 * Generic AI API Route
 * Handles all AI operations (translate, format, generate) for any content type.
 * This allows parallel AI requests without the page route returning HTML.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { AIService } from "../../src/services/ai.service";
import { decryptApiKey } from "../utils/encryption.server";
import { logger } from "~/utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const actionType = formData.get("action") as string;

    const { db } = await import("../db.server");

    // Load AI settings
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop }
    });

    const aiService = new AIService(
      settings?.preferredProvider as any || 'huggingface',
      {
        huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
        geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
        claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
        openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
        grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
        deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
      },
      session.shop
    );

    switch (actionType) {
      case "translateField": {
        const fieldType = formData.get("fieldType") as string;
        const sourceText = formData.get("sourceText") as string;
        const targetLocale = formData.get("targetLocale") as string;
        const primaryLocale = formData.get("primaryLocale") as string;

        if (!sourceText) {
          return json({ success: false, error: "No source text available" }, { status: 400 });
        }

        logger.debug("[API-AI] Translating field", {
          context: "AI",
          fieldType,
          from: primaryLocale,
          to: targetLocale,
          textLength: sourceText.length
        });

        const translatedValue = await aiService.translateContent(
          sourceText,
          primaryLocale,
          targetLocale
        );

        return json({
          success: true,
          translatedValue,
          fieldType,
          targetLocale
        });
      }

      case "translateFieldToAllLocales": {
        const fieldType = formData.get("fieldType") as string;
        const sourceText = formData.get("sourceText") as string;
        const targetLocalesJson = formData.get("targetLocales") as string;
        const primaryLocale = formData.get("primaryLocale") as string;

        if (!sourceText) {
          return json({ success: false, error: "No source text available" }, { status: 400 });
        }

        const targetLocales = targetLocalesJson ? JSON.parse(targetLocalesJson) : [];
        if (targetLocales.length === 0) {
          return json({ success: false, error: "No target locales specified" }, { status: 400 });
        }

        logger.debug("[API-AI] Translating field to all locales", {
          context: "AI",
          fieldType,
          from: primaryLocale,
          to: targetLocales,
          textLength: sourceText.length
        });

        const translations: Record<string, string> = {};

        for (const locale of targetLocales) {
          try {
            const translatedValue = await aiService.translateContent(
              sourceText,
              primaryLocale,
              locale
            );
            translations[locale] = translatedValue;
          } catch (error: any) {
            logger.error("[API-AI] Error translating to locale", {
              context: "AI",
              fieldType,
              locale,
              error: error?.message
            });
            translations[locale] = sourceText; // Fallback to original
          }
        }

        return json({
          success: true,
          translations,
          fieldType
        });
      }

      case "formatField": {
        const fieldType = formData.get("fieldType") as string;
        const sourceText = formData.get("sourceText") as string;
        const formatInstruction = formData.get("formatInstruction") as string || "Improve and format this text while keeping the same language";

        if (!sourceText) {
          return json({ success: false, error: "No source text available" }, { status: 400 });
        }

        logger.debug("[API-AI] Formatting field", {
          context: "AI",
          fieldType,
          textLength: sourceText.length
        });

        // Use generateContent with a formatting prompt
        const prompt = `${formatInstruction}

Text to format:
${sourceText}

Return only the formatted text, without explanations.`;

        const formattedValue = await aiService.generateContent(prompt);

        return json({
          success: true,
          formattedValue,
          fieldType
        });
      }

      default:
        return json({ success: false, error: `Unknown action: ${actionType}` }, { status: 400 });
    }
  } catch (error: any) {
    logger.error("[API-AI] Error processing AI request", {
      context: "AI",
      error: error.message,
      stack: error.stack
    });
    return json({ success: false, error: error.message }, { status: 500 });
  }
};
