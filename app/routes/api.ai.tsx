/**
 * Generic AI API Route
 * Handles all AI operations (translate, format, generate) for any content type.
 * This allows parallel AI requests without the page route returning HTML.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { AIService, type AIProvider, toValidProvider } from "../../src/services/ai.service";
import { decryptApiKey } from "../utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { TRANSLATE_CONTENT } from "../graphql/content.mutations";
import { sanitizeSlug } from "../utils/slug.utils";
import { PRODUCTS_CONFIG, COLLECTIONS_CONFIG, BLOGS_CONFIG, PAGES_CONFIG, POLICIES_CONFIG } from "../config/content-fields.config";
import type { ContentEditorConfig } from "../types/content-editor.types";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { safeJsonParse } from "~/utils/validation";
import { sanitizePromptInput } from "~/utils/prompt-sanitizer";
import { extractReadableName } from "~/utils/templates-field-factory";
import { getInstructionWithDefault, getWritingStyleInstructions } from "~/utils/ai-instructions.utils";

/**
 * Get character limit requirements for a field based on its aiInstructionsKey
 */
function getCharacterLimitRequirement(aiInstructionsKey: string): string | null {
  const limits: Record<string, string> = {
    // Titles: 30-70 characters
    productTitle: "30-70 characters",
    collectionTitle: "30-70 characters",
    blogTitle: "30-70 characters",
    pageTitle: "30-70 characters",

    // Descriptions: minimum 150 characters
    productDescription: "minimum 150 characters",
    collectionDescription: "minimum 150 characters",
    blogDescription: "minimum 150 characters",
    pageDescription: "minimum 150 characters",
    policyDescription: "minimum 150 characters",

    // SEO Titles: max 60 characters
    productSeoTitle: "maximum 60 characters",
    collectionSeoTitle: "maximum 60 characters",
    blogSeoTitle: "maximum 60 characters",
    pageSeoTitle: "maximum 60 characters",

    // Meta Descriptions: 120-160 characters
    productMetaDesc: "120-160 characters",
    collectionMetaDesc: "120-160 characters",
    blogMetaDesc: "120-160 characters",
    pageMetaDesc: "120-160 characters",

    // URL Handles (slugs): 50-70 characters
    productHandle: "50-70 characters",
    collectionHandle: "50-70 characters",
    blogHandle: "50-70 characters",
    pageHandle: "50-70 characters",

    // Alt Text: 100-125 characters (optimal for screen readers)
    productAltText: "100-125 characters",
  };

  return limits[aiInstructionsKey] || null;
}

// Map contentType to its config for looking up field definitions
const CONTENT_CONFIGS: Record<string, ContentEditorConfig> = {
  products: PRODUCTS_CONFIG,
  collections: COLLECTIONS_CONFIG,
  blogs: BLOGS_CONFIG,
  pages: PAGES_CONFIG,
  policies: POLICIES_CONFIG,
};

const VALID_CONTENT_TYPES = new Set([
  ...Object.keys(CONTENT_CONFIGS),
  'templates',
  'metaobjects',
]);


/** Shape of a single item from Shopify's translatableContent array. */
interface TranslatableContentItem {
  key: string;
  digest: string;
  value?: string;
}

/** Shape of a Shopify GraphQL response with potential data/errors. */
interface ShopifyGraphQLResponse {
  data?: {
    translatableResource?: {
      resourceId: string;
      translatableContent: TranslatableContentItem[];
    };
    translationsRegister?: {
      userErrors: Array<{ field?: string; message: string }>;
      translations: Array<{ locale: string; key: string; value: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

/** Safely extract an error message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Safely extract an error stack from an unknown thrown value. */
function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

/** Check if an unknown error is a Prisma error with a specific code. */
function isPrismaError(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === code;
}

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

    switch (actionType) {
      case "translateField": {
        const fieldType = getFormString(formData, "fieldType");
        const sourceText = getFormString(formData, "sourceText");
        const targetLocale = getFormString(formData, "targetLocale");
        const primaryLocale = getFormString(formData, "primaryLocale");

        if (!sourceText) {
          return json({ success: false, error: "No source text available" }, { status: 400 });
        }

        // Check if this is a URL slug/handle field
        const isSlugField = fieldType === 'handle' || fieldType === 'slug';

        // Create task entry (prompt is saved by AI service via savePromptToTask)
        const taskFieldLabel = contentType === 'templates' ? extractReadableName(fieldType) : fieldType;
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "translation",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: taskFieldLabel,
            fieldType: taskFieldLabel,
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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
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
        } catch (error: unknown) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: errorMessage(error).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "translateFieldToAllLocales": {
        const fieldType = getFormString(formData, "fieldType");
        const sourceText = getFormString(formData, "sourceText");
        const targetLocalesJson = getFormString(formData, "targetLocales");
        const primaryLocale = getFormString(formData, "primaryLocale");

        if (!sourceText) {
          return json({ success: false, error: "No source text available" }, { status: 400 });
        }

        const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, []) : [];
        if (targetLocales.length === 0) {
          return json({ success: false, error: "No target locales specified" }, { status: 400 });
        }

        // Check if this is a URL slug/handle field
        const isSlugField = fieldType === 'handle' || fieldType === 'slug';

        // Check if this is a short field that can use batch translation
        const SHORT_FIELDS = ['handle', 'slug', 'title', 'seoTitle', 'productType'];
        const isShortField = SHORT_FIELDS.includes(fieldType);

        // Create task entry (prompts will be saved by AI service via savePromptToTask)
        const taskFieldLabel2 = contentType === 'templates' ? extractReadableName(fieldType) : fieldType;
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "bulkTranslation",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: taskFieldLabel2,
            fieldType: taskFieldLabel2,
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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
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
          const rejectedFields: Record<string, string[]> = {};
          const totalLocales = targetLocales.length;

          // For templates: Load ALL themeContent rows for the group to map keys to correct resource IDs.
          // A template group can span multiple Shopify resources (e.g. a JSON template + metaobjects),
          // so each field key must be saved against its own resource ID.
          let templateGroupId: string | null = null;
          let templateResourceId: string | null = null;
          const templateKeyToResourceId = new Map<string, string>();
          if (contentType === 'templates' && itemId) {
            templateGroupId = itemId.replace("group_", "");
            const themeContentRows = await db.themeContent.findMany({
              where: {
                shop: session.shop,
                groupId: templateGroupId
              }
            });
            if (themeContentRows.length > 0) {
              templateResourceId = themeContentRows[0].resourceId;
              // Build key → resourceId map from all rows
              for (const row of themeContentRows) {
                const items = (row.translatableContent as unknown) as Array<{ key: string; value?: string; digest?: string }>;
                if (Array.isArray(items)) {
                  for (const item of items) {
                    templateKeyToResourceId.set(item.key, row.resourceId);
                  }
                }
              }
              logger.info("[API-AI] Found themeContent for templates", {
                context: "AI",
                groupId: templateGroupId,
                resourceCount: themeContentRows.length,
                keyCount: templateKeyToResourceId.size,
                defaultResourceId: templateResourceId
              });
            } else {
              logger.error("[API-AI] No themeContent found - translations will NOT be saved!", {
                context: "AI",
                groupId: templateGroupId,
                shop: session.shop
              });
            }
          }

          // Digest cache: fetches translatableContent once per resourceId instead of once per locale
          const digestCache = new Map<string, Map<string, string>>();
          const getCachedDigest = async (resId: string, key: string): Promise<string> => {
            if (!digestCache.has(resId)) {
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
              `, { variables: { resourceId: resId } });
              const digestData = await digestResponse.json();
              const translatableContent = digestData.data?.translatableResource?.translatableContent || [];
              const map = new Map<string, string>();
              for (const c of translatableContent as TranslatableContentItem[]) {
                if (c.digest) map.set(c.key, c.digest);
              }
              digestCache.set(resId, map);
            }
            return digestCache.get(resId)!.get(key) || "";
          };

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
                if (contentType === 'templates' && templateGroupId) {
                  // Use the correct resourceId for this specific field key
                  const fieldResourceId = templateKeyToResourceId.get(fieldType) || templateResourceId;
                  let batchShopifyAccepted = false;

                  if (!fieldResourceId) {
                    logger.error("[API-AI] Batch: No resourceId found for template field", {
                      context: "AI",
                      fieldType,
                      locale
                    });
                    if (!rejectedFields[locale]) rejectedFields[locale] = [];
                    rejectedFields[locale].push(fieldType);
                  } else {
                  try {
                    const digest = await getCachedDigest(fieldResourceId, fieldType);

                    if (!digest) {
                      logger.warn("[API-AI] Batch: No digest for template field — skipping Shopify save", {
                        context: "AI",
                        fieldType,
                        locale,
                        resourceId: fieldResourceId,
                      });
                      if (!rejectedFields[locale]) rejectedFields[locale] = [];
                      rejectedFields[locale].push(fieldType);
                    } else {
                    const translationInput = [{
                      key: fieldType,
                      value: translatedValue,
                      locale: locale,
                      translatableContentDigest: digest
                    }];

                    const templateResponse = await admin.graphql(TRANSLATE_CONTENT, {
                      variables: {
                        resourceId: fieldResourceId,
                        translations: translationInput
                      }
                    });

                    const templateData = await templateResponse.json() as ShopifyGraphQLResponse;

                    if (templateData.errors && templateData.errors.length > 0) {
                      logger.error("[API-AI] Batch: GraphQL error saving template translation", {
                        context: "AI",
                        errors: templateData.errors,
                        locale,
                        fieldType
                      });
                      if (!rejectedFields[locale]) rejectedFields[locale] = [];
                      rejectedFields[locale].push(fieldType);
                    } else if ((templateData.data?.translationsRegister?.userErrors?.length ?? 0) > 0) {
                      logger.error("[API-AI] Batch: Shopify rejected template translation", {
                        context: "AI",
                        errors: templateData.data?.translationsRegister?.userErrors,
                        locale,
                        fieldType
                      });
                      if (!rejectedFields[locale]) rejectedFields[locale] = [];
                      rejectedFields[locale].push(fieldType);
                    } else {
                      batchShopifyAccepted = true;
                    }
                    } // end if digest
                  } catch (shopifyError: unknown) {
                    logger.error("[API-AI] Batch: Error saving template to Shopify", {
                      context: "AI",
                      error: errorMessage(shopifyError),
                      locale,
                      fieldType
                    });
                    if (!rejectedFields[locale]) rejectedFields[locale] = [];
                    rejectedFields[locale].push(fieldType);
                  }
                  } // end if fieldResourceId

                  // Only save to local DB when Shopify accepted
                  if (batchShopifyAccepted && fieldResourceId) {
                    try {
                      await db.themeTranslation.upsert({
                        where: {
                          shop_resourceId_groupId_key_locale: {
                            shop: session.shop,
                            resourceId: fieldResourceId,
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
                          resourceId: fieldResourceId,
                          locale: locale,
                          key: fieldType,
                          value: translatedValue
                        }
                      });
                      logger.debug("[API-AI] Batch: Saved template translation", {
                        context: "AI",
                        locale,
                        fieldType,
                        resourceId: fieldResourceId
                      });
                    } catch (dbError: unknown) {
                      logger.error("[API-AI] Batch: Error saving to DB", {
                        context: "AI",
                        error: errorMessage(dbError),
                        locale,
                        fieldType
                      });
                    }
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
                    const digest = await getCachedDigest(itemId, shopifyKey);

                    const translationInput = [{
                      key: shopifyKey,
                      value: translatedValue,
                      locale: locale,
                      translatableContentDigest: digest
                    }];

                    const shopifyResponse = await admin.graphql(TRANSLATE_CONTENT, {
                      variables: {
                        resourceId: itemId,
                        translations: translationInput
                      }
                    });

                    const shopifyData = await shopifyResponse.json() as ShopifyGraphQLResponse;
                    let shopifyRejected = false;

                    if (shopifyData.errors && shopifyData.errors.length > 0) {
                      logger.error("[API-AI] Batch: GraphQL error saving translation", {
                        context: "AI",
                        errors: shopifyData.errors,
                        locale,
                        shopifyKey
                      });
                      if (!rejectedFields[locale]) rejectedFields[locale] = [];
                      rejectedFields[locale].push(fieldType);
                      shopifyRejected = true;
                    } else if ((shopifyData.data?.translationsRegister?.userErrors?.length ?? 0) > 0) {
                      logger.error("[API-AI] Batch: Shopify rejected translation", {
                        context: "AI",
                        errors: shopifyData.data?.translationsRegister?.userErrors,
                        locale,
                        shopifyKey
                      });
                      if (!rejectedFields[locale]) rejectedFields[locale] = [];
                      rejectedFields[locale].push(fieldType);
                      shopifyRejected = true;
                    }

                    if (!shopifyRejected) {
                      // Only save to local DB when Shopify actually accepted
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
                    }
                  } catch (shopifyError: unknown) {
                    logger.error("[API-AI] Batch: Error sending to Shopify", {
                      context: "AI",
                      error: errorMessage(shopifyError),
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

            } catch (batchError: unknown) {
              logger.error("[API-AI] Batch translation failed, falling back to sequential", {
                context: "AI",
                error: errorMessage(batchError),
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
              if (contentType === 'templates' && templateGroupId) {
                // Use the correct resourceId for this specific field key
                const fieldResourceId = templateKeyToResourceId.get(fieldType) || templateResourceId;
                let seqShopifyAccepted = false;

                if (!fieldResourceId) {
                  logger.error("[API-AI] No resourceId found for template field", {
                    context: "AI",
                    fieldType,
                    locale
                  });
                  if (!rejectedFields[locale]) rejectedFields[locale] = [];
                  rejectedFields[locale].push(fieldType);
                } else {
                try {
                  const digest = await getCachedDigest(fieldResourceId, fieldType);

                  if (!digest) {
                    logger.warn("[API-AI] No digest for template field — skipping Shopify save", {
                      context: "AI",
                      fieldType,
                      locale,
                      resourceId: fieldResourceId,
                    });
                    if (!rejectedFields[locale]) rejectedFields[locale] = [];
                    rejectedFields[locale].push(fieldType);
                  } else {
                  const translationInput = [{
                    key: fieldType,
                    value: translatedValue,
                    locale: locale,
                    translatableContentDigest: digest
                  }];

                  const response = await admin.graphql(TRANSLATE_CONTENT, {
                    variables: {
                      resourceId: fieldResourceId,
                      translations: translationInput
                    }
                  });

                  const data = await response.json() as ShopifyGraphQLResponse;

                  if (data.errors && data.errors.length > 0) {
                    logger.error("[API-AI] Shopify GraphQL errors", {
                      context: "AI",
                      errors: data.errors,
                      locale,
                      fieldType,
                      resourceId: fieldResourceId
                    });
                    if (!rejectedFields[locale]) rejectedFields[locale] = [];
                    rejectedFields[locale].push(fieldType);
                  } else if ((data.data?.translationsRegister?.userErrors?.length ?? 0) > 0) {
                    logger.error("[API-AI] Shopify translation userErrors", {
                      context: "AI",
                      errors: data.data?.translationsRegister?.userErrors,
                      locale,
                      fieldType
                    });
                    if (!rejectedFields[locale]) rejectedFields[locale] = [];
                    rejectedFields[locale].push(fieldType);
                  } else {
                    seqShopifyAccepted = true;
                    logger.info("[API-AI] SUCCESS - Translation saved to Shopify", {
                      context: "AI",
                      resourceId: fieldResourceId,
                      fieldType,
                      locale
                    });
                  }
                  } // end if digest
                } catch (shopifyError: unknown) {
                  logger.error("[API-AI] Exception sending to Shopify", {
                    context: "AI",
                    error: errorMessage(shopifyError),
                    stack: errorStack(shopifyError)?.substring(0, 500),
                    locale,
                    fieldType,
                    resourceId: fieldResourceId
                  });
                  if (!rejectedFields[locale]) rejectedFields[locale] = [];
                  rejectedFields[locale].push(fieldType);
                }
                } // end if fieldResourceId

                // Only save to local DB when Shopify accepted
                if (seqShopifyAccepted && fieldResourceId) {
                  try {
                    await db.themeTranslation.upsert({
                      where: {
                        shop_resourceId_groupId_key_locale: {
                          shop: session.shop,
                          resourceId: fieldResourceId,
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
                        resourceId: fieldResourceId,
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
                  } catch (dbError: unknown) {
                    logger.error("[API-AI] Error saving to DB", {
                      context: "AI",
                      error: errorMessage(dbError),
                      groupId: templateGroupId,
                      fieldType,
                      locale
                    });
                  }
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
                  const digest = await getCachedDigest(itemId, shopifyKey);

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

                  const data = await response.json() as ShopifyGraphQLResponse;
                  let seqRejected = false;

                  if (data.errors && data.errors.length > 0) {
                    logger.error("[API-AI] GraphQL error saving translation for " + contentType, {
                      context: "AI",
                      errors: data.errors,
                      locale,
                      shopifyKey
                    });
                    if (!rejectedFields[locale]) rejectedFields[locale] = [];
                    rejectedFields[locale].push(fieldType);
                    seqRejected = true;
                  } else if ((data.data?.translationsRegister?.userErrors?.length ?? 0) > 0) {
                    logger.error("[API-AI] Shopify rejected translation for " + contentType, {
                      context: "AI",
                      errors: data.data?.translationsRegister?.userErrors,
                      locale,
                      fieldType,
                      shopifyKey
                    });
                    if (!rejectedFields[locale]) rejectedFields[locale] = [];
                    rejectedFields[locale].push(fieldType);
                    seqRejected = true;
                  }

                  if (!seqRejected) {
                    // Only save to local DB when Shopify accepted
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
                } catch (shopifyError: unknown) {
                  logger.error("[API-AI] Error sending to Shopify for " + contentType, {
                    context: "AI",
                    error: errorMessage(shopifyError),
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
            } catch (error: unknown) {
              logger.error("[API-AI] Error translating to locale", {
                context: "AI",
                fieldType,
                locale,
                error: errorMessage(error)
              });
              translations[locale] = sourceText; // Fallback to original
              aiResponses.push({ locale, response: `ERROR: ${errorMessage(error)}` });
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

          if (Object.keys(rejectedFields).length > 0) {
            logger.warn("[API-AI] translateFieldToAllLocales completed with rejected fields", {
              context: "AI",
              fieldType,
              rejectedFields
            });
          }

          return json({
            success: true,
            translations,
            fieldType,
            rejectedFields
          });
        } catch (error: unknown) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: errorMessage(error).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "formatField": {
        const fieldType = getFormString(formData, "fieldType");
        const sourceText = getFormString(formData, "sourceText");
        const formatInstruction = getFormString(formData, "formatInstruction") || "Improve and format this text while keeping the same language";

        if (!sourceText) {
          return json({ success: false, error: "No source text available" }, { status: 400 });
        }

        // Build the prompt
        const prompt = `${formatInstruction}

Text to format:
${sourceText}

Return only the formatted text, without explanations.`;

        // Create task entry with prompt
        const taskFieldLabel3 = contentType === 'templates' ? extractReadableName(fieldType) : fieldType;
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "formatting",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: taskFieldLabel3,
            fieldType: taskFieldLabel3,
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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
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
        } catch (error: unknown) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: errorMessage(error).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "generateAIText": {
        const fieldType = getFormString(formData, "fieldType");
        const currentValue = getFormString(formData, "currentValue");
        const contextTitle = getFormString(formData, "contextTitle") || "";
        const sanitizedContextTitle = sanitizePromptInput(contextTitle, { fieldType: "title" });
        const contextDescription = getFormString(formData, "contextDescription") || "";
        const sanitizedContextDescription = sanitizePromptInput(contextDescription, { fieldType: "description", allowNewlines: true });
        const mainLanguage = getFormString(formData, "mainLanguage") || "German";
        const sendImageToAI = formData.get("sendImageToAI") === "true";
        const imageUrl = getFormString(formData, "imageUrl") || undefined;

        // Load AI instructions for format guidelines
        const genAiInstructions = await db.aIInstructions.findUnique({
          where: { shop: session.shop },
        }) as Record<string, string | null> | null;

        // Resolve field definition for aiInstructionsKey
        const genContentConfig = CONTENT_CONFIGS[contentType];
        const genField = genContentConfig?.fieldDefinitions.find((f) => f.key === fieldType);
        const genInstructionsKey = genField?.aiInstructionsKey;
        const genFormatKey = genInstructionsKey ? `${genInstructionsKey}Format` : null;
        const genInstructionsTextKey = genInstructionsKey ? `${genInstructionsKey}Instructions` : null;
        const genFieldLabel = genField?.label || fieldType;
        const isGenLongContent = genField?.type === "html";

        // Get instructions (with default fallback)
        const writingStyle = getWritingStyleInstructions(genAiInstructions);
        const formatExample = genFormatKey ? getInstructionWithDefault(genAiInstructions, genFormatKey) : null;
        const fieldInstructions = genInstructionsTextKey ? getInstructionWithDefault(genAiInstructions, genInstructionsTextKey) : null;

        // Build field-type-aware prompt
        let prompt = `Create an improved ${genFieldLabel} for the following content.`;

        // Add context information
        prompt += `\n\nContext - Title: ${sanitizedContextTitle}`;
        if (!isGenLongContent && sanitizedContextDescription) {
          prompt += `\nContext - Description: ${sanitizedContextDescription}`;
        }
        if (currentValue) {
          prompt += `\nCurrent ${genFieldLabel}: ${currentValue}`;
        }
        prompt += `\nLanguage: ${mainLanguage}`;

        // Add requirements section
        prompt += `\n\nRequirements:`;

        // Add character limit if available
        const charLimit = genInstructionsKey ? getCharacterLimitRequirement(genInstructionsKey) : null;
        if (charLimit) {
          prompt += `\n- Length: ${charLimit}`;
        }

        if (genField?.type === "slug") {
          prompt += `\n- Use only lowercase letters (a-z), digits (0-9), and hyphens (-)`;
          prompt += `\n- No umlauts - convert them (ä→ae, ö→oe, ü→ue, ß→ss)`;
          prompt += `\n- No spaces, underscores, or special characters`;
          prompt += `\n- 2-5 relevant keywords`;
        } else if (isGenLongContent) {
          prompt += `\n- Use HTML formatting (<h2>, <h3>, <p>, <strong>, <em>, <ul>, <li>)`;
          prompt += `\n- Structure content with headings and paragraphs`;
          prompt += `\n- Focus on readability and user engagement`;
        } else {
          prompt += `\n- Clear and concise`;
          prompt += `\n- SEO-friendly where applicable`;
          prompt += `\n- Customer-focused language`;
        }

        // Add writing style (compact)
        if (writingStyle) {
          prompt += `\n\nWriting Style:\n${writingStyle}`;
        }

        // Add format example (compact)
        if (formatExample) {
          prompt += `\n\nFormat Example (adapt to actual content):\n${formatExample}`;
        }

        // Add field-specific instructions (compact)
        if (fieldInstructions) {
          prompt += `\n\nGuidelines:\n${fieldInstructions}`;
        }

        prompt += `\n\nIMPORTANT: Return ONLY the ${genFieldLabel}, nothing else. Output in ${mainLanguage}.`;

        // Create task entry (prompt is saved by AI service via savePromptToTask)
        const taskFieldLabel4 = contentType === 'templates' ? extractReadableName(fieldType) : fieldType;
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "aiGeneration",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: taskFieldLabel4,
            fieldType: taskFieldLabel4,
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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
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
          const imageUrlToSend = sendImageToAI ? imageUrl : undefined;
          if (isGenLongContent) {
            generatedContent = await aiService.generateProductDescription(sanitizedContextTitle, prompt, imageUrlToSend);
          } else {
            generatedContent = await aiService.generateProductTitle(prompt, imageUrlToSend);
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
        } catch (error: unknown) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: errorMessage(error).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "formatAIText": {
        const fieldType = getFormString(formData, "fieldType");
        const currentValue = getFormString(formData, "currentValue");
        const contextTitle = getFormString(formData, "contextTitle") || "";
        const sanitizedContextTitle = sanitizePromptInput(contextTitle, { fieldType: "title" });
        const contextDescription = getFormString(formData, "contextDescription") || "";
        const sanitizedContextDescription = sanitizePromptInput(contextDescription, { fieldType: "description", allowNewlines: true });
        const mainLanguage = getFormString(formData, "mainLanguage") || "German";
        const sendImageToAI = formData.get("sendImageToAI") === "true";
        const imageUrl = getFormString(formData, "imageUrl") || undefined;

        if (!currentValue) {
          return json({ success: false, error: "No content available to format" }, { status: 400 });
        }

        // Load AI instructions for format examples and guidelines
        // Cast to Record for dynamic key access (keys are built from aiInstructionsKey)
        const aiInstructions = await db.aIInstructions.findUnique({
          where: { shop: session.shop },
        }) as Record<string, string | null> | null;

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

Context - Title: ${sanitizedContextTitle}

Allowed formatting changes for handles:
- Convert to lowercase
- Replace spaces with hyphens
- Convert umlauts (ä→ae, ö→oe, ü→ue, ß→ss)
- Remove special characters
- Remove excessive hyphens`;
          if (formatKey) {
            const formatExample = getInstructionWithDefault(aiInstructions, formatKey);
            if (formatExample) {
              prompt += `\n\nFormat Style Example:\n${formatExample}`;
            }
          }
          if (instructionsTextKey) {
            const fieldInstructions = getInstructionWithDefault(aiInstructions, instructionsTextKey);
            if (fieldInstructions) {
              prompt += `\n\nAdditional Instructions:\n${fieldInstructions}`;
            }
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
          if (formatKey) {
            const formatExample = getInstructionWithDefault(aiInstructions, formatKey);
            if (formatExample) {
              prompt += `\n\nFormat Style Example (for HTML structure reference):\n${formatExample}`;
            }
          }
          if (instructionsTextKey) {
            const fieldInstructions = getInstructionWithDefault(aiInstructions, instructionsTextKey);
            if (fieldInstructions) {
              prompt += `\n\nAdditional Instructions:\n${fieldInstructions}`;
            }
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
          if (formatKey) {
            const formatExample = getInstructionWithDefault(aiInstructions, formatKey);
            if (formatExample) {
              prompt += `\n\nFormat Style Example (use as structural reference, adapt to the actual content):\n${formatExample}`;
            }
          }
          if (instructionsTextKey) {
            const fieldInstructions = getInstructionWithDefault(aiInstructions, instructionsTextKey);
            if (fieldInstructions) {
              prompt += `\n\nAdditional Instructions:\n${fieldInstructions}`;
            }
          }
          prompt += `\n\nReturn ONLY the formatted ${fieldLabel} as plain text (no HTML). Keep the original language. Output the result in ${mainLanguage}.`;
        }

        // Create task entry (prompt is saved by AI service via savePromptToTask)
        const taskFieldLabel5 = contentType === 'templates' ? extractReadableName(fieldType) : fieldType;
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "formatting",
            status: "pending",
            resourceType: contentType,
            resourceId: itemId,
            resourceTitle: taskFieldLabel5,
            fieldType: taskFieldLabel5,
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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
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
          const imageUrlToSend = sendImageToAI ? imageUrl : undefined;
          if (isLongContent) {
            formattedValue = await aiService.generateProductDescription(currentValue, prompt, imageUrlToSend);
          } else {
            formattedValue = await aiService.generateProductTitle(prompt, imageUrlToSend);
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
        } catch (error: unknown) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: errorMessage(error).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "generateAltText": {
        const imageIndex = parseInt(getFormString(formData, "imageIndex"), 10);
        const imageUrl = getFormString(formData, "imageUrl");
        const productTitle = getFormString(formData, "productTitle");
        const mainLanguage = getFormString(formData, "mainLanguage") || "German";
        const sendImageToAI = formData.get("sendImageToAI") === "true";

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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
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
Image URL: ${imageUrl}${mainLanguage ? `\nLanguage: ${mainLanguage}` : ''}`;

          // Add requirements
          prompt += `\n\nRequirements:`;
          const altTextCharLimit = getCharacterLimitRequirement("productAltText");
          if (altTextCharLimit) {
            prompt += `\n- Length: ${altTextCharLimit}`;
          }
          prompt += `\n- Describe what's visible in the image`;
          prompt += `\n- Include product name or key feature`;
          prompt += `\n- Accessible and helpful for screen readers`;

          const altTextFormat = getInstructionWithDefault(aiInstructions, "productAltTextFormat");
          if (altTextFormat) {
            prompt += `\n\nFormat Example:\n${altTextFormat}`;
          }

          const altTextInstructions = getInstructionWithDefault(aiInstructions, "productAltTextInstructions");
          if (altTextInstructions) {
            prompt += `\n\nGuidelines:\n${altTextInstructions}`;
          }

          prompt += `\n\nIMPORTANT: Return ONLY the alt text, nothing else.${mainLanguage ? ` Output in ${mainLanguage}.` : ''}`;

          const altText = await aiService.generateImageAltText(imageUrl, productTitle, prompt, sendImageToAI);

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
        } catch (error: unknown) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: errorMessage(error).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "generateAllAltTexts": {
        const productId = getFormString(formData, "productId");
        const productTitle = getFormString(formData, "productTitle");
        const mainLanguage = getFormString(formData, "mainLanguage") || "German";
        const imagesDataJson = getFormString(formData, "imagesData");
        const sendImageToAI = formData.get("sendImageToAI") === "true";

        if (!imagesDataJson) {
          return json({ success: false, error: "No images data provided" }, { status: 400 });
        }

        const imagesData = safeJsonParse<Array<{ url: string }>>(imagesDataJson, []);
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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
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
Image URL: ${image.url}${mainLanguage ? `\nLanguage: ${mainLanguage}` : ''}`;

              // Add requirements
              prompt += `\n\nRequirements:`;
              const bulkAltTextCharLimit = getCharacterLimitRequirement("productAltText");
              if (bulkAltTextCharLimit) {
                prompt += `\n- Length: ${bulkAltTextCharLimit}`;
              }
              prompt += `\n- Describe what's visible in the image`;
              prompt += `\n- Include product name or key feature`;
              prompt += `\n- Accessible and helpful for screen readers`;

              const bulkAltTextFormat = getInstructionWithDefault(altTextInstructions, "productAltTextFormat");
              if (bulkAltTextFormat) {
                prompt += `\n\nFormat Example:\n${bulkAltTextFormat}`;
              }

              const bulkAltTextInstructions = getInstructionWithDefault(altTextInstructions, "productAltTextInstructions");
              if (bulkAltTextInstructions) {
                prompt += `\n\nGuidelines:\n${bulkAltTextInstructions}`;
              }

              prompt += `\n\nIMPORTANT: Return ONLY the alt text, nothing else.${mainLanguage ? ` Output in ${mainLanguage}.` : ''}`;

              const altText = await bulkAiService.generateImageAltText(image.url, productTitle, prompt, sendImageToAI);
              generatedAltTexts[i] = altText;

              const progressPercent = Math.round(10 + ((i + 1) / totalImages) * 90);
              await db.task.update({
                where: { id: bulkTask.id },
                data: { progress: progressPercent, processed: i + 1 },
              });
            } catch (imgError: unknown) {
              logger.error("[API-AI] Failed to generate alt-text for image", {
                context: "AI",
                imageIndex: i,
                error: errorMessage(imgError),
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
        } catch (error: unknown) {
          await db.task.update({
            where: { id: bulkTask.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: errorMessage(error).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "translateAltText": {
        const imageIndex = parseInt(getFormString(formData, "imageIndex"), 10);
        const sourceAltText = getFormString(formData, "sourceAltText");
        const targetLocale = getFormString(formData, "targetLocale");
        const primaryLocale = getFormString(formData, "primaryLocale");

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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
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
        } catch (error: unknown) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: errorMessage(error).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "translateAltTextToAllLocales": {
        const imageIndex = parseInt(getFormString(formData, "imageIndex"), 10);
        const sourceAltText = getFormString(formData, "sourceAltText");
        const targetLocalesJson = getFormString(formData, "targetLocales");
        const primaryLocale = getFormString(formData, "primaryLocale");
        const productId = getFormString(formData, "productId");

        if (!sourceAltText) {
          return json({ success: false, error: "No source alt-text available" }, { status: 400 });
        }

        const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, []) : [];
        if (targetLocales.length === 0) {
          return json({ success: false, error: "No target locales specified" }, { status: 400 });
        }

        // Create task entry (prompts will be saved by AI service via savePromptToTask)
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "bulkTranslation",
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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
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
            } catch (error: unknown) {
              logger.error("[API-AI] Error translating alt-text to locale", {
                context: "AI",
                imageIndex,
                locale,
                error: errorMessage(error)
              });
              translatedAltTexts[locale] = sourceAltText; // Fallback to original
              aiResponses.push({ locale, response: `ERROR: ${errorMessage(error)}` });
            }
          }

          // Save translations to Shopify first, then DB only on success
          const failedLocales: string[] = [];

          if (productId && contentType === 'products') {
            const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
            const gateway = new ShopifyApiGateway(admin, session.shop);

            const dbProduct = await db.product.findUnique({
              where: { id: productId },
              include: {
                images: { orderBy: { position: 'asc' } },
              },
            });

            const dbImage = dbProduct?.images?.[imageIndex];

            if (!dbImage?.mediaId) {
              logger.warn("[API-AI] No mediaId for image - cannot save alt-text translations to Shopify", {
                context: "AI", imageIndex, productId,
              });
              failedLocales.push(...targetLocales);
            } else {
              // Fetch digest once
              let altDigest: string | undefined;
              try {
                const translatableResponse = await gateway.graphql(
                  `#graphql
                    query translatableContent($resourceId: ID!) {
                      translatableResource(resourceId: $resourceId) {
                        resourceId
                        translatableContent { key digest value }
                      }
                    }`,
                  { variables: { resourceId: dbImage.mediaId } }
                );
                const translatableData = await translatableResponse.json();
                const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
                altDigest = translatableContent.find((c: TranslatableContentItem) => c.key === "alt")?.digest;
              } catch (err: unknown) {
                logger.error("[API-AI] Error fetching translatable content for alt-text", {
                  context: "AI", imageIndex, error: errorMessage(err),
                });
              }

              if (!altDigest) {
                logger.warn("[API-AI] No digest for alt-text - cannot save to Shopify", {
                  context: "AI", imageIndex, mediaId: dbImage.mediaId,
                });
                failedLocales.push(...targetLocales);
              } else {
                // Save each locale: Shopify first, then DB
                for (const locale of targetLocales) {
                  const altText = translatedAltTexts[locale];
                  if (!altText) continue;

                  let shopifySaved = false;
                  try {
                    const translateResponse = await gateway.graphql(
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
                    const translateData = await translateResponse.json();
                    const userErrors = translateData.data?.translationsRegister?.userErrors || [];
                    if (userErrors.length === 0) {
                      shopifySaved = true;
                    } else {
                      logger.error("[API-AI] Shopify translationsRegister userErrors for alt-text", {
                        context: "AI", locale, errors: userErrors,
                      });
                    }
                  } catch (shopifyError: unknown) {
                    logger.error("[API-AI] Error saving alt-text to Shopify", {
                      context: "AI", locale, error: errorMessage(shopifyError),
                    });
                  }

                  if (shopifySaved && dbImage) {
                    try {
                      const existing = await db.productImageAltTranslation.findUnique({
                        where: { imageId_locale: { imageId: dbImage.id, locale } },
                      });
                      if (existing) {
                        await db.productImageAltTranslation.update({ where: { id: existing.id }, data: { altText } });
                      } else {
                        await db.productImageAltTranslation.create({ data: { imageId: dbImage.id, locale, altText } });
                      }
                    } catch (dbError: unknown) {
                      if (isPrismaError(dbError, 'P2003') || errorMessage(dbError).includes('Foreign key constraint')) {
                        logger.error("[API-AI] Image deleted during translation save", {
                          context: "AI", imageIndex, productId, error: errorMessage(dbError),
                        });
                      } else {
                        throw dbError;
                      }
                    }
                  } else if (!shopifySaved) {
                    failedLocales.push(locale);
                  }
                }
              }
            }
          }

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
            targetLocales,
            failedLocales,
          });
        } catch (error: unknown) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: errorMessage(error).substring(0, 1000),
            },
          });
          throw error;
        }
      }

      case "translateAllAltTextsToAllLocales": {
        const altTextsDataJson = getFormString(formData, "altTextsData");
        const targetLocalesJson = getFormString(formData, "targetLocales");
        const primaryLocale = getFormString(formData, "primaryLocale");
        const productId = getFormString(formData, "productId");

        if (!altTextsDataJson) {
          return json({ success: false, error: "No alt-text data provided" }, { status: 400 });
        }

        const altTextsData = safeJsonParse<Record<string, string>>(altTextsDataJson, {});
        const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, []) : [];
        const imageIndices = Object.keys(altTextsData).map(Number);

        if (targetLocales.length === 0 || imageIndices.length === 0) {
          return json({ success: false, error: "No target locales or images specified" }, { status: 400 });
        }

        // Create task
        const bulkAllTask = await db.task.create({
          data: {
            shop: session.shop,
            type: "bulkTranslation",
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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
            },
            session.shop,
            bulkAllTask.id
          );

          // Batch translate all alt-texts to all locales in a single AI request
          let translatedResults: Record<string, Record<string, string>> = {};
          try {
            translatedResults = await aiService.translateAltTextsBatch(
              altTextsData, primaryLocale, targetLocales, contentType
            );
          } catch (error: unknown) {
            logger.error("[API-AI] Error batch-translating alt-texts to all locales", {
              context: "AI", error: errorMessage(error),
            });
            // Fallback: use source texts for all
            for (const imgIdx of imageIndices) {
              translatedResults[String(imgIdx)] = {};
              for (const locale of targetLocales) {
                translatedResults[String(imgIdx)][locale] = altTextsData[String(imgIdx)];
              }
            }
          }

          await db.task.update({
            where: { id: bulkAllTask.id },
            data: { progress: 80 },
          });

          // Save translations to Shopify first, then DB only on Shopify success
          const failedImages: number[] = [];
          let savedCount = 0;

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
              if (!dbImage) {
                logger.warn("[API-AI] No DB image found for index", { context: "AI", imageIndex: imgIdx, productId });
                failedImages.push(imgIdx);
                continue;
              }

              // Shopify save requires mediaId
              if (!dbImage.mediaId) {
                logger.warn("[API-AI] No mediaId for image, cannot save to Shopify", {
                  context: "AI", imageIndex: imgIdx, productId,
                });
                failedImages.push(imgIdx);
                continue;
              }

              // Fetch translatable content digest
              let altDigest: string | undefined;
              try {
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
                altDigest = translatableContent.find((c: TranslatableContentItem) => c.key === "alt")?.digest;
              } catch (err: unknown) {
                logger.error("[API-AI] Error fetching translatable content for image", {
                  context: "AI", imageIndex: imgIdx, error: errorMessage(err),
                });
              }

              if (!altDigest) {
                logger.warn("[API-AI] No digest found for alt-text, cannot save to Shopify", {
                  context: "AI", imageIndex: imgIdx, mediaId: dbImage.mediaId,
                });
                failedImages.push(imgIdx);
                continue;
              }

              // Save each locale to Shopify, then to DB
              let imageFullySaved = true;
              for (const locale of targetLocales) {
                const altText = translatedResults[imgIdx]?.[locale];
                if (!altText) continue;

                let shopifySaved = false;
                try {
                  const shopifyResult = await gateway.graphql(
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
                  const shopifyData = await shopifyResult.json();
                  const userErrors = shopifyData.data?.translationsRegister?.userErrors || [];
                  if (userErrors.length === 0) {
                    shopifySaved = true;
                  } else {
                    logger.error("[API-AI] Shopify translationsRegister userErrors for alt-text", {
                      context: "AI", imageIndex: imgIdx, locale, errors: userErrors,
                    });
                  }
                } catch (shopifyError: unknown) {
                  logger.error("[API-AI] Error saving bulk alt-text to Shopify", {
                    context: "AI", imageIndex: imgIdx, locale, error: errorMessage(shopifyError),
                  });
                }

                // Only save to DB if Shopify save succeeded
                if (shopifySaved) {
                  try {
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
                    savedCount++;
                  } catch (dbError: unknown) {
                    if (isPrismaError(dbError, 'P2003') || errorMessage(dbError).includes('Foreign key constraint')) {
                      logger.error("[API-AI] Image deleted during bulk translation save", {
                        context: "AI", imageIndex: imgIdx, productId, error: errorMessage(dbError),
                      });
                    } else {
                      throw dbError;
                    }
                  }
                } else {
                  imageFullySaved = false;
                }
              }

              if (!imageFullySaved && !failedImages.includes(imgIdx)) {
                failedImages.push(imgIdx);
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
            savedCount,
            failedImages,
            translatedResults,
          });
        } catch (error: unknown) {
          await db.task.update({
            where: { id: bulkAllTask.id },
            data: { status: "failed", completedAt: new Date(), error: errorMessage(error).substring(0, 1000) },
          });
          throw error;
        }
      }

      case "translateAllAltTextsForLocale": {
        const altTextsDataJson = getFormString(formData, "altTextsData");
        const targetLocale = getFormString(formData, "targetLocale");
        const primaryLocale = getFormString(formData, "primaryLocale");

        if (!altTextsDataJson) {
          return json({ success: false, error: "No alt-text data provided" }, { status: 400 });
        }

        const altTextsData = safeJsonParse<Record<string, string>>(altTextsDataJson, {});
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
            toValidProvider(settings?.preferredProvider),
            {
              huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
              geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
              claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
              openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
              grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
              deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
              selectedModel: settings?.selectedModel || undefined,
            },
            session.shop,
            localeTask.id
          );

          // Batch translate all alt-texts for this locale in a single AI request
          const translatedAltTexts: Record<number, string> = {};
          try {
            const batchResult = await aiService.translateAltTextsBatch(
              altTextsData, primaryLocale, [targetLocale], contentType
            );
            for (const [imgIdx, localeMap] of Object.entries(batchResult)) {
              translatedAltTexts[Number(imgIdx)] = localeMap[targetLocale] || altTextsData[imgIdx];
            }
          } catch (error: unknown) {
            logger.error("[API-AI] Error batch-translating alt-texts for locale", {
              context: "AI", targetLocale, error: errorMessage(error),
            });
            // Fallback: use source texts
            for (const imgIdx of imageIndices) {
              translatedAltTexts[imgIdx] = altTextsData[String(imgIdx)];
            }
          }

          await db.task.update({
            where: { id: localeTask.id },
            data: { progress: 90 },
          });

          // Save translations to Shopify first, then DB only on Shopify success
          const productId = getFormString(formData, "productId");
          const failedImages: number[] = [];
          let savedCount = 0;

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
              if (!dbImage) {
                failedImages.push(imgIdx);
                continue;
              }

              const altText = translatedAltTexts[imgIdx];
              if (!altText) continue;

              // Shopify save requires mediaId + digest
              if (!dbImage.mediaId) {
                logger.warn("[API-AI] No mediaId for image, cannot save to Shopify", {
                  context: "AI", imageIndex: imgIdx, productId,
                });
                failedImages.push(imgIdx);
                continue;
              }

              let altDigest: string | undefined;
              try {
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
                altDigest = translatableContent.find((c: TranslatableContentItem) => c.key === "alt")?.digest;
              } catch (err: unknown) {
                logger.error("[API-AI] Error fetching translatable content for image", {
                  context: "AI", imageIndex: imgIdx, error: errorMessage(err),
                });
              }

              if (!altDigest) {
                logger.warn("[API-AI] No digest found for alt-text, cannot save to Shopify", {
                  context: "AI", imageIndex: imgIdx, mediaId: dbImage.mediaId,
                });
                failedImages.push(imgIdx);
                continue;
              }

              let shopifySaved = false;
              try {
                const shopifyResult = await gateway.graphql(
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
                        locale: targetLocale,
                        translatableContentDigest: altDigest,
                      }],
                    },
                  }
                );
                const shopifyData = await shopifyResult.json();
                const userErrors = shopifyData.data?.translationsRegister?.userErrors || [];
                if (userErrors.length === 0) {
                  shopifySaved = true;
                } else {
                  logger.error("[API-AI] Shopify translationsRegister userErrors for alt-text", {
                    context: "AI", imageIndex: imgIdx, targetLocale, errors: userErrors,
                  });
                }
              } catch (shopifyError: unknown) {
                logger.error("[API-AI] Error saving alt-text to Shopify for locale", {
                  context: "AI", imageIndex: imgIdx, targetLocale, error: errorMessage(shopifyError),
                });
              }

              // Only save to DB if Shopify save succeeded
              if (shopifySaved) {
                try {
                  const existing = await db.productImageAltTranslation.findUnique({
                    where: { imageId_locale: { imageId: dbImage.id, locale: targetLocale } },
                  });
                  if (existing) {
                    await db.productImageAltTranslation.update({
                      where: { id: existing.id },
                      data: { altText },
                    });
                  } else {
                    await db.productImageAltTranslation.create({
                      data: { imageId: dbImage.id, locale: targetLocale, altText },
                    });
                  }
                  savedCount++;
                } catch (dbError: unknown) {
                  if (isPrismaError(dbError, 'P2003') || errorMessage(dbError).includes('Foreign key constraint')) {
                    logger.error("[API-AI] Image deleted during alt-text locale save", {
                      context: "AI", imageIndex: imgIdx, productId, error: errorMessage(dbError),
                    });
                  } else {
                    throw dbError;
                  }
                }
              } else {
                failedImages.push(imgIdx);
              }
            }
          }

          await db.task.update({
            where: { id: localeTask.id },
            data: { status: "completed", progress: 100, completedAt: new Date(), result: JSON.stringify(translatedAltTexts) },
          });

          return json({
            success: true,
            translatedAltTexts,
            targetLocale,
            savedCount,
            failedImages,
          });
        } catch (error: unknown) {
          await db.task.update({
            where: { id: localeTask.id },
            data: { status: "failed", completedAt: new Date(), error: errorMessage(error).substring(0, 1000) },
          });
          throw error;
        }
      }

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
