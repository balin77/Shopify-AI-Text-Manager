/**
 * Bulk Translation Actions
 *
 * Handles bulk translation operations:
 * - translateFieldToAllLocales: Translates one field to all enabled locales
 * - translateAll: Translates all product fields to all enabled locales
 */

import { json } from "@remix-run/node";
import { TranslationService } from "../../../src/services/translation.service";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import { loggers } from "~/utils/logger.server";
import type { ActionContext } from "./shared/action-context";
import {
  createProductTask,
  updateTaskProgress,
  completeTask,
  failTask,
} from "./shared/task-helpers";
import { handleActionError } from "./shared/error-handlers";

interface TranslateFieldToAllLocalesParams {
  fieldType: string;
  sourceText: string;
  productId: string;
  targetLocales: string[];
  contextTitle: string;
}

interface TranslateAllParams {
  title?: string;
  description?: string;
  handle?: string;
  seoTitle?: string;
  metaDescription?: string;
  productId: string;
  targetLocales: string[];
}

// Fields that can be batched in a single AI request (short fields)
const BATCH_FIELD_TYPES = ["handle", "title", "seoTitle"];

// Fields that should be translated one locale at a time (long fields)
const SEQUENTIAL_FIELD_TYPES = ["description", "metaDescription"];

/**
 * Translates a single field to all enabled locales
 * Uses batch translation for short fields (handle, title, seoTitle) - 1 AI request for all locales
 * Uses sequential translation for long fields (description, metaDescription) - 1 AI request per locale
 */
export async function handleTranslateFieldToAllLocales(
  context: ActionContext,
  formData: FormData,
  productId: string
): Promise<Response> {
  const action = "translateFieldToAllLocales";

  const { db } = await import("~/db.server");

  const params: TranslateFieldToAllLocalesParams = {
    fieldType: formData.get("fieldType") as string,
    sourceText: formData.get("sourceText") as string,
    productId,
    targetLocales: JSON.parse((formData.get("targetLocales") as string) || '["en","fr","es","it"]'),
    contextTitle: formData.get("contextTitle") as string,
  };

  // Detect source language from form data or default to "de"
  const sourceLocale = (formData.get("sourceLocale") as string) || "de";

  loggers.translation("info", "Starting field translation to all locales", {
    ...params,
    sourceLocale,
    useBatch: BATCH_FIELD_TYPES.includes(params.fieldType),
    shop: context.session.shop,
  });

  // Create task
  const task = await createProductTask({
    shop: context.session.shop,
    type: "bulkTranslation",
    resourceType: "product",
    resourceId: productId,
    resourceTitle: params.contextTitle,
    fieldType: params.fieldType,
  });

  try {
    const translationService = new TranslationService(
      context.provider,
      context.config,
      context.session.shop,
      task.id
    );
    const gateway = new ShopifyApiGateway(context.admin, context.session.shop);

    const totalLocales = params.targetLocales.length;
    let processedLocales = 0;
    const allTranslations: Record<string, string> = {};

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10, total: totalLocales, processed: 0 },
    });

    // Get translatable content and digest map
    const translatableResponse = await gateway.graphql(
      `#graphql
        query getTranslatableContent($resourceId: ID!) {
          translatableResource(resourceId: $resourceId) {
            resourceId
            translatableContent {
              key
              value
              digest
              locale
            }
          }
        }`,
      { variables: { resourceId: productId } }
    );

    const translatableData = await translatableResponse.json();
    const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];

    // Create digest map
    const digestMap: Record<string, string> = {};
    for (const content of translatableContent) {
      digestMap[content.key] = content.digest;
    }

    // Map fieldType to Shopify key
    const fieldKeyMap: Record<string, string> = {
      title: "title",
      description: "body_html",
      handle: "handle",
      seoTitle: "meta_title",
      metaDescription: "meta_description",
    };
    const shopifyKey = fieldKeyMap[params.fieldType];

    if (!shopifyKey) {
      throw new Error(`Unknown field type: ${params.fieldType}`);
    }

    // Check if we can use batch translation for this field type
    const useBatchTranslation = BATCH_FIELD_TYPES.includes(params.fieldType);

    if (useBatchTranslation) {
      // === BATCH TRANSLATION: Single AI request for all locales ===
      loggers.translation("info", "Using batch translation for short field", {
        fieldType: params.fieldType,
        locales: params.targetLocales,
        taskId: task.id,
      });

      try {
        let batchTranslations: Record<string, string>;

        if (params.fieldType === "handle") {
          // Use specialized slug batch translation
          batchTranslations = await translationService.translateSlugBatch(
            params.sourceText,
            sourceLocale,
            params.targetLocales
          );
        } else {
          // Use short fields batch translation for title/seoTitle
          const fields = { [params.fieldType]: params.sourceText };
          const batchResult = await translationService.translateShortFieldsBatch(
            fields,
            sourceLocale,
            params.targetLocales,
            "product"
          );
          // Extract the specific field from the batch result
          batchTranslations = {};
          for (const locale of params.targetLocales) {
            if (batchResult[locale]?.[params.fieldType]) {
              batchTranslations[locale] = batchResult[locale][params.fieldType];
            }
          }
        }

        // Save all translations to Shopify and DB
        for (const locale of params.targetLocales) {
          const translatedValue = batchTranslations[locale];

          if (!translatedValue) {
            loggers.translation("warn", "No translation in batch result", { locale });
            continue;
          }

          allTranslations[locale] = translatedValue;

          // Save to Shopify
          if (digestMap[shopifyKey]) {
            const response = await gateway.graphql(
              `#graphql
                mutation translateProduct($resourceId: ID!, $translations: [TranslationInput!]!) {
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
                  resourceId: productId,
                  translations: [
                    {
                      key: shopifyKey,
                      value: translatedValue,
                      locale,
                      translatableContentDigest: digestMap[shopifyKey],
                    },
                  ],
                },
              }
            );

            const responseData = await response.json();
            if (responseData.data?.translationsRegister?.userErrors?.length > 0) {
              loggers.translation("error", "Shopify API error", {
                locale,
                errors: responseData.data.translationsRegister.userErrors,
              });
            } else {
              loggers.translation("info", "Successfully saved translation", {
                locale,
                key: shopifyKey,
              });

              // Update local database
              const product = await db.product.findFirst({
                where: { id: productId },
                select: { shop: true },
              });

              if (product) {
                await db.contentTranslation.upsert({
                  where: {
                    resourceId_key_locale: {
                      resourceId: productId,
                      key: shopifyKey,
                      locale: locale,
                    },
                  },
                  update: {
                    value: translatedValue,
                    digest: digestMap[shopifyKey] || null,
                  },
                  create: {
                    resourceId: productId,
                    resourceType: "Product",
                    key: shopifyKey,
                    value: translatedValue,
                    locale: locale,
                    digest: digestMap[shopifyKey] || null,
                  },
                });
              }
            }
          }

          processedLocales++;
          const progressPercent = Math.round(10 + (processedLocales / totalLocales) * 90);
          await updateTaskProgress(task.id, progressPercent, { processed: processedLocales });
        }
      } catch (batchError: any) {
        loggers.translation("error", "Batch translation failed", {
          error: batchError.message,
          taskId: task.id,
        });
        throw batchError;
      }
    } else {
      // === SEQUENTIAL TRANSLATION: One AI request per locale (for long fields) ===
      const changedFields: any = {};
      changedFields[params.fieldType] = params.sourceText;

      for (const locale of params.targetLocales) {
        try {
          loggers.translation("info", "Translating field to locale (sequential)", {
            fieldType: params.fieldType,
            locale,
            taskId: task.id,
          });

          const localeTranslations = await translationService.translateProduct(
            changedFields,
            [locale],
            "product"
          );
          const translatedValue = localeTranslations[locale]?.[params.fieldType] || "";

          if (!translatedValue) {
            loggers.translation("warn", "No translation returned", { locale });
            continue;
          }

          allTranslations[locale] = translatedValue;

          // Save to Shopify
          if (digestMap[shopifyKey]) {
            const response = await gateway.graphql(
              `#graphql
                mutation translateProduct($resourceId: ID!, $translations: [TranslationInput!]!) {
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
                  resourceId: productId,
                  translations: [
                    {
                      key: shopifyKey,
                      value: translatedValue,
                      locale,
                      translatableContentDigest: digestMap[shopifyKey],
                    },
                  ],
                },
              }
            );

            const responseData = await response.json();
            if (responseData.data?.translationsRegister?.userErrors?.length > 0) {
              loggers.translation("error", "Shopify API error", {
                locale,
                errors: responseData.data.translationsRegister.userErrors,
              });
            } else {
              loggers.translation("info", "Successfully saved translation", {
                locale,
                key: shopifyKey,
              });

              // Update local database
              const product = await db.product.findFirst({
                where: { id: productId },
                select: { shop: true },
              });

              if (product) {
                await db.contentTranslation.upsert({
                  where: {
                    resourceId_key_locale: {
                      resourceId: productId,
                      key: shopifyKey,
                      locale: locale,
                    },
                  },
                  update: {
                    value: translatedValue,
                    digest: digestMap[shopifyKey] || null,
                  },
                  create: {
                    resourceId: productId,
                    resourceType: "Product",
                    key: shopifyKey,
                    value: translatedValue,
                    locale: locale,
                    digest: digestMap[shopifyKey] || null,
                  },
                });
              }
            }
          }

          processedLocales++;
          const progressPercent = Math.round(10 + (processedLocales / totalLocales) * 90);
          await updateTaskProgress(task.id, progressPercent, { processed: processedLocales });
        } catch (localeError: any) {
          loggers.translation("error", "Failed to translate locale", {
            locale,
            error: localeError.message,
          });
        }
      }
    }

    await completeTask(task.id, {
      translations: allTranslations,
      fieldType: params.fieldType,
      processedLocales,
      totalLocales,
      usedBatch: useBatchTranslation,
    });

    return json({
      success: processedLocales > 0,
      translations: allTranslations,
      fieldType: params.fieldType,
      processedLocales,
      totalLocales,
    });
  } catch (error: any) {
    await failTask(task.id, error);
    return handleActionError(error, {
      action,
      taskId: task.id,
      productId,
      provider: context.provider,
    });
  }
}

/**
 * Translates all product fields to all enabled locales
 * Uses hybrid approach:
 * - Short fields (title, seoTitle, handle): 1 batch AI request for all locales
 * - Long fields (description, metaDescription): 1 AI request per locale
 */
export async function handleTranslateAll(
  context: ActionContext,
  formData: FormData,
  productId: string
): Promise<Response> {
  const action = "translateAll";

  const { db } = await import("~/db.server");

  const params: TranslateAllParams = {
    title: formData.get("title") as string,
    description: formData.get("description") as string,
    handle: formData.get("handle") as string,
    seoTitle: formData.get("seoTitle") as string,
    metaDescription: formData.get("metaDescription") as string,
    productId,
    targetLocales: JSON.parse((formData.get("targetLocales") as string) || '["en","fr","es","it"]'),
  };

  // Detect source language from form data or default to "de"
  const sourceLocale = (formData.get("sourceLocale") as string) || "de";

  // Separate short and long fields
  const shortFields: Record<string, string> = {};
  const longFields: Record<string, string> = {};

  if (params.title) shortFields.title = params.title;
  if (params.seoTitle) shortFields.seoTitle = params.seoTitle;
  if (params.handle) shortFields.handle = params.handle;
  if (params.description) longFields.description = params.description;
  if (params.metaDescription) longFields.metaDescription = params.metaDescription;

  const hasShortFields = Object.keys(shortFields).length > 0;
  const hasLongFields = Object.keys(longFields).length > 0;

  loggers.translation("info", "Starting translate all with hybrid approach", {
    productId,
    localesCount: params.targetLocales.length,
    shortFields: Object.keys(shortFields),
    longFields: Object.keys(longFields),
    sourceLocale,
    shop: context.session.shop,
  });

  // Create task
  const task = await createProductTask({
    shop: context.session.shop,
    type: "bulkTranslation",
    resourceType: "product",
    resourceId: productId,
    resourceTitle: params.title,
    fieldType: "all",
  });

  const translationService = new TranslationService(
    context.provider,
    context.config,
    context.session.shop,
    task.id
  );
  const gateway = new ShopifyApiGateway(context.admin, context.session.shop);

  try {
    if (!hasShortFields && !hasLongFields) {
      await failTask(task.id, "No fields to translate");
      return json({ success: false, error: "No fields to translate" }, { status: 400 });
    }

    const totalLocales = params.targetLocales.length;
    // Calculate total steps: 1 for batch short fields + 1 per locale for long fields
    const totalSteps = (hasShortFields ? 1 : 0) + (hasLongFields ? totalLocales : 0);
    let completedSteps = 0;
    const allTranslations: Record<string, any> = {};

    // Initialize translations structure
    for (const locale of params.targetLocales) {
      allTranslations[locale] = {};
    }

    loggers.translation("info", "Translation plan", {
      shortFields: Object.keys(shortFields),
      longFields: Object.keys(longFields),
      totalSteps,
      locales: params.targetLocales,
    });

    await updateTaskProgress(task.id, 10, { total: totalSteps, processed: 0 });

    // Get translatable content
    const translatableResponse = await gateway.graphql(
      `#graphql
        query getTranslatableContent($resourceId: ID!) {
          translatableResource(resourceId: $resourceId) {
            resourceId
            translatableContent {
              key
              value
              digest
              locale
            }
          }
        }`,
      { variables: { resourceId: productId } }
    );

    const translatableData = await translatableResponse.json();
    const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];

    // Create digest map
    const digestMap: Record<string, string> = {};
    for (const content of translatableContent) {
      digestMap[content.key] = content.digest;
    }

    // Field key mapping
    const fieldKeyMap: Record<string, string> = {
      title: "title",
      description: "body_html",
      handle: "handle",
      seoTitle: "meta_title",
      metaDescription: "meta_description",
    };

    // Helper function to save translations to Shopify and DB
    const saveTranslation = async (
      locale: string,
      fieldType: string,
      value: string
    ) => {
      const shopifyKey = fieldKeyMap[fieldType];
      if (!shopifyKey || !digestMap[shopifyKey]) return;

      const response = await gateway.graphql(
        `#graphql
          mutation translateProduct($resourceId: ID!, $translations: [TranslationInput!]!) {
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
            resourceId: productId,
            translations: [
              {
                key: shopifyKey,
                value,
                locale,
                translatableContentDigest: digestMap[shopifyKey],
              },
            ],
          },
        }
      );

      const responseData = await response.json();
      if (responseData.data?.translationsRegister?.userErrors?.length > 0) {
        loggers.translation("error", "Shopify API error", {
          locale,
          fieldType,
          errors: responseData.data.translationsRegister.userErrors,
        });
      } else {
        // Save to local database
        const product = await db.product.findFirst({
          where: { id: productId },
          select: { shop: true },
        });

        if (product) {
          await db.contentTranslation.upsert({
            where: {
              resourceId_key_locale: {
                resourceId: productId,
                key: shopifyKey,
                locale,
              },
            },
            update: {
              value,
              digest: digestMap[shopifyKey] || null,
            },
            create: {
              resourceId: productId,
              resourceType: "Product",
              key: shopifyKey,
              value,
              locale,
              digest: digestMap[shopifyKey] || null,
            },
          });
        }
      }
    };

    // === STEP 1: Batch translate short fields (1 AI request for all locales) ===
    if (hasShortFields) {
      try {
        loggers.translation("info", "Batch translating short fields", {
          fields: Object.keys(shortFields),
          locales: params.targetLocales,
        });

        const batchResult = await translationService.translateShortFieldsBatch(
          shortFields,
          sourceLocale,
          params.targetLocales,
          "product"
        );

        // Save all short field translations
        for (const locale of params.targetLocales) {
          const localeTranslations = batchResult[locale];
          if (!localeTranslations) continue;

          for (const [fieldType, value] of Object.entries(localeTranslations)) {
            if (value) {
              allTranslations[locale][fieldType] = value;
              await saveTranslation(locale, fieldType, value);
            }
          }
        }

        completedSteps++;
        const progressPercent = Math.round(10 + (completedSteps / totalSteps) * 90);
        await updateTaskProgress(task.id, progressPercent, { processed: completedSteps });

        loggers.translation("info", "Batch short fields completed", {
          localesProcessed: params.targetLocales.length,
        });
      } catch (batchError: any) {
        loggers.translation("error", "Batch short fields translation failed", {
          error: batchError.message,
        });
        // Continue with long fields even if batch fails
      }
    }

    // === STEP 2: Sequential translate long fields (1 AI request per locale) ===
    if (hasLongFields) {
      for (const locale of params.targetLocales) {
        try {
          loggers.translation("info", "Translating long fields for locale", {
            locale,
            fields: Object.keys(longFields),
          });

          const localeTranslations = await translationService.translateProduct(
            longFields,
            [locale],
            "product"
          );

          const fields = localeTranslations[locale];
          if (fields) {
            for (const [fieldType, value] of Object.entries(fields)) {
              if (value) {
                allTranslations[locale][fieldType] = value;
                await saveTranslation(locale, fieldType, value as string);
              }
            }
          }

          completedSteps++;
          const progressPercent = Math.round(10 + (completedSteps / totalSteps) * 90);
          await updateTaskProgress(task.id, progressPercent, { processed: completedSteps });
        } catch (localeError: any) {
          loggers.translation("error", "Failed to translate long fields for locale", {
            locale,
            error: localeError.message,
          });

          // Check for quota errors
          const errorMessage = localeError.message || String(localeError);
          if (
            errorMessage.includes("usage limit") ||
            errorMessage.includes("quota") ||
            errorMessage.includes("rate limit")
          ) {
            loggers.translation("error", "AI provider quota exceeded", { locale });
          }
        }
      }
    }

    // Count successfully processed locales (at least one field translated)
    const processedLocales = params.targetLocales.filter(
      (locale) => Object.keys(allTranslations[locale] || {}).length > 0
    ).length;

    const finalError =
      processedLocales === 0
        ? "No locales were successfully translated. Check AI provider settings and API credits."
        : null;

    if (processedLocales > 0) {
      await completeTask(task.id, {
        success: true,
        localesProcessed: processedLocales,
        locales: Object.keys(allTranslations).filter(
          (l) => Object.keys(allTranslations[l]).length > 0
        ),
        attempted: totalLocales,
        usedBatchForShortFields: hasShortFields,
      });
    } else {
      await failTask(task.id, finalError || "Translation failed");
    }

    return json({
      success: processedLocales > 0,
      translations: allTranslations,
      processedLocales,
      totalLocales,
    });
  } catch (error: any) {
    await failTask(task.id, error);
    return handleActionError(error, {
      action,
      taskId: task.id,
      productId,
      provider: context.provider,
    });
  }
}
