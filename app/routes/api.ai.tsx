/**
 * Generic AI API Route
 * Handles all AI operations (translate, format, generate) for any content type.
 * This allows parallel AI requests without the page route returning HTML.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { AIService } from "../../src/services/ai.service";
import { decryptApiKey } from "../utils/encryption.server";
import { getTaskExpirationDate } from "../../src/utils/task.utils";
import { logger } from "~/utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const actionType = formData.get("action") as string;
    const contentType = formData.get("contentType") as string || "unknown";
    const itemId = formData.get("itemId") as string || "unknown";

    const { db } = await import("../db.server");

    // Load AI settings
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop }
    });

    switch (actionType) {
      case "translateField": {
        const fieldType = formData.get("fieldType") as string;
        const sourceText = formData.get("sourceText") as string;
        const targetLocale = formData.get("targetLocale") as string;
        const primaryLocale = formData.get("primaryLocale") as string;

        if (!sourceText) {
          return json({ success: false, error: "No source text available" }, { status: 400 });
        }

        // Create task entry
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "translation",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: fieldType,
            fieldType,
            targetLocale,
            progress: 0,
            expiresAt: getTaskExpirationDate(),
          },
        });

        try {
          // Update task to running
          await db.task.update({
            where: { id: task.id },
            data: { status: "running", progress: 20 },
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
            session.shop,
            task.id
          );

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

          // Update task to completed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: translatedValue.substring(0, 1000),
            },
          });

          return json({
            success: true,
            translatedValue,
            fieldType,
            targetLocale
          });
        } catch (error: any) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: (error.message || String(error)).substring(0, 1000),
            },
          });
          throw error;
        }
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

        // Create task entry
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "translationBulk",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: fieldType,
            fieldType,
            progress: 0,
            expiresAt: getTaskExpirationDate(),
          },
        });

        try {
          // Update task to running
          await db.task.update({
            where: { id: task.id },
            data: { status: "running", progress: 10 },
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
            session.shop,
            task.id
          );

          logger.debug("[API-AI] Translating field to all locales", {
            context: "AI",
            fieldType,
            from: primaryLocale,
            to: targetLocales,
            textLength: sourceText.length
          });

          const translations: Record<string, string> = {};
          const totalLocales = targetLocales.length;

          for (let i = 0; i < targetLocales.length; i++) {
            const locale = targetLocales[i];
            try {
              const translatedValue = await aiService.translateContent(
                sourceText,
                primaryLocale,
                locale
              );
              translations[locale] = translatedValue;

              // Update progress
              const progress = Math.round(10 + ((i + 1) / totalLocales) * 80);
              await db.task.update({
                where: { id: task.id },
                data: { progress },
              });
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

          // Update task to completed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: `Translated to ${Object.keys(translations).length} locales`,
            },
          });

          return json({
            success: true,
            translations,
            fieldType
          });
        } catch (error: any) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: (error.message || String(error)).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "formatField": {
        const fieldType = formData.get("fieldType") as string;
        const sourceText = formData.get("sourceText") as string;
        const formatInstruction = formData.get("formatInstruction") as string || "Improve and format this text while keeping the same language";

        if (!sourceText) {
          return json({ success: false, error: "No source text available" }, { status: 400 });
        }

        // Create task entry
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "aiGeneration",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: fieldType,
            fieldType,
            progress: 0,
            expiresAt: getTaskExpirationDate(),
          },
        });

        try {
          // Update task to running
          await db.task.update({
            where: { id: task.id },
            data: { status: "running", progress: 20 },
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
            session.shop,
            task.id
          );

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

          // Update task to completed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: formattedValue.substring(0, 1000),
            },
          });

          return json({
            success: true,
            formattedValue,
            fieldType
          });
        } catch (error: any) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: (error.message || String(error)).substring(0, 1000),
            },
          });
          throw error;
        }
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
