/**
 * Sub-Resources Action Handlers
 *
 * Extracted from unified-content.actions.ts
 * Handles: loadSubResourceTranslations, saveSubResourceTranslations, translateSubResources,
 *          translateSubResourceToAllLocales, savePrimarySubResources
 */

import { json } from "@remix-run/node";
import { AIService } from "../../../src/services/ai.service";
import { getFormString } from "../../utils/form-data.utils";
import { isValidLocale, isValidShopifyGID } from "../../utils/validation";
import { getFullErrorMessage } from "../../utils/error-handler";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "../../utils/logger.server";
import type { ContentActionHandlerContext } from "./alt-text.action";

// ============================================================================
// LOAD SUB-RESOURCE TRANSLATIONS (Options + Metafields)
// ============================================================================

export async function handleLoadSubResourceTranslations(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<Response> {
  const { db, session, shopifyContentService } = ctx;

  const locale = getFormString(formData, "locale");
  if (!locale || !isValidLocale(locale)) {
    return json({ success: false, error: "Invalid locale format" }, { status: 400 });
  }

  try {
    const resourceIdsJson = getFormString(formData, "resourceIds");
    const resourceIds: string[] = resourceIdsJson ? JSON.parse(resourceIdsJson) : [];

    if (resourceIds.length === 0) {
      return json({
        actionType: "loadSubResourceTranslations",
        success: true,
        translations: {},
      });
    }

    // Validate all GIDs
    for (const rid of resourceIds) {
      if (!isValidShopifyGID(rid)) {
        return json({ success: false, error: `Invalid resource ID: ${rid}` }, { status: 400 });
      }
    }

    // Load translations from Shopify for each sub-resource
    const translations: Record<string, Record<string, string>> = {};

    // Batch: load from local DB first (faster)
    const dbTranslations = await db.contentTranslation.findMany({
      where: {
        resourceId: { in: resourceIds },
        locale,
      },
    });

    for (const t of dbTranslations) {
      if (!translations[t.resourceId]) translations[t.resourceId] = {};
      translations[t.resourceId][t.key] = t.value;
    }

    // Also load from Shopify for any missing (in parallel, max 10 concurrent)
    const missingIds = resourceIds.filter(id => !translations[id]);
    if (missingIds.length > 0) {
      const dbWrites: Array<Promise<any>> = [];
      const batchSize = 10;
      for (let i = 0; i < missingIds.length; i += batchSize) {
        const batch = missingIds.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(rid => shopifyContentService.loadTranslations(rid, locale))
        );
        results.forEach((result, idx) => {
          if (result.status === "fulfilled" && result.value) {
            const rid = batch[idx];
            if (!translations[rid]) translations[rid] = {};
            // Derive resourceType from GID (e.g. gid://shopify/ProductOption/123 → ProductOption)
            const gidMatch = rid.match(/gid:\/\/shopify\/(\w+)\//);
            const resourceType = gidMatch ? gidMatch[1] : "Unknown";
            for (const t of result.value) {
              translations[rid][t.key] = t.value;
              // Persist to DB so next navigation finds it via the loader pipeline
              dbWrites.push(
                db.contentTranslation.upsert({
                  where: { shop_resourceId_key_locale: { shop: session.shop, resourceId: rid, key: t.key, locale } },
                  create: { shop: session.shop, resourceId: rid, resourceType, key: t.key, value: t.value, locale },
                  update: { value: t.value },
                })
              );
            }
          }
        });
      }
      // Fire DB writes in parallel (non-blocking for the response)
      if (dbWrites.length > 0) {
        await Promise.allSettled(dbWrites);
      }
    }

    return json({
      actionType: "loadSubResourceTranslations",
      success: true,
      translations,
    });
  } catch (error: unknown) {
    const msg = getFullErrorMessage(error);
    return json({ success: false, error: msg }, { status: 500 });
  }
}

// ============================================================================
// SAVE SUB-RESOURCE TRANSLATIONS (Options + Metafields)
// ============================================================================

export async function handleSaveSubResourceTranslations(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<Response> {
  const { db, shopifyContentService } = ctx;
  // gateway is needed for deleting translations
  const { admin, session } = ctx;

  const locale = getFormString(formData, "locale");
  if (!locale || !isValidLocale(locale)) {
    return json({ success: false, error: "Invalid locale format" }, { status: 400 });
  }

  try {
    // translationsData format: { resourceId: { key: value } }
    const translationsDataJson = getFormString(formData, "translationsData");
    const translationsData: Record<string, Record<string, string>> = translationsDataJson
      ? JSON.parse(translationsDataJson) : {};

    const resourceTypesJson = getFormString(formData, "resourceTypes");
    const resourceTypes: Record<string, string> = resourceTypesJson
      ? JSON.parse(resourceTypesJson) : {};

    const savedResources: string[] = [];
    const failedResources: string[] = [];

    logger.info('[UnifiedContent] saveSubResourceTranslations - Starting save operation', {
      context: "UnifiedContent",
      locale,
      resourceCount: Object.keys(translationsData).length,
      translationsData: JSON.stringify(translationsData), // Log full data to see what's missing
      resourceIds: Object.keys(translationsData),
    });

    // We need gateway for the remove translations mutation
    const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
    const gateway = new ShopifyApiGateway(admin, session.shop);

    for (const [resourceId, fields] of Object.entries(translationsData)) {
      if (!isValidShopifyGID(resourceId)) continue;

      try {
        const resourceType = resourceTypes[resourceId] || "Unknown";

        // Separate empty and non-empty values
        // For ProductOption and ProductOptionValue, Shopify API rejects empty strings
        // ("Value can't be blank" / "Name can't be blank")
        // So we delete the translation instead of setting it to empty
        const translationInputs: Array<{ key: string; value: string; locale: string }> = [];
        const keysToDelete: string[] = [];

        for (const [key, value] of Object.entries(fields)) {
          if (value === "" && (resourceType === "ProductOptionValue" || resourceType === "ProductOption")) {
            // Empty value for ProductOption/ProductOptionValue - delete the translation instead
            keysToDelete.push(key);
          } else {
            // Non-empty value OR empty value for other resource types
            translationInputs.push({ key, value, locale });
          }
        }

        logger.info(`[UnifiedContent] Saving translations for resource ${resourceId}`, {
          context: "UnifiedContent",
          resourceId,
          resourceType,
          locale,
          translationInputs: JSON.stringify(translationInputs),
          keysToDelete: JSON.stringify(keysToDelete),
        });

        // Save non-empty translations to Shopify
        if (translationInputs.length > 0) {
          await shopifyContentService.saveTranslations(resourceId, translationInputs);
        }

        // Delete empty translations for ProductOptionValue
        if (keysToDelete.length > 0) {
          const deleteResponse = await gateway.graphql(
            `#graphql
              mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
                translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                  userErrors { field message }
                }
              }`,
            {
              variables: {
                resourceId,
                translationKeys: keysToDelete,
                locales: [locale],
              },
            }
          );
          const deleteData = await deleteResponse.json() as any;
          if (deleteData.data?.translationsRemove?.userErrors?.length > 0) {
            logger.error(`[UnifiedContent] translationsRemove userErrors for ${resourceId}`, {
              context: "UnifiedContent",
              resourceId,
              locale,
              errors: deleteData.data.translationsRemove.userErrors,
            });
            throw new Error(`Shopify rejected translation deletion: ${deleteData.data.translationsRemove.userErrors[0].message}`);
          }
          logger.info(`[UnifiedContent] Deleted translations for ${resourceId}`, {
            context: "UnifiedContent",
            resourceId,
            locale,
            keysToDelete: JSON.stringify(keysToDelete),
          });
        }

        // Save to local DB (including empty strings - user explicitly cleared the field)
        // This allows tracking that the field was intentionally cleared
        for (const [key, value] of Object.entries(fields)) {
          if (value === "" && (resourceType === "ProductOptionValue" || resourceType === "ProductOption")) {
            // For ProductOption/ProductOptionValue with empty value, delete from DB too
            // since there's no translation in Shopify (we removed it)
            await db.contentTranslation.deleteMany({
              where: { resourceId, key, locale },
            });
          } else {
            // For all other cases, save to DB
            await db.contentTranslation.upsert({
              where: { shop_resourceId_key_locale: { shop: session.shop, resourceId, key, locale } },
              create: { shop: session.shop, resourceId, resourceType, key, value, locale },
              update: { value },
            });
          }
        }

        savedResources.push(resourceId);
        logger.info(`[UnifiedContent] Successfully saved translations for ${resourceId}`, {
          context: "UnifiedContent",
          resourceId,
          locale,
        });
      } catch (err) {
        logger.error(`[UnifiedContent] Failed to save sub-resource translation for ${resourceId}`, {
          context: "UnifiedContent",
          resourceId,
          locale,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        failedResources.push(resourceId);
      }
    }

    logger.info('[UnifiedContent] saveSubResourceTranslations - Completed save operation', {
      context: "UnifiedContent",
      locale,
      savedCount: savedResources.length,
      failedCount: failedResources.length,
      savedResources,
      failedResources,
    });

    return json({
      actionType: "saveSubResourceTranslations",
      success: true,
      savedResources,
      failedResources,
    });
  } catch (error: unknown) {
    const msg = getFullErrorMessage(error);
    return json({ success: false, error: msg }, { status: 500 });
  }
}

// ============================================================================
// TRANSLATE SUB-RESOURCES (AI translate options + metafields)
// ============================================================================

export async function handleTranslateSubResources(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<Response> {
  const { session, contentConfig, db, itemId, shopifyContentService, provider, serviceConfig } = ctx;

  const targetLocale = getFormString(formData, "targetLocale");
  if (!targetLocale || !isValidLocale(targetLocale)) {
    return json({ success: false, error: "Invalid target locale" }, { status: 400 });
  }

  const sourceDataJson = getFormString(formData, "sourceData");
  const sourceData: Array<{ resourceId: string; resourceType: string; key: string; value: string; label: string }> =
    sourceDataJson ? JSON.parse(sourceDataJson) : [];

  if (sourceData.length === 0) {
    return json({ actionType: "translateSubResources", success: true, translations: {} });
  }

  const primaryLocale = getFormString(formData, "primaryLocale") || "en";

  // Build a descriptive task title based on what's being translated
  const resourceLabels = sourceData.map(s => s.label).join(", ");
  const taskTitle = resourceLabels.length > 50
    ? `${sourceData.length} sub-resource${sourceData.length > 1 ? 's' : ''}`
    : resourceLabels;

  // Create task entry for tracking
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "translation",
      status: "pending",
      resourceType: contentConfig.resourceType,
      resourceId: itemId,
      resourceTitle: taskTitle,
      fieldType: "sub-resources",
      targetLocale,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    // Update task to queued (queue will update to running)
    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    // Create AI service with shop and taskId for queue management
    const aiService = new AIService(provider, serviceConfig, session.shop, task.id);

    // Group by small batches for AI translation
    const translations: Record<string, Record<string, string>> = {};
    const fieldsToTranslate: Record<string, string> = {};

    for (const item of sourceData) {
      fieldsToTranslate[`${item.resourceId}::${item.key}`] = item.value;
    }

    // Use batch translation: send all values at once
    const values = Object.values(fieldsToTranslate);
    const keys = Object.keys(fieldsToTranslate);

    if (values.length > 0) {
      const translatedValues = await aiService.translateBatchValues(
        values,
        primaryLocale,
        targetLocale,
        "product options and metafield values"
      );

      for (let i = 0; i < keys.length; i++) {
        const [resourceId, key] = keys[i].split("::");
        if (!translations[resourceId]) translations[resourceId] = {};
        translations[resourceId][key] = translatedValues[i] || values[i];
      }
    }

    // Update progress after translation
    await db.task.update({
      where: { id: task.id },
      data: { progress: 60 },
    });

    // Save translations to Shopify + DB
    const savedResources: string[] = [];
    const failedResources: string[] = [];

    for (const [resourceId, fields] of Object.entries(translations)) {
      try {
        // Build translation inputs (saveTranslations handles digest internally)
        const translationInputs: Array<{ key: string; value: string; locale: string }> = [];
        for (const [key, value] of Object.entries(fields)) {
          translationInputs.push({ key, value, locale: targetLocale });
        }

        if (translationInputs.length > 0) {
          await shopifyContentService.saveTranslations(resourceId, translationInputs);
        }

        // Save to DB
        const sourceItem = sourceData.find(s => s.resourceId === resourceId);
        const resourceType = sourceItem?.resourceType || "Unknown";
        for (const [key, value] of Object.entries(fields)) {
          await db.contentTranslation.upsert({
            where: { shop_resourceId_key_locale: { shop: session.shop, resourceId, key, locale: targetLocale } },
            create: { shop: session.shop, resourceId, resourceType, key, value, locale: targetLocale },
            update: { value },
          });
        }

        savedResources.push(resourceId);
      } catch (err) {
        logger.error(`[UnifiedContent] Failed to translate sub-resource ${resourceId}`, {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
        failedResources.push(resourceId);
      }
    }

    // Update task to completed
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({
          translatedCount: savedResources.length,
          failedCount: failedResources.length,
          targetLocale,
        }),
      },
    });

    return json({
      actionType: "translateSubResources",
      success: true,
      translations,
      savedResources,
      failedResources,
      fieldId: getFormString(formData, "fieldId"), // Echo back fieldId for client state management
    });
  } catch (error: unknown) {
    // Update task to failed
    const msg = getFullErrorMessage(error);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: msg.substring(0, 1000),
      },
    });
    return json({ success: false, error: msg }, { status: 500 });
  }
}

// ============================================================================
// TRANSLATE SUB-RESOURCES TO ALL LOCALES (from primary language)
// ============================================================================

export async function handleTranslateSubResourceToAllLocales(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<Response> {
  const { admin, session, contentConfig, db, itemId, shopifyContentService, provider, serviceConfig } = ctx;

  const sourceDataJson = getFormString(formData, "sourceData");
  const sourceData: Array<{ resourceId: string; resourceType: string; key: string; value: string; label: string }> =
    sourceDataJson ? JSON.parse(sourceDataJson) : [];

  if (sourceData.length === 0) {
    return json({ actionType: "translateSubResourceToAllLocales", success: true, translations: {} });
  }

  const primaryLocale = getFormString(formData, "primaryLocale") || "en";

  // Get target locales (all published foreign locales)
  const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
  const gateway = new ShopifyApiGateway(admin, session.shop);

  const localesResponse = await gateway.graphql(
    `#graphql
      query getShopLocales {
        shopLocales {
          locale
          primary
          published
        }
      }`
  );
  const localesData = await localesResponse.json() as any;
  const shopLocales = localesData.data?.shopLocales || [];
  const targetLocales = shopLocales
    .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary && l.published)
    .map((l: { locale: string }) => l.locale);

  if (targetLocales.length === 0) {
    return json({ actionType: "translateSubResourceToAllLocales", success: true, translations: {} });
  }

  // Build a descriptive task title
  const resourceLabels = sourceData.map(s => s.label).join(", ");
  const taskTitle = resourceLabels.length > 50
    ? `${sourceData.length} sub-resource${sourceData.length > 1 ? 's' : ''}`
    : resourceLabels;

  // Create task entry for tracking
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: contentConfig.resourceType,
      resourceId: itemId,
      resourceTitle: taskTitle,
      fieldType: "sub-resources",
      targetLocale: targetLocales.join(","),
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    // Update task to queued
    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    // Create AI service with shop and taskId for queue management
    const aiService = new AIService(provider, serviceConfig, session.shop, task.id);

    // Translate to each target locale
    const allTranslations: Record<string, Record<string, Record<string, string>>> = {}; // locale → resourceId → { key: value }
    const failedLocales: string[] = [];

    for (let localeIdx = 0; localeIdx < targetLocales.length; localeIdx++) {
      const targetLocale = targetLocales[localeIdx];

      try {
        const fieldsToTranslate: Record<string, string> = {};
        for (const item of sourceData) {
          fieldsToTranslate[`${item.resourceId}::${item.key}`] = item.value;
        }

        const values = Object.values(fieldsToTranslate);
        const keys = Object.keys(fieldsToTranslate);

        if (values.length > 0) {
          const translatedValues = await aiService.translateBatchValues(
            values,
            primaryLocale,
            targetLocale,
            "product options and metafield values"
          );

          const translations: Record<string, Record<string, string>> = {};
          for (let i = 0; i < keys.length; i++) {
            const [resourceId, key] = keys[i].split("::");
            if (!translations[resourceId]) translations[resourceId] = {};
            translations[resourceId][key] = translatedValues[i] || values[i];
          }

          allTranslations[targetLocale] = translations;

          // Update progress
          const progressPercent = Math.round(10 + ((localeIdx + 1) / targetLocales.length) * 50);
          await db.task.update({
            where: { id: task.id },
            data: { progress: progressPercent },
          });
        }
      } catch (err) {
        logger.error(`[UnifiedContent] Failed to translate sub-resources to ${targetLocale}`, {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
        failedLocales.push(targetLocale);
      }
    }

    // Save all translations to Shopify + DB
    for (const [locale, translations] of Object.entries(allTranslations)) {
      for (const [resourceId, fields] of Object.entries(translations)) {
        try {
          const translationInputs: Array<{ key: string; value: string; locale: string }> = [];
          for (const [key, value] of Object.entries(fields)) {
            translationInputs.push({ key, value, locale });
          }

          if (translationInputs.length > 0) {
            await shopifyContentService.saveTranslations(resourceId, translationInputs);
          }

          // Save to DB
          const sourceItem = sourceData.find(s => s.resourceId === resourceId);
          const resourceType = sourceItem?.resourceType || "Unknown";
          for (const [key, value] of Object.entries(fields)) {
            await db.contentTranslation.upsert({
              where: { shop_resourceId_key_locale: { shop: session.shop, resourceId, key, locale } },
              create: { shop: session.shop, resourceId, resourceType, key, value, locale },
              update: { value },
            });
          }
        } catch (err) {
          logger.error(`[UnifiedContent] Failed to save sub-resource translation for ${resourceId} in ${locale}`, {
            context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Update task to completed
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({
          translatedLocales: targetLocales.filter((l: string) => !failedLocales.includes(l)),
          failedLocales,
        }),
      },
    });

    // Return translations in the format expected by the hook (for current locale only - we return empty since already saved)
    return json({
      actionType: "translateSubResourceToAllLocales",
      success: true,
      translations: {}, // Already saved to Shopify, no need to return
      failedLocales,
      fieldId: getFormString(formData, "fieldId"), // Echo back fieldId for client state management
    });
  } catch (error: unknown) {
    const msg = getFullErrorMessage(error);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: msg.substring(0, 1000),
      },
    });
    return json({ success: false, error: msg }, { status: 500 });
  }
}

// ============================================================================
// SAVE PRIMARY SUB-RESOURCES (Options + Metafields - main language values)
// ============================================================================

export async function handleSavePrimarySubResources(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<Response> {
  const { admin, session, db } = ctx;

  const productId = getFormString(formData, "productId");

  if (!productId || !isValidShopifyGID(productId)) {
    return json({ success: false, error: "Invalid product ID" }, { status: 400 });
  }

  try {
    const optionsChangesJson = getFormString(formData, "optionsChanges");
    const metafieldChangesJson = getFormString(formData, "metafieldChanges");

    const optionsChanges: Record<string, { name?: string; valueUpdates?: { id: string; name: string }[] }> = optionsChangesJson
      ? JSON.parse(optionsChangesJson) : {};
    const metafieldChanges: Record<string, string> = metafieldChangesJson
      ? JSON.parse(metafieldChangesJson) : {};

    const { PRODUCT_OPTION_UPDATE, METAFIELDS_SET } = await import("~/graphql/content.mutations");

    const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
    const gateway = new ShopifyApiGateway(admin, session.shop);

    const savedOptions: string[] = [];
    const failedOptions: string[] = [];
    const savedMetafields: string[] = [];
    const failedMetafields: string[] = [];

    // 1. Update option names and/or values using productOptionUpdate mutation
    for (const [optionId, changes] of Object.entries(optionsChanges)) {
      if (!isValidShopifyGID(optionId)) continue;

      const hasNameChange = changes.name !== undefined;
      const hasValueChanges = changes.valueUpdates && changes.valueUpdates.length > 0;

      if (!hasNameChange && !hasValueChanges) continue;

      try {
        const optionInput: { id: string; name?: string } = { id: optionId };
        if (hasNameChange) {
          optionInput.name = changes.name;
        }

        const variables: { productId: string; option: typeof optionInput; optionValuesToUpdate?: { id: string; name: string }[] } = {
          productId,
          option: optionInput,
        };

        if (hasValueChanges) {
          variables.optionValuesToUpdate = changes.valueUpdates;
        }

        const updateResponse = await gateway.graphql(
          PRODUCT_OPTION_UPDATE,
          { variables }
        );

        const updateData = await updateResponse.json() as any;

        if (updateData.data?.productOptionUpdate?.userErrors?.length > 0) {
          logger.error("[UnifiedContent] productOptionUpdate userErrors", {
            context: "UnifiedContent", optionId, errors: updateData.data.productOptionUpdate.userErrors,
          });
          failedOptions.push(optionId);
        } else {
          savedOptions.push(optionId);
        }
      } catch (err) {
        logger.error(`[UnifiedContent] Failed to update option ${optionId}`, {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
        failedOptions.push(optionId);
      }
    }

    // 3. Update metafields using metafieldsSet mutation
    if (Object.keys(metafieldChanges).length > 0) {
      try {
        const metafieldsInput = Object.entries(metafieldChanges).map(([metafieldId, value]) => ({
          id: metafieldId,
          value,
        }));

        const metafieldsResponse = await gateway.graphql(
          METAFIELDS_SET,
          {
            variables: {
              metafields: metafieldsInput,
            },
          }
        );

        const metafieldsData = await metafieldsResponse.json() as any;
        if (metafieldsData.data?.metafieldsSet?.userErrors?.length > 0) {
          logger.error("[UnifiedContent] metafieldsSet userErrors", {
            context: "UnifiedContent", errors: metafieldsData.data.metafieldsSet.userErrors,
          });
          Object.keys(metafieldChanges).forEach(mfId => failedMetafields.push(mfId));
        } else {
          Object.keys(metafieldChanges).forEach(mfId => savedMetafields.push(mfId));
        }
      } catch (err) {
        logger.error("[UnifiedContent] Failed to update metafields", {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
        Object.keys(metafieldChanges).forEach(mfId => failedMetafields.push(mfId));
      }
    }

    // 4. Delete translations for changed fields in all foreign languages
    const changedOptionIds = [...new Set([...savedOptions, ...Object.keys(optionsChanges)])];
    const changedMetafieldIds = [...new Set([...savedMetafields, ...Object.keys(metafieldChanges)])];

    if (changedOptionIds.length > 0 || changedMetafieldIds.length > 0) {
      try {
        // Get all shop locales
        const localesResponse = await gateway.graphql(
          `#graphql
            query getShopLocales {
              shopLocales {
                locale
                primary
                published
              }
            }`
        );
        const localesData = await localesResponse.json() as any;
        const shopLocales = localesData.data?.shopLocales || [];

        // Filter out the primary locale, only keep published foreign locales
        const foreignLocales = shopLocales
          .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary && l.published)
          .map((l: { locale: string }) => l.locale);

        if (foreignLocales.length > 0) {
          // Delete option translations
          for (const optionId of changedOptionIds) {
            if (!isValidShopifyGID(optionId)) continue;

            const changes = optionsChanges[optionId];

            try {
              // Only delete option name translation if the name was actually changed
              if (changes?.name !== undefined) {
                const delNameResp = await gateway.graphql(
                  `#graphql
                    mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
                      translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                        userErrors { field message }
                      }
                    }`,
                  {
                    variables: {
                      resourceId: optionId,
                      translationKeys: ["name"],
                      locales: foreignLocales,
                    },
                  }
                );
                const delNameData = await delNameResp.json() as any;
                if (delNameData.data?.translationsRemove?.userErrors?.length > 0) {
                  logger.error(`[UnifiedContent] translationsRemove userErrors for option name ${optionId}`, {
                    context: "UnifiedContent", errors: delNameData.data.translationsRemove.userErrors,
                  });
                  // Shopify is master — skip DB deletion if Shopify rejected the removal
                } else {
                  // Delete from DB only if Shopify succeeded
                  await db.contentTranslation.deleteMany({
                    where: {
                      resourceId: optionId,
                      resourceType: "ProductOption",
                      key: "name",
                      locale: { in: foreignLocales },
                    },
                  });
                }
              }

              // Only delete translations for values that actually changed
              if (changes?.valueUpdates !== undefined && changes.valueUpdates.length > 0) {
                // Use value IDs from the changes payload directly
                for (const valueUpdate of changes.valueUpdates) {
                  if (!valueUpdate.id) continue;

                  const delValResp = await gateway.graphql(
                    `#graphql
                      mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
                        translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                          userErrors { field message }
                        }
                      }`,
                    {
                      variables: {
                        resourceId: valueUpdate.id,
                        translationKeys: ["name"],
                        locales: foreignLocales,
                      },
                    }
                  );
                  const delValData = await delValResp.json() as any;
                  if (delValData.data?.translationsRemove?.userErrors?.length > 0) {
                    logger.error(`[UnifiedContent] translationsRemove userErrors for option value ${valueUpdate.id}`, {
                      context: "UnifiedContent", errors: delValData.data.translationsRemove.userErrors,
                    });
                    // Shopify is master — skip DB deletion if Shopify rejected the removal
                  } else {
                    await db.contentTranslation.deleteMany({
                      where: {
                        resourceId: valueUpdate.id,
                        resourceType: "ProductOptionValue",
                        key: "name",
                        locale: { in: foreignLocales },
                      },
                    });
                  }
                }
              }
            } catch (err) {
              logger.error(`[UnifiedContent] Failed to delete translations for option ${optionId}`, {
                context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // Delete metafield translations
          for (const metafieldId of changedMetafieldIds) {
            if (!isValidShopifyGID(metafieldId)) continue;

            try {
              const delMfResp = await gateway.graphql(
                `#graphql
                  mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
                    translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                      userErrors { field message }
                    }
                  }`,
                {
                  variables: {
                    resourceId: metafieldId,
                    translationKeys: ["value"],
                    locales: foreignLocales,
                  },
                }
              );
              const delMfData = await delMfResp.json() as any;
              if (delMfData.data?.translationsRemove?.userErrors?.length > 0) {
                logger.error(`[UnifiedContent] translationsRemove userErrors for metafield ${metafieldId}`, {
                  context: "UnifiedContent", errors: delMfData.data.translationsRemove.userErrors,
                });
                // Shopify is master — skip DB deletion if Shopify rejected the removal
              } else {
                await db.contentTranslation.deleteMany({
                  where: {
                    resourceId: metafieldId,
                    resourceType: "Metafield",
                    key: "value",
                    locale: { in: foreignLocales },
                  },
                });
              }
            } catch (err) {
              logger.error(`[UnifiedContent] Failed to delete translations for metafield ${metafieldId}`, {
                context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      } catch (err) {
        logger.error("[UnifiedContent] Failed to delete translations for changed sub-resources", {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return json({
      actionType: "savePrimarySubResources",
      success: true,
      savedOptions,
      failedOptions,
      savedMetafields,
      failedMetafields,
    });
  } catch (error: unknown) {
    const msg = getFullErrorMessage(error);
    logger.error("[UnifiedContent] savePrimarySubResources error", {
      context: "UnifiedContent", error: msg,
    });
    return json({ success: false, error: msg }, { status: 500 });
  }
}
