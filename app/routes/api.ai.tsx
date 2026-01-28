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
import { sanitizeSlug } from "../utils/slug.utils";

// Helper to build translation prompt (same as in AIService)
function buildTranslationPrompt(sourceText: string, fromLang: string, toLang: string): string {
  return `Translate the following text from ${fromLang} to ${toLang}. Keep HTML tags.

Text: ${sourceText}

Return only the translation, without additional explanations.`;
}

// Helper to build URL slug translation prompt
function buildSlugTranslationPrompt(sourceText: string, fromLang: string, toLang: string): string {
  return `Translate the following URL slug/handle from ${fromLang} to ${toLang}.

IMPORTANT: The result MUST be a valid URL slug:
- Use only lowercase letters (a-z), numbers (0-9), and hyphens (-)
- Replace spaces with hyphens
- No special characters, no umlauts, no accents
- No spaces, no underscores
- Examples: "storage-boxes", "wooden-chair", "blue-t-shirt"

Source slug: ${sourceText}

Return only the translated URL slug, nothing else.`;
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

        // Check if this is a URL slug/handle field
        const isSlugField = fieldType === 'handle' || fieldType === 'slug';

        // Build the prompt (use special prompt for URL slugs)
        const prompt = isSlugField
          ? buildSlugTranslationPrompt(sourceText, primaryLocale, targetLocale)
          : buildTranslationPrompt(sourceText, primaryLocale, targetLocale);

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

          // Use special method for URL slugs
          let translatedValue = isSlugField
            ? await aiService.translateSlug(sourceText, primaryLocale, targetLocale)
            : await aiService.translateContent(sourceText, primaryLocale, targetLocale);

          // For URL slugs: ensure the result is a valid slug (post-process as safety net)
          if (isSlugField) {
            const originalValue = translatedValue;
            translatedValue = sanitizeSlug(translatedValue);
            logger.debug("[API-AI] Sanitized slug translation", {
              context: "AI",
              original: originalValue,
              sanitized: translatedValue
            });
          }

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

        // Check if this is a URL slug/handle field
        const isSlugField = fieldType === 'handle' || fieldType === 'slug';

        // Build prompts for all locales (for logging)
        const allPrompts = targetLocales.map((locale: string) => ({
          locale,
          prompt: isSlugField
            ? buildSlugTranslationPrompt(sourceText, primaryLocale, locale)
            : buildTranslationPrompt(sourceText, primaryLocale, locale)
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

          // For templates: Load themeContent ONCE before the loop to avoid race conditions
          let templateGroupId: string | null = null;
          let templateResourceId: string | null = null;
          if (contentType === 'templates' && itemId) {
            templateGroupId = itemId.replace("group_", "");
            const themeContent = await db.themeContent.findFirst({
              where: {
                shop: session.shop,
                groupId: templateGroupId
              }
            });
            if (themeContent) {
              templateResourceId = themeContent.resourceId;
              logger.info("[API-AI] Found themeContent for templates", {
                context: "AI",
                groupId: templateGroupId,
                resourceId: templateResourceId
              });
            } else {
              logger.error("[API-AI] No themeContent found - translations will NOT be saved!", {
                context: "AI",
                groupId: templateGroupId,
                shop: session.shop
              });
            }
          }

          for (let i = 0; i < targetLocales.length; i++) {
            const locale = targetLocales[i];
            try {
              // Use special method for URL slugs
              let translatedValue = isSlugField
                ? await aiService.translateSlug(sourceText, primaryLocale, locale)
                : await aiService.translateContent(sourceText, primaryLocale, locale);

              // For URL slugs: ensure the result is a valid slug (post-process as safety net)
              if (isSlugField) {
                const originalValue = translatedValue;
                translatedValue = sanitizeSlug(translatedValue);
                logger.debug("[API-AI] Sanitized slug translation", {
                  context: "AI",
                  locale,
                  original: originalValue,
                  sanitized: translatedValue
                });
              }

              translations[locale] = translatedValue;
              aiResponses.push({ locale, response: translatedValue });

              // For templates: Send to Shopify AND save to database
              if (contentType === 'templates' && templateResourceId && templateGroupId) {
                // STEP 1: Fetch the digest from Shopify first
                try {
                  const digestResponse = await admin.graphql(`
                    query getTranslatableContent($resourceId: ID!) {
                      translatableResource(resourceId: $resourceId) {
                        resourceId
                        translatableContent {
                          key
                          digest
                        }
                      }
                    }
                  `, {
                    variables: { resourceId: templateResourceId }
                  });

                  const digestData = await digestResponse.json() as any;
                  const translatableContent = digestData.data?.translatableResource?.translatableContent || [];
                  const fieldContent = translatableContent.find((c: any) => c.key === fieldType);
                  const digest = fieldContent?.digest || "";

                  logger.info("[API-AI] Fetched digest for field", {
                    context: "AI",
                    resourceId: templateResourceId,
                    fieldType,
                    digest: digest ? `${digest.substring(0, 20)}...` : "(empty)",
                    totalFields: translatableContent.length
                  });

                  // STEP 2: Send to Shopify with the digest
                  const translationInput = [{
                    key: fieldType,
                    value: translatedValue,
                    locale: locale,
                    translatableContentDigest: digest
                  }];

                  logger.info("[API-AI] Calling Shopify translationsRegister", {
                    context: "AI",
                    resourceId: templateResourceId,
                    fieldType,
                    locale,
                    hasDigest: !!digest
                  });

                  const response = await admin.graphql(TRANSLATE_CONTENT, {
                    variables: {
                      resourceId: templateResourceId,
                      translations: translationInput
                    }
                  });

                  const data = await response.json() as any;

                  // Log FULL response for debugging
                  logger.info("[API-AI] Shopify response received", {
                    context: "AI",
                    locale,
                    fieldType,
                    hasData: !!data.data,
                    hasErrors: !!data.errors,
                    fullResponse: JSON.stringify(data).substring(0, 1000)
                  });

                  // Check for top-level GraphQL errors
                  if (data.errors && data.errors.length > 0) {
                    logger.error("[API-AI] Shopify GraphQL errors", {
                      context: "AI",
                      errors: data.errors,
                      locale,
                      fieldType,
                      resourceId: templateResourceId
                    });
                  } else if (data.data?.translationsRegister?.userErrors?.length > 0) {
                    logger.error("[API-AI] Shopify translation userErrors", {
                      context: "AI",
                      errors: data.data.translationsRegister.userErrors,
                      locale,
                      fieldType
                    });
                  } else if (data.data?.translationsRegister?.translations?.length > 0) {
                    logger.info("[API-AI] SUCCESS - Translation saved to Shopify", {
                      context: "AI",
                      resourceId: templateResourceId,
                      fieldType,
                      locale,
                      savedTranslations: data.data.translationsRegister.translations
                    });
                  } else {
                    logger.warn("[API-AI] Shopify returned no errors but also no translations", {
                      context: "AI",
                      resourceId: templateResourceId,
                      fieldType,
                      locale,
                      fullResponse: JSON.stringify(data)
                    });
                  }
                } catch (shopifyError: any) {
                  logger.error("[API-AI] Exception sending to Shopify", {
                    context: "AI",
                    error: shopifyError?.message,
                    stack: shopifyError?.stack?.substring(0, 500),
                    locale,
                    fieldType,
                    resourceId: templateResourceId
                  });
                }

                // STEP 2: Save to local database
                try {
                  await db.themeTranslation.upsert({
                    where: {
                      shop_resourceId_groupId_key_locale: {
                        shop: session.shop,
                        resourceId: templateResourceId,
                        groupId: templateGroupId,
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
                      groupId: templateGroupId,
                      resourceId: templateResourceId,
                      locale: locale,
                      key: fieldType,
                      value: translatedValue
                    }
                  });

                  logger.info("[API-AI] Saved template translation to DB", {
                    context: "AI",
                    groupId: templateGroupId,
                    fieldType,
                    locale
                  });
                } catch (dbError: any) {
                  logger.error("[API-AI] Error saving to DB", {
                    context: "AI",
                    error: dbError?.message,
                    groupId: templateGroupId,
                    fieldType,
                    locale
                  });
                }
              }
              // For products and other content types: Send to Shopify
              else if (itemId && (contentType === 'products' || contentType === 'collections' || contentType === 'pages' || contentType === 'blogs' || contentType === 'policies')) {
                // Map fieldType to Shopify key
                const fieldKeyMap: Record<string, string> = {
                  title: "title",
                  description: "body_html",
                  body: "body_html",
                  handle: "handle",
                  seoTitle: "meta_title",
                  metaDescription: "meta_description",
                };
                const shopifyKey = fieldKeyMap[fieldType] || fieldType;

                try {
                  // First, get the digest for this field from Shopify
                  const digestResponse = await admin.graphql(`
                    query getTranslatableContent($resourceId: ID!) {
                      translatableResource(resourceId: $resourceId) {
                        resourceId
                        translatableContent {
                          key
                          digest
                        }
                      }
                    }
                  `, {
                    variables: { resourceId: itemId }
                  });

                  const digestData = await digestResponse.json();
                  const translatableContent = digestData.data?.translatableResource?.translatableContent || [];
                  const fieldContent = translatableContent.find((c: any) => c.key === shopifyKey);
                  const digest = fieldContent?.digest || "";

                  // Now save the translation to Shopify
                  const translationInput = [{
                    key: shopifyKey,
                    value: translatedValue,
                    locale: locale,
                    translatableContentDigest: digest
                  }];

                  const response = await admin.graphql(TRANSLATE_CONTENT, {
                    variables: {
                      resourceId: itemId,
                      translations: translationInput
                    }
                  });

                  const data = await response.json();

                  if (data.data?.translationsRegister?.userErrors?.length > 0) {
                    logger.error("[API-AI] Shopify translation error for " + contentType, {
                      context: "AI",
                      errors: data.data.translationsRegister.userErrors,
                      locale,
                      fieldType,
                      shopifyKey
                    });
                  } else {
                    logger.debug("[API-AI] Saved translation to Shopify for " + contentType, {
                      context: "AI",
                      resourceId: itemId,
                      fieldType,
                      shopifyKey,
                      locale
                    });
                  }
                } catch (shopifyError: any) {
                  logger.error("[API-AI] Error sending to Shopify for " + contentType, {
                    context: "AI",
                    error: shopifyError?.message,
                    locale,
                    fieldType
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
