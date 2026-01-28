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

/**
 * Translates a single field to all enabled locales
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

  loggers.translation("info", "Starting field translation to all locales", {
    ...params,
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

    const changedFields: any = {};
    changedFields[params.fieldType] = params.sourceText;

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

    // DEBUG: Log full translatableContent and digestMap
    loggers.translation("info", "🔍 DEBUG: Translatable content from Shopify (single field)", {
      productId,
      translatableContent: JSON.stringify(translatableContent, null, 2),
      digestMap: JSON.stringify(digestMap, null, 2),
    });

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

    // Translate to each locale
    for (const locale of params.targetLocales) {
      try {
        loggers.translation("info", "Translating field to locale", {
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
          loggers.translation("info", "🔍 DEBUG: Saving translation to Shopify", {
            locale,
            shopifyKey,
            digest: digestMap[shopifyKey],
            valueLength: translatedValue.length,
          });
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

            // Update local database - only update this specific field
            const product = await db.product.findFirst({
              where: { id: productId },
              select: { shop: true },
            });

            if (product) {
              // Use upsert to update or create only this specific field
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
        } else {
          // DEBUG: Log when digest is missing
          loggers.translation("warn", "🚨 DEBUG: SKIPPING translation - no digest found!", {
            locale,
            shopifyKey,
            productId,
            availableDigests: Object.keys(digestMap),
          });
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

    await completeTask(task.id, {
      translations: allTranslations,
      fieldType: params.fieldType,
      processedLocales,
      totalLocales,
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

  loggers.translation("info", "Starting translate all", {
    productId,
    localesCount: params.targetLocales.length,
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
    const changedFields: any = {};
    if (params.title) changedFields.title = params.title;
    if (params.description) changedFields.description = params.description;
    if (params.handle) changedFields.handle = params.handle;
    if (params.seoTitle) changedFields.seoTitle = params.seoTitle;
    if (params.metaDescription) changedFields.metaDescription = params.metaDescription;

    if (Object.keys(changedFields).length === 0) {
      await failTask(task.id, "No fields to translate");
      return json({ success: false, error: "No fields to translate" }, { status: 400 });
    }

    const totalLocales = params.targetLocales.length;
    let processedLocales = 0;
    const allTranslations: Record<string, any> = {};

    loggers.translation("info", "Translation fields", {
      fields: Object.keys(changedFields),
      locales: params.targetLocales,
    });

    await updateTaskProgress(task.id, 10, { total: totalLocales, processed: 0 });

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

    // DEBUG: Log full translatableContent and digestMap
    loggers.translation("info", "🔍 DEBUG: Translatable content from Shopify (all fields)", {
      productId,
      translatableContent: JSON.stringify(translatableContent, null, 2),
      digestMap: JSON.stringify(digestMap, null, 2),
    });

    // Translate each locale
    for (const locale of params.targetLocales) {
      try {
        loggers.translation("info", "Translating locale", { locale });

        const localeTranslations = await translationService.translateProduct(
          changedFields,
          [locale],
          "product"
        );
        const fields = localeTranslations[locale];

        if (!fields) {
          loggers.translation("warn", "No translations returned", { locale });
          continue;
        }

        allTranslations[locale] = fields;

        // Prepare translations input
        const translationsInput = [];
        if (fields.title && digestMap["title"]) {
          translationsInput.push({
            key: "title",
            value: fields.title,
            locale,
            translatableContentDigest: digestMap["title"],
          });
        }
        if (fields.description && digestMap["body_html"]) {
          translationsInput.push({
            key: "body_html",
            value: fields.description,
            locale,
            translatableContentDigest: digestMap["body_html"],
          });
        }
        if (fields.handle && digestMap["handle"]) {
          translationsInput.push({
            key: "handle",
            value: fields.handle,
            locale,
            translatableContentDigest: digestMap["handle"],
          });
        }
        if (fields.seoTitle && digestMap["meta_title"]) {
          translationsInput.push({
            key: "meta_title",
            value: fields.seoTitle,
            locale,
            translatableContentDigest: digestMap["meta_title"],
          });
        }
        if (fields.metaDescription && digestMap["meta_description"]) {
          translationsInput.push({
            key: "meta_description",
            value: fields.metaDescription,
            locale,
            translatableContentDigest: digestMap["meta_description"],
          });
        }

        // DEBUG: Log which fields are being saved and which are skipped
        const skippedFields: string[] = [];
        if (fields.title && !digestMap["title"]) skippedFields.push("title");
        if (fields.description && !digestMap["body_html"]) skippedFields.push("body_html");
        if (fields.handle && !digestMap["handle"]) skippedFields.push("handle");
        if (fields.seoTitle && !digestMap["meta_title"]) skippedFields.push("meta_title");
        if (fields.metaDescription && !digestMap["meta_description"]) skippedFields.push("meta_description");

        loggers.translation("info", "🔍 DEBUG: Translation input prepared", {
          locale,
          fieldsToSave: translationsInput.map(t => t.key),
          skippedFields,
          availableDigests: Object.keys(digestMap).filter(k => digestMap[k]),
        });

        if (skippedFields.length > 0) {
          loggers.translation("warn", "🚨 DEBUG: SKIPPING fields - no digest found!", {
            locale,
            productId,
            skippedFields,
          });
        }

        // Save each translation to Shopify
        for (const translation of translationsInput) {
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
                translations: [translation],
              },
            }
          );

          const responseData = await response.json();
          if (responseData.data?.translationsRegister?.userErrors?.length > 0) {
            loggers.translation("error", "Shopify API error", {
              locale,
              errors: responseData.data.translationsRegister.userErrors,
            });
          }
        }

        // Update local database - use upsert to preserve existing translations
        const product = await db.product.findFirst({
          where: { id: productId },
          select: { shop: true },
        });

        if (product && translationsInput.length > 0) {
          // Use upsert for each field to only update what we translated
          for (const translation of translationsInput) {
            await db.contentTranslation.upsert({
              where: {
                resourceId_key_locale: {
                  resourceId: productId,
                  key: translation.key,
                  locale: locale,
                },
              },
              update: {
                value: translation.value,
                digest: translation.translatableContentDigest || null,
              },
              create: {
                resourceId: productId,
                resourceType: "Product",
                key: translation.key,
                value: translation.value,
                locale: locale,
                digest: translation.translatableContentDigest || null,
              },
            });
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

    const finalError =
      processedLocales === 0
        ? "No locales were successfully translated. Check AI provider settings and API credits."
        : null;

    if (processedLocales > 0) {
      await completeTask(task.id, {
        success: true,
        localesProcessed: processedLocales,
        locales: Object.keys(allTranslations),
        attempted: totalLocales,
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
