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
import { TRANSLATE_CONTENT } from "../graphql/content.mutations";

// Helper to build translation prompt (same as in AIService)
function buildTranslationPrompt(sourceText: string, fromLang: string, toLang: string): string {
  return `Translate the following text from ${fromLang} to ${toLang}. Keep HTML tags.

Text: ${sourceText}

Return only the translation, without additional explanations.`;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

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

        // Build the prompt
        const prompt = buildTranslationPrompt(sourceText, primaryLocale, targetLocale);

        // Create task entry with prompt
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
            prompt, // Store the prompt
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

          // Update task to completed with full AI response
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: translatedValue, // Store full AI response
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

        // Build prompts for all locales (for logging)
        const allPrompts = targetLocales.map((locale: string) => ({
          locale,
          prompt: buildTranslationPrompt(sourceText, primaryLocale, locale)
        }));

        // Create task entry with all prompts
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
            prompt: JSON.stringify(allPrompts, null, 2), // Store all prompts
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
          const aiResponses: Array<{ locale: string; response: string }> = [];
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
              aiResponses.push({ locale, response: translatedValue });

              // For templates: Send to Shopify AND save to database
              if (contentType === 'templates' && itemId) {
                const groupId = itemId.replace("group_", "");

                // Load themeContent to get the real Shopify resourceId
                const themeContent = await db.themeContent.findFirst({
                  where: {
                    shop: session.shop,
                    groupId: groupId
                  }
                });

                if (themeContent) {
                  const shopifyResourceId = themeContent.resourceId;

                  // STEP 1: Send to Shopify first
                  try {
                    const translationInput = [{
                      key: fieldType,
                      value: translatedValue,
                      locale: locale,
                      translatableContentDigest: ""
                    }];

                    const response = await admin.graphql(TRANSLATE_CONTENT, {
                      variables: {
                        resourceId: shopifyResourceId,
                        translations: translationInput
                      }
                    });

                    const data = await response.json();

                    if (data.data?.translationsRegister?.userErrors?.length > 0) {
                      logger.error("[API-AI] Shopify translation error", {
                        context: "AI",
                        errors: data.data.translationsRegister.userErrors,
                        locale,
                        fieldType
                      });
                    } else {
                      logger.debug("[API-AI] Saved translation to Shopify", {
                        context: "AI",
                        resourceId: shopifyResourceId,
                        fieldType,
                        locale
                      });
                    }
                  } catch (shopifyError: any) {
                    logger.error("[API-AI] Error sending to Shopify", {
                      context: "AI",
                      error: shopifyError?.message,
                      locale,
                      fieldType
                    });
                  }

                  // STEP 2: Save to local database
                  await db.themeTranslation.upsert({
                    where: {
                      shop_resourceId_groupId_key_locale: {
                        shop: session.shop,
                        resourceId: shopifyResourceId,
                        groupId: groupId,
                        key: fieldType,
                        locale: locale
                      }
                    },
                    update: {
                      value: translatedValue,
                      updatedAt: new Date()
                    },
                    create: {
                      shop: session.shop,
                      groupId: groupId,
                      resourceId: shopifyResourceId,
                      locale: locale,
                      key: fieldType,
                      value: translatedValue
                    }
                  });

                  logger.debug("[API-AI] Saved template translation to DB", {
                    context: "AI",
                    groupId,
                    fieldType,
                    locale
                  });
                }
              }

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
              aiResponses.push({ locale, response: `ERROR: ${error?.message}` });
            }
          }

          // Update task to completed with all AI responses
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: JSON.stringify(aiResponses, null, 2), // Store all AI responses
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

        // Build the prompt
        const prompt = `${formatInstruction}

Text to format:
${sourceText}

Return only the formatted text, without explanations.`;

        // Create task entry with prompt
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "formatting",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: fieldType,
            fieldType,
            progress: 0,
            prompt, // Store the prompt
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

          const formattedValue = await aiService['askAI'](prompt);

          // Update task to completed with full AI response
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: formattedValue, // Store full AI response
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

      case "generateAIText": {
        const fieldType = formData.get("fieldType") as string;
        const currentValue = formData.get("currentValue") as string;
        const contextTitle = formData.get("contextTitle") as string || "";
        const contextDescription = formData.get("contextDescription") as string || "";
        const mainLanguage = formData.get("mainLanguage") as string || "German";

        // Build the prompt
        const prompt = `Improve the following content field.

Field: ${fieldType}
Current value: ${currentValue || "(empty)"}
Context title: ${contextTitle}
Context description: ${contextDescription}
Language: ${mainLanguage}

IMPORTANT: Return ONLY the improved text, nothing else. No explanations, no options, no formatting, no labels. Just output the single best improved version of the content in ${mainLanguage}.`;

        // Create task entry with prompt
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
            prompt, // Store the prompt
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

          logger.debug("[API-AI] Generating AI text", {
            context: "AI",
            fieldType,
            textLength: currentValue?.length || 0
          });

          const generatedContent = await aiService['askAI'](prompt);

          // Update task to completed with full AI response
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: generatedContent, // Store full AI response
            },
          });

          return json({
            success: true,
            generatedContent,
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

      case "formatAIText": {
        const fieldType = formData.get("fieldType") as string;
        const currentValue = formData.get("currentValue") as string;
        const contextTitle = formData.get("contextTitle") as string || "";
        const contextDescription = formData.get("contextDescription") as string || "";
        const mainLanguage = formData.get("mainLanguage") as string || "German";

        if (!currentValue) {
          return json({ success: false, error: "No content available to format" }, { status: 400 });
        }

        // Build the prompt
        const prompt = `Improve and format the following content while keeping the same language (${mainLanguage}).

Field: ${fieldType}
Current value: ${currentValue}
Context title: ${contextTitle}
Context description: ${contextDescription}

IMPORTANT: Return ONLY the improved and formatted text, nothing else. No explanations, no options, no labels. Keep the same language (${mainLanguage}). Just output the single best improved version.`;

        // Create task entry with prompt
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "formatting",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: fieldType,
            fieldType,
            progress: 0,
            prompt, // Store the prompt
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

          logger.debug("[API-AI] Formatting AI text", {
            context: "AI",
            fieldType,
            textLength: currentValue.length
          });

          const formattedValue = await aiService['askAI'](prompt);

          // Update task to completed with full AI response
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: formattedValue, // Store full AI response
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
