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

        // Check if this is a short field that can use batch translation
        const SHORT_FIELDS = ['handle', 'slug', 'title', 'seoTitle', 'productType'];
        const isShortField = SHORT_FIELDS.includes(fieldType);

        // Build batch prompt for short fields, individual prompts for long fields
        const batchPrompt = isShortField
          ? `Batch translation from ${primaryLocale} to [${targetLocales.join(', ')}] for field: ${fieldType}`
          : null;

        const allPrompts = isShortField
          ? [{ type: 'batch', locales: targetLocales, prompt: batchPrompt }]
          : targetLocales.map((locale: string) => ({
              locale,
              prompt: buildTranslationPrompt(sourceText, primaryLocale, locale)
            }));

        // Create task entry with prompts
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
            prompt: JSON.stringify(allPrompts, null, 2),
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
            textLength: sourceText.length,
            useBatch: isShortField
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

          // Use batch translation for short fields (1 AI request for all locales)
          if (isShortField) {
            logger.info("[API-AI] Using BATCH translation for short field", {
              context: "AI",
              fieldType,
              targetLocales,
              isSlugField
            });

            try {
              let batchResults: Record<string, string>;

              if (isSlugField) {
                // Use batch slug translation
                batchResults = await aiService.translateSlugBatch(sourceText, primaryLocale, targetLocales);
              } else {
                // Use batch short field translation (title, seoTitle)
                const fieldsToTranslate = { [fieldType]: sourceText };
                const batchFieldResults = await aiService.translateShortFieldsBatch(fieldsToTranslate, primaryLocale, targetLocales, contentType);
                // Extract just the single field from each locale
                batchResults = {};
                for (const locale of targetLocales) {
                  if (batchFieldResults[locale] && batchFieldResults[locale][fieldType]) {
                    batchResults[locale] = batchFieldResults[locale][fieldType];
                  }
                }
              }

              // Process batch results and save to Shopify
              for (let i = 0; i < targetLocales.length; i++) {
                const locale = targetLocales[i];
                let translatedValue = batchResults[locale] || sourceText;

                // For URL slugs: ensure the result is a valid slug (post-process as safety net)
                if (isSlugField) {
                  const originalValue = translatedValue;
                  translatedValue = sanitizeSlug(translatedValue);
                  logger.debug("[API-AI] Sanitized batch slug translation", {
                    context: "AI",
                    locale,
                    original: originalValue,
                    sanitized: translatedValue
                  });
                }

                translations[locale] = translatedValue;
                aiResponses.push({ locale, response: translatedValue });

                // Save to Shopify for templates
                if (contentType === 'templates' && templateResourceId && templateGroupId) {
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

                    const translationInput = [{
                      key: fieldType,
                      value: translatedValue,
                      locale: locale,
                      translatableContentDigest: digest
                    }];

                    await admin.graphql(TRANSLATE_CONTENT, {
                      variables: {
                        resourceId: templateResourceId,
                        translations: translationInput
                      }
                    });

                    // Save to local database
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

                    logger.debug("[API-AI] Batch: Saved template translation", {
                      context: "AI",
                      locale,
                      fieldType
                    });
                  } catch (shopifyError: any) {
                    logger.error("[API-AI] Batch: Error saving template to Shopify", {
                      context: "AI",
                      error: shopifyError?.message,
                      locale,
                      fieldType
                    });
                  }
                }
                // Save to Shopify for products, collections, pages, etc.
                else if (itemId && (contentType === 'products' || contentType === 'collections' || contentType === 'pages' || contentType === 'blogs' || contentType === 'policies')) {
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

                    const translationInput = [{
                      key: shopifyKey,
                      value: translatedValue,
                      locale: locale,
                      translatableContentDigest: digest
                    }];

                    await admin.graphql(TRANSLATE_CONTENT, {
                      variables: {
                        resourceId: itemId,
                        translations: translationInput
                      }
                    });

                    logger.debug("[API-AI] Batch: Saved translation to Shopify", {
                      context: "AI",
                      resourceId: itemId,
                      fieldType,
                      shopifyKey,
                      locale
                    });
                  } catch (shopifyError: any) {
                    logger.error("[API-AI] Batch: Error sending to Shopify", {
                      context: "AI",
                      error: shopifyError?.message,
                      locale,
                      fieldType
                    });
                  }
                }

                // Update progress
                const progress = Math.round(10 + ((i + 1) / targetLocales.length) * 80);
                await db.task.update({
                  where: { id: task.id },
                  data: { progress },
                });
              }

              // Progress already updated in loop above

            } catch (batchError: any) {
              logger.error("[API-AI] Batch translation failed, falling back to sequential", {
                context: "AI",
                error: batchError?.message,
                fieldType
              });
              // Fall through to sequential processing below
            }
          }

          // Sequential translation for long fields OR if batch failed
          if (!isShortField || Object.keys(translations).length === 0) {
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
                  productType: "product_type",
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
          } // End of sequential translation if block

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
            generatedContent: formattedValue,
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

      case "generateAltText": {
        const imageIndex = parseInt(formData.get("imageIndex") as string);
        const imageUrl = formData.get("imageUrl") as string;
        const productTitle = formData.get("productTitle") as string;
        const mainLanguage = formData.get("mainLanguage") as string || "German";

        if (!imageUrl) {
          return json({ success: false, error: "No image URL provided" }, { status: 400 });
        }

        // Load AI instructions
        const aiInstructions = await db.aIInstructions.findUnique({
          where: { shop: session.shop },
        });

        // Create task entry with prompt
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "aiGeneration",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: productTitle,
            fieldType: `altText_${imageIndex}`,
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

          logger.debug("[API-AI] Generating alt-text for image", {
            context: "AI",
            imageIndex,
            productTitle,
            textLength: imageUrl.length
          });

          let prompt = `Create an optimized alt text for a product image.
Product: ${productTitle}
Image URL: ${imageUrl}`;

          if (aiInstructions?.productAltTextFormat) {
            prompt += `\n\nFormat Example:\n${aiInstructions.productAltTextFormat}`;
          }

          if (aiInstructions?.productAltTextInstructions) {
            prompt += `\n\nInstructions:\n${aiInstructions.productAltTextInstructions}`;
          }

          prompt += `\n\nReturn ONLY the alt text, without explanations.${mainLanguage ? ` Output the result in ${mainLanguage}.` : ''}`;

          const altText = await aiService.generateImageAltText(imageUrl, productTitle, prompt);

          // Update task to completed with full AI response
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: altText,
            },
          });

          return json({
            success: true,
            altText,
            imageIndex
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

      case "generateAllAltTexts": {
        const productId = formData.get("productId") as string;
        const productTitle = formData.get("productTitle") as string;
        const mainLanguage = formData.get("mainLanguage") as string || "German";
        const imagesDataJson = formData.get("imagesData") as string;

        if (!imagesDataJson) {
          return json({ success: false, error: "No images data provided" }, { status: 400 });
        }

        const imagesData: Array<{ url: string }> = JSON.parse(imagesDataJson);
        const totalImages = imagesData.length;

        if (totalImages === 0) {
          return json({ success: false, error: "No images to process" }, { status: 400 });
        }

        // Load AI instructions
        const altTextInstructions = await db.aIInstructions.findUnique({
          where: { shop: session.shop },
        });

        // Create task entry
        const bulkTask = await db.task.create({
          data: {
            shop: session.shop,
            type: "bulkAIGeneration",
            status: "pending",
            resourceType: contentType,
            resourceId: productId,
            resourceTitle: productTitle,
            fieldType: "allAltTexts",
            progress: 0,
            total: totalImages,
            processed: 0,
            expiresAt: getTaskExpirationDate(),
          },
        });

        try {
          await db.task.update({
            where: { id: bulkTask.id },
            data: { status: "running", progress: 10 },
          });

          const bulkAiService = new AIService(
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
            bulkTask.id
          );

          const generatedAltTexts: Record<number, string> = {};

          for (let i = 0; i < imagesData.length; i++) {
            const image = imagesData[i];
            try {
              let prompt = `Create an optimized alt text for a product image.
Product: ${productTitle}
Image URL: ${image.url}`;

              if (altTextInstructions?.productAltTextFormat) {
                prompt += `\n\nFormat Example:\n${altTextInstructions.productAltTextFormat}`;
              }

              if (altTextInstructions?.productAltTextInstructions) {
                prompt += `\n\nInstructions:\n${altTextInstructions.productAltTextInstructions}`;
              }

              prompt += `\n\nReturn ONLY the alt text, without explanations.${mainLanguage ? ` Output the result in ${mainLanguage}.` : ''}`;

              const altText = await bulkAiService.generateImageAltText(image.url, productTitle, prompt);
              generatedAltTexts[i] = altText;

              const progressPercent = Math.round(10 + ((i + 1) / totalImages) * 90);
              await db.task.update({
                where: { id: bulkTask.id },
                data: { progress: progressPercent, processed: i + 1 },
              });
            } catch (imgError: any) {
              logger.error("[API-AI] Failed to generate alt-text for image", {
                context: "AI",
                imageIndex: i,
                error: imgError.message,
              });
            }
          }

          // Mark task as completed
          await db.task.update({
            where: { id: bulkTask.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: JSON.stringify({ generatedAltTexts }),
            },
          });

          return json({ success: true, generatedAltTexts });
        } catch (error: any) {
          await db.task.update({
            where: { id: bulkTask.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: (error.message || String(error)).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "translateAltText": {
        const imageIndex = parseInt(formData.get("imageIndex") as string);
        const sourceAltText = formData.get("sourceAltText") as string;
        const targetLocale = formData.get("targetLocale") as string;
        const primaryLocale = formData.get("primaryLocale") as string;

        if (!sourceAltText) {
          return json({ success: false, error: "No source alt-text available" }, { status: 400 });
        }

        // Build the prompt
        const prompt = buildTranslationPrompt(sourceAltText, primaryLocale, targetLocale);

        // Create task entry with prompt
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "translation",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: `altText_${imageIndex}`,
            fieldType: `altText_${imageIndex}`,
            targetLocale,
            progress: 0,
            prompt,
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

          logger.debug("[API-AI] Translating alt-text", {
            context: "AI",
            imageIndex,
            from: primaryLocale,
            to: targetLocale,
            textLength: sourceAltText.length
          });

          const translatedAltText = await aiService.translateContent(sourceAltText, primaryLocale, targetLocale);

          // Update task to completed with full AI response
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: translatedAltText,
            },
          });

          return json({
            success: true,
            translatedAltText,
            imageIndex,
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

      case "translateAltTextToAllLocales": {
        const imageIndex = parseInt(formData.get("imageIndex") as string);
        const sourceAltText = formData.get("sourceAltText") as string;
        const targetLocalesJson = formData.get("targetLocales") as string;
        const primaryLocale = formData.get("primaryLocale") as string;
        const productId = formData.get("productId") as string;

        if (!sourceAltText) {
          return json({ success: false, error: "No source alt-text available" }, { status: 400 });
        }

        const targetLocales = targetLocalesJson ? JSON.parse(targetLocalesJson) : [];
        if (targetLocales.length === 0) {
          return json({ success: false, error: "No target locales specified" }, { status: 400 });
        }

        // Build prompts for all locales
        const allPrompts = targetLocales.map((locale: string) => ({
          locale,
          prompt: buildTranslationPrompt(sourceAltText, primaryLocale, locale)
        }));

        // Create task entry with prompts
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "translationBulk",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: `altText_${imageIndex}`,
            fieldType: `altText_${imageIndex}`,
            progress: 0,
            prompt: JSON.stringify(allPrompts, null, 2),
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

          logger.debug("[API-AI] Translating alt-text to all locales", {
            context: "AI",
            imageIndex,
            from: primaryLocale,
            to: targetLocales,
            textLength: sourceAltText.length
          });

          const translatedAltTexts: Record<string, string> = {};
          const aiResponses: Array<{ locale: string; response: string }> = [];
          const totalLocales = targetLocales.length;

          // Translate to each locale
          for (let i = 0; i < targetLocales.length; i++) {
            const locale = targetLocales[i];
            try {
              const translatedValue = await aiService.translateContent(sourceAltText, primaryLocale, locale);
              translatedAltTexts[locale] = translatedValue;
              aiResponses.push({ locale, response: translatedValue });

              // Update progress
              const progress = Math.round(10 + ((i + 1) / totalLocales) * 80);
              await db.task.update({
                where: { id: task.id },
                data: { progress },
              });

              logger.debug("[API-AI] Translated alt-text to locale", {
                context: "AI",
                imageIndex,
                locale
              });
            } catch (error: any) {
              logger.error("[API-AI] Error translating alt-text to locale", {
                context: "AI",
                imageIndex,
                locale,
                error: error?.message
              });
              translatedAltTexts[locale] = sourceAltText; // Fallback to original
              aiResponses.push({ locale, response: `ERROR: ${error?.message}` });
            }
          }

          // Now save the translations to Shopify and DB
          if (productId && contentType === 'products') {
            const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
            const gateway = new ShopifyApiGateway(admin, session.shop);

            // Get DB product image to find mediaId
            const dbProduct = await db.product.findUnique({
              where: { id: productId },
              include: {
                images: {
                  orderBy: { position: 'asc' },
                },
              },
            });

            const dbImage = dbProduct?.images?.[imageIndex];

            if (dbImage?.mediaId) {
              // First, fetch the translatable content to get the digest
              const translatableResponse = await gateway.graphql(
                `#graphql
                  query translatableContent($resourceId: ID!) {
                    translatableResource(resourceId: $resourceId) {
                      resourceId
                      translatableContent {
                        key
                        digest
                        value
                      }
                    }
                  }`,
                { variables: { resourceId: dbImage.mediaId } }
              );

              const translatableData = await translatableResponse.json();
              const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
              const altDigest = translatableContent.find((c: any) => c.key === "alt")?.digest;

              if (altDigest) {
                // Save each translation to Shopify
                for (const locale of targetLocales) {
                  const altText = translatedAltTexts[locale];
                  if (!altText) continue;

                  try {
                    const translateResponse = await gateway.graphql(
                      `#graphql
                        mutation translateMediaImage($resourceId: ID!, $translations: [TranslationInput!]!) {
                          translationsRegister(resourceId: $resourceId, translations: $translations) {
                            userErrors {
                              field
                              message
                            }
                            translations {
                              locale
                              key
                              value
                            }
                          }
                        }`,
                      {
                        variables: {
                          resourceId: dbImage.mediaId,
                          translations: [
                            {
                              key: "alt",
                              value: altText,
                              locale: locale,
                              translatableContentDigest: altDigest,
                            },
                          ],
                        },
                      }
                    );

                    const translateData = await translateResponse.json();
                    if (translateData.data?.translationsRegister?.userErrors?.length > 0) {
                      logger.error("[API-AI] Failed to save alt-text translation to Shopify", {
                        context: "AI",
                        locale,
                        errors: translateData.data.translationsRegister.userErrors,
                      });
                    } else {
                      logger.debug("[API-AI] Saved alt-text translation to Shopify", {
                        context: "AI",
                        locale
                      });
                    }
                  } catch (shopifyError: any) {
                    logger.error("[API-AI] Error saving alt-text to Shopify", {
                      context: "AI",
                      locale,
                      error: shopifyError?.message
                    });
                  }
                }
              }
            }

            // Save translations to DB
            if (dbImage) {
              try {
                for (const locale of targetLocales) {
                  const altText = translatedAltTexts[locale];
                  if (!altText) continue;

                  const existing = await db.productImageAltTranslation.findUnique({
                    where: {
                      imageId_locale: {
                        imageId: dbImage.id,
                        locale: locale,
                      },
                    },
                  });

                  if (existing) {
                    await db.productImageAltTranslation.update({
                      where: { id: existing.id },
                      data: { altText },
                    });
                  } else {
                    await db.productImageAltTranslation.create({
                      data: {
                        imageId: dbImage.id,
                        locale: locale,
                        altText: altText,
                      },
                    });
                  }
                }
                logger.debug("[API-AI] Saved alt-text translations to DB", {
                  context: "AI",
                  imageIndex,
                  locales: targetLocales,
                });
              } catch (dbError: any) {
                // If the image was deleted by a concurrent sync, log and continue
                if (dbError.code === 'P2003' || dbError.message?.includes('Foreign key constraint')) {
                  logger.error("[API-AI] Image was deleted during translation save (concurrent sync)", {
                    context: "AI",
                    imageIndex,
                    productId,
                    error: dbError.message,
                  });
                } else {
                  throw dbError; // Re-throw other errors
                }
              }
            }
          }

          // Update task to completed with all AI responses
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: JSON.stringify(aiResponses, null, 2),
            },
          });

          return json({
            success: true,
            translatedAltTexts,
            imageIndex,
            targetLocales
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

      case "translateAllAltTextsToAllLocales": {
        const altTextsDataJson = formData.get("altTextsData") as string;
        const targetLocalesJson = formData.get("targetLocales") as string;
        const primaryLocale = formData.get("primaryLocale") as string;
        const productId = formData.get("productId") as string;

        if (!altTextsDataJson) {
          return json({ success: false, error: "No alt-text data provided" }, { status: 400 });
        }

        const altTextsData: Record<string, string> = JSON.parse(altTextsDataJson);
        const targetLocales: string[] = targetLocalesJson ? JSON.parse(targetLocalesJson) : [];
        const imageIndices = Object.keys(altTextsData).map(Number);

        if (targetLocales.length === 0 || imageIndices.length === 0) {
          return json({ success: false, error: "No target locales or images specified" }, { status: 400 });
        }

        // Create task
        const bulkAllTask = await db.task.create({
          data: {
            shop: session.shop,
            type: "translationBulk",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: `allAltTexts`,
            fieldType: "allAltTexts",
            progress: 0,
            expiresAt: getTaskExpirationDate(),
          },
        });

        try {
          await db.task.update({
            where: { id: bulkAllTask.id },
            data: { status: "running", progress: 5 },
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
            bulkAllTask.id
          );

          const totalOperations = imageIndices.length * targetLocales.length;
          let completedOperations = 0;
          // translatedResults[imageIndex][locale] = translatedText
          const translatedResults: Record<number, Record<string, string>> = {};

          for (const imgIdx of imageIndices) {
            const sourceAltText = altTextsData[String(imgIdx)];
            translatedResults[imgIdx] = {};

            for (const locale of targetLocales) {
              try {
                const translatedValue = await aiService.translateContent(sourceAltText, primaryLocale, locale);
                translatedResults[imgIdx][locale] = translatedValue;
              } catch (error: any) {
                logger.error("[API-AI] Error translating alt-text for image to locale", {
                  context: "AI",
                  imageIndex: imgIdx,
                  locale,
                  error: error?.message,
                });
                translatedResults[imgIdx][locale] = sourceAltText; // Fallback
              }

              completedOperations++;
              const progress = Math.round(5 + (completedOperations / totalOperations) * 75);
              await db.task.update({
                where: { id: bulkAllTask.id },
                data: { progress },
              });
            }
          }

          // Save translations to Shopify and DB
          if (productId && contentType === 'products') {
            const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
            const gateway = new ShopifyApiGateway(admin, session.shop);

            const dbProduct = await db.product.findUnique({
              where: { id: productId },
              include: {
                images: { orderBy: { position: 'asc' } },
              },
            });

            for (const imgIdx of imageIndices) {
              const dbImage = dbProduct?.images?.[imgIdx];
              if (!dbImage?.mediaId) continue;

              try {
                // Fetch translatable content digest
                const translatableResponse = await gateway.graphql(
                  `#graphql
                    query translatableContent($resourceId: ID!) {
                      translatableResource(resourceId: $resourceId) {
                        resourceId
                        translatableContent {
                          key
                          digest
                          value
                        }
                      }
                    }`,
                  { variables: { resourceId: dbImage.mediaId } }
                );

                const translatableData = await translatableResponse.json();
                const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
                const altDigest = translatableContent.find((c: any) => c.key === "alt")?.digest;

                if (altDigest) {
                  for (const locale of targetLocales) {
                    const altText = translatedResults[imgIdx]?.[locale];
                    if (!altText) continue;

                    try {
                      await gateway.graphql(
                        `#graphql
                          mutation translateMediaImage($resourceId: ID!, $translations: [TranslationInput!]!) {
                            translationsRegister(resourceId: $resourceId, translations: $translations) {
                              userErrors { field message }
                              translations { locale key value }
                            }
                          }`,
                        {
                          variables: {
                            resourceId: dbImage.mediaId,
                            translations: [{
                              key: "alt",
                              value: altText,
                              locale: locale,
                              translatableContentDigest: altDigest,
                            }],
                          },
                        }
                      );
                    } catch (shopifyError: any) {
                      logger.error("[API-AI] Error saving bulk alt-text to Shopify", {
                        context: "AI", imageIndex: imgIdx, locale, error: shopifyError?.message,
                      });
                    }
                  }
                }
              } catch (err: any) {
                logger.error("[API-AI] Error fetching translatable content for image", {
                  context: "AI", imageIndex: imgIdx, error: err?.message,
                });
              }

              // Save to DB
              if (dbImage) {
                try {
                  for (const locale of targetLocales) {
                    const altText = translatedResults[imgIdx]?.[locale];
                    if (!altText) continue;

                    const existing = await db.productImageAltTranslation.findUnique({
                      where: { imageId_locale: { imageId: dbImage.id, locale } },
                    });

                    if (existing) {
                      await db.productImageAltTranslation.update({
                        where: { id: existing.id },
                        data: { altText },
                      });
                    } else {
                      await db.productImageAltTranslation.create({
                        data: { imageId: dbImage.id, locale, altText },
                      });
                    }
                  }
                } catch (dbError: any) {
                  if (dbError.code === 'P2003' || dbError.message?.includes('Foreign key constraint')) {
                    logger.error("[API-AI] Image deleted during bulk translation save", {
                      context: "AI", imageIndex: imgIdx, productId, error: dbError.message,
                    });
                  } else {
                    throw dbError;
                  }
                }
              }
            }
          }

          await db.task.update({
            where: { id: bulkAllTask.id },
            data: { status: "completed", progress: 100, completedAt: new Date() },
          });

          return json({
            success: true,
            translatedCount: targetLocales.length,
            imageCount: imageIndices.length,
          });
        } catch (error: any) {
          await db.task.update({
            where: { id: bulkAllTask.id },
            data: { status: "failed", completedAt: new Date(), error: (error.message || String(error)).substring(0, 1000) },
          });
          throw error;
        }
      }

      case "translateAllAltTextsForLocale": {
        const altTextsDataJson = formData.get("altTextsData") as string;
        const targetLocale = formData.get("targetLocale") as string;
        const primaryLocale = formData.get("primaryLocale") as string;

        if (!altTextsDataJson) {
          return json({ success: false, error: "No alt-text data provided" }, { status: 400 });
        }

        const altTextsData: Record<string, string> = JSON.parse(altTextsDataJson);
        const imageIndices = Object.keys(altTextsData).map(Number);

        if (!targetLocale || imageIndices.length === 0) {
          return json({ success: false, error: "No target locale or images specified" }, { status: 400 });
        }

        // Create task
        const localeTask = await db.task.create({
          data: {
            shop: session.shop,
            type: "translation",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: `allAltTexts`,
            fieldType: "allAltTexts",
            targetLocale,
            progress: 0,
            expiresAt: getTaskExpirationDate(),
          },
        });

        try {
          await db.task.update({
            where: { id: localeTask.id },
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
            localeTask.id
          );

          const translatedAltTexts: Record<number, string> = {};

          for (let i = 0; i < imageIndices.length; i++) {
            const imgIdx = imageIndices[i];
            const sourceAltText = altTextsData[String(imgIdx)];

            try {
              const translatedValue = await aiService.translateContent(sourceAltText, primaryLocale, targetLocale);
              translatedAltTexts[imgIdx] = translatedValue;
            } catch (error: any) {
              logger.error("[API-AI] Error translating alt-text for image", {
                context: "AI", imageIndex: imgIdx, targetLocale, error: error?.message,
              });
              translatedAltTexts[imgIdx] = sourceAltText; // Fallback
            }

            const progress = Math.round(10 + ((i + 1) / imageIndices.length) * 80);
            await db.task.update({
              where: { id: localeTask.id },
              data: { progress },
            });
          }

          await db.task.update({
            where: { id: localeTask.id },
            data: { status: "completed", progress: 100, completedAt: new Date(), result: JSON.stringify(translatedAltTexts) },
          });

          return json({
            success: true,
            translatedAltTexts,
            targetLocale,
          });
        } catch (error: any) {
          await db.task.update({
            where: { id: localeTask.id },
            data: { status: "failed", completedAt: new Date(), error: (error.message || String(error)).substring(0, 1000) },
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
