/**
 * Generic AI API Route
 * Handles all AI operations (translate, format, generate) for any content type.
 * This allows parallel AI requests without the page route returning HTML.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { AIService } from "../../src/services/ai.service";
import { decryptApiKey } from "../utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { TRANSLATE_CONTENT } from "../graphql/content.mutations";
import { sanitizeSlug } from "../utils/slug.utils";
import { PRODUCTS_CONFIG, COLLECTIONS_CONFIG, BLOGS_CONFIG, PAGES_CONFIG, POLICIES_CONFIG } from "../config/content-fields.config";
import type { ContentEditorConfig } from "../types/content-editor.types";

// Map contentType to its config for looking up field definitions
const CONTENT_CONFIGS: Record<string, ContentEditorConfig> = {
  products: PRODUCTS_CONFIG,
  collections: COLLECTIONS_CONFIG,
  blogs: BLOGS_CONFIG,
  pages: PAGES_CONFIG,
  policies: POLICIES_CONFIG,
};


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

        // Create task entry (prompt is saved by AI service via savePromptToTask)
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
            // prompt is saved by AI service via savePromptToTask
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

        // Create task entry (prompts will be saved by AI service via savePromptToTask)
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
                    productType: "product_type",
                    summary: "summary_html",
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

                    // Also save to local DB so revalidation picks it up immediately
                    const resourceTypeMap: Record<string, string> = {
                      products: "Product", collections: "Collection",
                      pages: "Page", blogs: "Article", policies: "ShopPolicy",
                    };
                    await db.contentTranslation.upsert({
                      where: {
                        resourceId_key_locale: {
                          resourceId: itemId,
                          key: shopifyKey,
                          locale,
                        },
                      },
                      update: { value: translatedValue, digest, resourceType: resourceTypeMap[contentType] || "Product" },
                      create: {
                        resourceId: itemId,
                        resourceType: resourceTypeMap[contentType] || "Product",
                        key: shopifyKey,
                        value: translatedValue,
                        locale,
                        digest,
                      },
                    });

                    logger.debug("[API-AI] Batch: Saved translation to Shopify + DB", {
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
                  summary: "summary_html",
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
                    // Also save to local DB so revalidation picks it up immediately
                    const resourceTypeMap: Record<string, string> = {
                      products: "Product", collections: "Collection",
                      pages: "Page", blogs: "Article", policies: "ShopPolicy",
                    };
                    await db.contentTranslation.upsert({
                      where: {
                        resourceId_key_locale: {
                          resourceId: itemId,
                          key: shopifyKey,
                          locale,
                        },
                      },
                      update: { value: translatedValue, digest, resourceType: resourceTypeMap[contentType] || "Product" },
                      create: {
                        resourceId: itemId,
                        resourceType: resourceTypeMap[contentType] || "Product",
                        key: shopifyKey,
                        value: translatedValue,
                        locale,
                        digest,
                      },
                    });

                    logger.debug("[API-AI] Saved translation to Shopify + DB for " + contentType, {
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
            // prompt is saved by AI service via savePromptToTask
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

        // Load AI instructions for format guidelines
        const genAiInstructions = await db.aIInstructions.findUnique({
          where: { shop: session.shop },
        }) as Record<string, any> | null;

        // Resolve field definition for aiInstructionsKey
        const genContentConfig = CONTENT_CONFIGS[contentType];
        const genField = genContentConfig?.fieldDefinitions.find((f) => f.key === fieldType);
        const genInstructionsKey = genField?.aiInstructionsKey;
        const genFormatKey = genInstructionsKey ? `${genInstructionsKey}Format` : null;
        const genInstructionsTextKey = genInstructionsKey ? `${genInstructionsKey}Instructions` : null;
        const genFieldLabel = genField?.label || fieldType;
        const isGenLongContent = genField?.type === "html";

        // Build field-type-aware prompt
        let prompt = "";

        if (genField?.type === "slug") {
          prompt = `Create an optimized URL slug for the following content.

Context - Title: ${contextTitle}
Current slug: ${currentValue || "(empty)"}
Language: ${mainLanguage}

Requirements:
- Use only lowercase letters (a-z), digits (0-9), and hyphens (-)
- No umlauts - convert them (ä→ae, ö→oe, ü→ue, ß→ss)
- No spaces, underscores, or special characters
- 3-5 relevant keywords`;
        } else if (isGenLongContent) {
          prompt = `Create an improved ${genFieldLabel} for the following content.

Context - Title: ${contextTitle}
Current ${genFieldLabel}: ${currentValue || "(empty)"}
Language: ${mainLanguage}

Use HTML formatting (<h2>, <h3>, <p>, <strong>, <em>, <ul>, <li>) for structure.`;
        } else {
          prompt = `Create an improved ${genFieldLabel} for the following content.

Context - Title: ${contextTitle}
Context - Description: ${contextDescription}
Current ${genFieldLabel}: ${currentValue || "(empty)"}
Language: ${mainLanguage}`;
        }

        // Add format example as soft guidance (not strict)
        if (genFormatKey && genAiInstructions?.[genFormatKey]) {
          prompt += `\n\nUse the following as a rough structural guideline (adapt freely to the actual content):\n${genAiInstructions[genFormatKey]}`;
        }
        // Add instructions as guidance
        if (genInstructionsTextKey && genAiInstructions?.[genInstructionsTextKey]) {
          prompt += `\n\nGuidelines:\n${genAiInstructions[genInstructionsTextKey]}`;
        }

        prompt += `\n\nIMPORTANT: Return ONLY the generated ${genFieldLabel}, nothing else. No explanations, no options, no labels. Output the result in ${mainLanguage}.`;

        // Create task entry (prompt is saved by AI service via savePromptToTask)
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

          logger.debug("[API-AI] Generating AI text", {
            context: "AI",
            fieldType,
            textLength: currentValue?.length || 0,
            hasFormatExample: !!(genFormatKey && genAiInstructions?.[genFormatKey]),
            hasInstructions: !!(genInstructionsTextKey && genAiInstructions?.[genInstructionsTextKey]),
          });

          // Use appropriate method based on field type
          let generatedContent: string;
          if (isGenLongContent) {
            generatedContent = await aiService.generateProductDescription(contextTitle, prompt);
          } else {
            generatedContent = await aiService.generateProductTitle(prompt);
          }

          // Sanitize slugs
          if (genField?.type === "slug") {
            generatedContent = sanitizeSlug(generatedContent);
          }

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

        // Load AI instructions for format examples and guidelines
        // Cast to Record for dynamic key access (keys are built from aiInstructionsKey)
        const aiInstructions = await db.aIInstructions.findUnique({
          where: { shop: session.shop },
        }) as Record<string, any> | null;

        // Resolve field definition to get the correct aiInstructionsKey
        const contentConfig = CONTENT_CONFIGS[contentType];
        const field = contentConfig?.fieldDefinitions.find((f) => f.key === fieldType);
        const instructionsKey = field?.aiInstructionsKey;
        const formatKey = instructionsKey ? `${instructionsKey}Format` : null;
        const instructionsTextKey = instructionsKey ? `${instructionsKey}Instructions` : null;

        const fieldLabel = field?.label || fieldType;

        // Determine if this field supports HTML formatting
        // Only description/body fields and blog summary (type "html") get HTML formatting
        const supportsHtmlFormatting = field?.type === "html";

        // Build field-type-aware prompt
        let prompt = "";
        let isLongContent = false;

        if (field?.type === "slug") {
          prompt = `Format the following URL slug. Keep the core words intact.

Original Slug:
${currentValue}

Context - Title: ${contextTitle}

Allowed formatting changes for handles:
- Convert to lowercase
- Replace spaces with hyphens
- Convert umlauts (ä→ae, ö→oe, ü→ue, ß→ss)
- Remove special characters
- Remove excessive hyphens`;
          if (formatKey && aiInstructions?.[formatKey]) {
            prompt += `\n\nFormat Style Example:\n${aiInstructions[formatKey]}`;
          }
          if (instructionsTextKey && aiInstructions?.[instructionsTextKey]) {
            prompt += `\n\nAdditional Instructions:\n${aiInstructions[instructionsTextKey]}`;
          }
          prompt += `\n\nReturn ONLY the formatted URL slug. Keep the original keywords.`;
        } else if (supportsHtmlFormatting) {
          // HTML fields: description, body, blog summary - full HTML formatting allowed
          isLongContent = true;
          prompt = `Apply HTML formatting to the following ${fieldLabel}. Keep the core content and meaning intact, but you may make slight adjustments to improve readability and presentation.

Original ${fieldLabel}:
${currentValue}

You may:
- Add HTML structure tags: <h2>, <h3>, <p>, <ul>, <li>
- Add emphasis: <strong>, <em>
- Convert plain lists to <ul>/<li> format
- Add paragraph breaks with <p> tags
- Fix spacing, punctuation, and grammar
- Slightly rephrase for better flow or clarity (but keep the meaning)

Do NOT:
- Completely rewrite or replace the content
- Add entirely new information or paragraphs
- Change the language or tone significantly`;
          if (formatKey && aiInstructions?.[formatKey]) {
            prompt += `\n\nFormat Style Example (for HTML structure reference):\n${aiInstructions[formatKey]}`;
          }
          if (instructionsTextKey && aiInstructions?.[instructionsTextKey]) {
            prompt += `\n\nAdditional Instructions:\n${aiInstructions[instructionsTextKey]}`;
          }
          prompt += `\n\nReturn ONLY the formatted HTML ${fieldLabel}. Keep the original language. Output the result in ${mainLanguage}.`;
        } else {
          // Text fields (title, seoTitle, metaDescription, etc.) - light formatting only, no HTML
          prompt = `Improve the formatting of the following ${fieldLabel}. Keep the core content intact but you may make slight adjustments to improve presentation.

Original ${fieldLabel}:
${currentValue}

You may:
- Adjust capitalization (e.g., Title Case)
- Add or improve separators (| or - or –)
- Fix punctuation, spacing, and grammar
- Slightly rephrase for better readability or flow

Do NOT:
- Add any HTML tags
- Completely rewrite the content
- Add new information that wasn't there
- Change the language or core meaning`;
          if (formatKey && aiInstructions?.[formatKey]) {
            prompt += `\n\nFormat Style Example (use as structural reference, adapt to the actual content):\n${aiInstructions[formatKey]}`;
          }
          if (instructionsTextKey && aiInstructions?.[instructionsTextKey]) {
            prompt += `\n\nAdditional Instructions:\n${aiInstructions[instructionsTextKey]}`;
          }
          prompt += `\n\nReturn ONLY the formatted ${fieldLabel} as plain text (no HTML). Keep the original language. Output the result in ${mainLanguage}.`;
        }

        // Create task entry (prompt is saved by AI service via savePromptToTask)
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
            textLength: currentValue.length,
            hasFormatExample: !!(formatKey && aiInstructions?.[formatKey]),
            hasInstructions: !!(instructionsTextKey && aiInstructions?.[instructionsTextKey]),
          });

          // Use appropriate method based on field type
          let formattedValue: string;
          if (isLongContent) {
            formattedValue = await aiService.generateProductDescription(currentValue, prompt);
          } else {
            formattedValue = await aiService.generateProductTitle(prompt);
          }

          // Sanitize slugs
          if (field?.type === "slug") {
            formattedValue = sanitizeSlug(formattedValue);
          }

          // Update task to completed with full AI response
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: formattedValue,
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

        // Create task entry (prompt is saved by AI service via savePromptToTask)
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

        // Create task entry (prompts will be saved by AI service via savePromptToTask)
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
