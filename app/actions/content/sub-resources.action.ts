/**
 * Sub-Resources Action Handlers
 *
 * Extracted from unified-content.actions.ts
 * Handles: loadSubResourceTranslations, saveSubResourceTranslations, translateSubResources,
 *          translateSubResourceToAllLocales, savePrimarySubResources
 */

import { data as json } from "react-router";
import { AIService, isAuthError } from "../../../src/services/ai.service";
import { getFormString } from "../../utils/form-data.utils";
import { isValidLocale, isValidShopifyGID } from "../../utils/validation";
import { parseValueOrderPayload } from "~/services/product-options.shared";
import { getFullErrorMessage } from "../../utils/error-handler";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "../../utils/logger.server";
import type { ContentActionHandlerContext } from "./alt-text.action";
import type { DataResponse } from "~/types/data-response";

// ============================================================================
// LOAD SUB-RESOURCE TRANSLATIONS (Options + Metafields)
// ============================================================================

export async function handleLoadSubResourceTranslations(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
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

    // Batch: load from local DB first (faster). This is the GLOBAL supplement —
    // it fills the global layer for resources with no DB row yet; the market
    // layer is carried by the loader's subResourceTranslations (DB) + client
    // overlay, so scope to marketId "" for a deterministic global read.
    const dbTranslations = await db.contentTranslation.findMany({
      where: {
        resourceId: { in: resourceIds },
        locale,
        marketId: "",
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
                  where: { shop_resourceId_key_locale_marketId: { marketId: "",  shop: session.shop, resourceId: rid, key: t.key, locale } },
                  create: { shop: session.shop, resourceId: rid, resourceType, key: t.key, value: t.value, locale },
                  update: { value: t.value },
                })
              );
            }
          }
        });
      }

      // Market layers (read-back supplement): for the ids that had no DB row,
      // also pull each market's overrides for this locale and persist them so
      // the loader's marketTranslations pipeline finds them on the next
      // navigation. The RESPONSE stays global-only — the market layer reaches
      // the editor via the loader + client overlay, not via this payload.
      try {
        const { markets } = await shopifyContentService.loadMarkets();
        const marketsForLocale = markets.filter(
          (m) => m.localeCodes.length === 0 || m.localeCodes.includes(locale)
        );
        for (const market of marketsForLocale) {
          for (let i = 0; i < missingIds.length; i += batchSize) {
            const batch = missingIds.slice(i, i + batchSize);
            const results = await Promise.allSettled(
              batch.map(rid => shopifyContentService.loadTranslations(rid, locale, market.id))
            );
            results.forEach((result, idx) => {
              if (result.status === "fulfilled" && result.value) {
                const rid = batch[idx];
                const gidMatch = rid.match(/gid:\/\/shopify\/(\w+)\//);
                const resourceType = gidMatch ? gidMatch[1] : "Unknown";
                for (const t of result.value) {
                  dbWrites.push(
                    db.contentTranslation.upsert({
                      where: { shop_resourceId_key_locale_marketId: { marketId: market.id, shop: session.shop, resourceId: rid, key: t.key, locale } },
                      create: { shop: session.shop, resourceId: rid, resourceType, key: t.key, value: t.value, locale, marketId: market.id },
                      update: { value: t.value },
                    })
                  );
                }
              }
            });
          }
        }
      } catch (marketErr) {
        // Market read-back is best-effort — the global supplement above must
        // never fail because markets could not be loaded.
        logger.warn('[UnifiedContent] loadSubResourceTranslations market supplement failed', {
          context: 'UnifiedContent',
          error: marketErr instanceof Error ? marketErr.message : String(marketErr),
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
): Promise<DataResponse> {
  const { db, shopifyContentService } = ctx;
  // gateway is needed for deleting translations
  const { admin, session } = ctx;

  const locale = getFormString(formData, "locale");
  if (!locale || !isValidLocale(locale)) {
    return json({ success: false, error: "Invalid locale format" }, { status: 400 });
  }

  // Market GID for a market-specific override; "" = global (all markets).
  const marketId = getFormString(formData, "marketId") || "";

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
          const isEmpty = value === "";
          const isOptionType = resourceType === "ProductOptionValue" || resourceType === "ProductOption";
          // Delete (rather than store "") when: an option field is cleared
          // (Shopify rejects blank option translations), OR any field is cleared
          // in a MARKET context — clearing a market override reverts to the
          // inherited global value instead of pinning a blank market-specific one.
          if (isEmpty && (isOptionType || marketId)) {
            keysToDelete.push(key);
          } else {
            // Non-empty value OR empty value in the global context for other types
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

        // Save non-empty translations to Shopify (market-scoped when marketId set)
        if (translationInputs.length > 0) {
          await shopifyContentService.saveTranslations(resourceId, translationInputs, marketId);
        }

        // Delete empty translations for ProductOptionValue. marketIds null =
        // remove the global translation; a market removes only that override.
        if (keysToDelete.length > 0) {
          const deleteResponse = await gateway.graphql(
            `#graphql
              mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!, $marketIds: [ID!]) {
                translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales, marketIds: $marketIds) {
                  userErrors { field message }
                }
              }`,
            {
              variables: {
                resourceId,
                translationKeys: keysToDelete,
                locales: [locale],
                marketIds: marketId ? [marketId] : null,
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
          const isEmpty = value === "";
          const isOptionType = resourceType === "ProductOptionValue" || resourceType === "ProductOption";
          if (isEmpty && (isOptionType || marketId)) {
            // Cleared option field, or any field cleared in a market context:
            // delete the DB row (Shopify removal already done above). Scoped to the
            // saved market so clearing a market override doesn't wipe the global row.
            await db.contentTranslation.deleteMany({
              where: { resourceId, key, locale, marketId },
            });
          } else {
            // For all other cases, save to DB (market-scoped)
            await db.contentTranslation.upsert({
              where: { shop_resourceId_key_locale_marketId: { marketId, shop: session.shop, resourceId, key, locale } },
              create: { shop: session.shop, resourceId, resourceType, key, value, locale, marketId },
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
): Promise<DataResponse> {
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
        const translated = translatedValues[i];
        // Skip fields the model didn't return — never write the untranslated
        // source value back as a "translation" (N-H3).
        if (!translated) continue;
        const [resourceId, key] = keys[i].split("::");
        if (!translations[resourceId]) translations[resourceId] = {};
        translations[resourceId][key] = translated;
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
            where: { shop_resourceId_key_locale_marketId: { marketId: "",  shop: session.shop, resourceId, key, locale: targetLocale } },
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
): Promise<DataResponse> {
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
            const translated = translatedValues[i];
            // Skip fields the model didn't return — never write the
            // untranslated source value back as a "translation" (N-H3).
            if (!translated) continue;
            const [resourceId, key] = keys[i].split("::");
            if (!translations[resourceId]) translations[resourceId] = {};
            translations[resourceId][key] = translated;
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
        // Invalid API key: abort — every remaining locale would 401 too. Surface
        // it so the request fails loudly instead of reporting success with every
        // locale in failedLocales.
        if (isAuthError(err)) throw err;
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
              where: { shop_resourceId_key_locale_marketId: { marketId: "",  shop: session.shop, resourceId, key, locale } },
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

/** A JSON list from the form, or an empty one. A malformed payload must not
 *  fail the whole save — the other halves of it are still valid. */
function safeParseList<T>(raw: string): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * The value GIDs an option currently has, from the cache.
 *
 * Only needed on the way OUT: once the option is deleted, nothing can name the
 * `ContentTranslation` rows its values leave behind, and no other path in the
 * app ever removes them.
 */
async function cachedOptionValueIds(
  db: ContentActionHandlerContext["db"],
  optionId: string,
): Promise<string[]> {
  try {
    const row = await db.productOption.findUnique({ where: { id: optionId }, select: { values: true } });
    const parsed: unknown = JSON.parse(row?.values ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // The legacy `["string"]` shape carries no ids, so it yields none rather
    // than throwing -- a missed cleanup, never a wrong delete.
    return parsed
      .map((v) => (typeof v === "object" && v && "id" in v ? String((v as { id: unknown }).id) : ""))
      .filter((id) => isValidShopifyGID(id));
  } catch {
    return [];
  }
}

export async function handleSavePrimarySubResources(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { admin, session, db } = ctx;

  const productId = getFormString(formData, "productId");

  if (!productId || !isValidShopifyGID(productId)) {
    return json({ success: false, error: "Invalid product ID" }, { status: 400 });
  }

  try {
    const optionsChangesJson = getFormString(formData, "optionsChanges");
    const metafieldChangesJson = getFormString(formData, "metafieldChanges");

    const optionsChanges: Record<
      string,
      {
        name?: string;
        valueUpdates?: { id: string; name: string }[];
        valuesToAdd?: string[];
        /** Metaobject GIDs, for a linked option — see `OptionValueChange`. */
        valuesToAddLinked?: string[];
        valuesToDelete?: string[];
      }
    > = optionsChangesJson ? JSON.parse(optionsChangesJson) : {};
    /** Brand-new options, and options to remove entirely. */
    const optionsToCreate: Array<{ name: string; values: string[] }> = safeParseList(
      getFormString(formData, "optionsToCreate"),
    );
    const optionsToDelete: string[] = safeParseList(getFormString(formData, "optionsToDelete"));
    /** The full ordered list of option ids, after the creates and deletes. */
    const optionOrder: string[] = safeParseList(getFormString(formData, "optionOrder"));
    /** Value GIDs in their new order, per option id. Reordering VALUES is what
     *  decides which variant the storefront shows first. Parsed in a shared,
     *  testable module -- it is a positional payload and its all-or-nothing
     *  rule is the kind that shipped wrong while it lived inline. */
    const optionValueOrder = parseValueOrderPayload(
      getFormString(formData, "optionValueOrder"),
      isValidShopifyGID,
    );
    /** Failure CODES from the option writes — phrased by the client. */
    const optionWarnings: string[] = [];
    /** Create / delete / reorder failures. They have no option id to report
     *  under, so they are counted here -- see the response below. */
    let structuralFailures = 0;
    /** Options and values that no longer exist. Their translation rows have no
     *  owner left, and nothing else in the app would ever remove them. */
    const removedOptionIds: string[] = [];
    const removedValueIds: string[] = [];
    const metafieldChanges: Record<string, string> = metafieldChangesJson
      ? JSON.parse(metafieldChangesJson) : {};

    const { METAFIELDS_SET } = await import("~/graphql/content.mutations");

    const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
    const gateway = new ShopifyApiGateway(admin, session.shop);

    const savedOptions: string[] = [];
    const failedOptions: string[] = [];
    const savedMetafields: string[] = [];
    const failedMetafields: string[] = [];

    // 1. Options: names, values, and — new — adding, deleting and reordering.
    //
    // All of it goes through `product-options.server.ts` rather than an inline
    // mutation here. That module owns the rules that make these writes safe:
    // `variantStrategy` only where the matrix actually moves, the echo check,
    // and a cache mirror built from what Shopify STORED (an added value's GID
    // is assigned by Shopify, and every translation write addresses values by
    // GID). A second copy of that here is how the two would drift.
    const {
      applyOptionChange,
      createOption,
      deleteOption,
      reorderOptions,
    } = await import("~/services/product-options.server");

    /** Order matters: create before reorder, so a new option can be placed;
     *  delete before reorder, so the order does not name a gone option. */
    for (const create of optionsToCreate) {
      const warning = await createOption(admin, db, session.shop, {
        productId,
        name: create.name,
        values: create.values,
      });
      if (warning) {
        optionWarnings.push(warning);
        structuralFailures++;
      }
    }

    for (const optionId of optionsToDelete) {
      if (!isValidShopifyGID(optionId)) continue;
      // Read the value ids BEFORE the delete: afterwards the cache row is gone
      // and nothing could name the translation rows they leave behind.
      const cachedValueIds = await cachedOptionValueIds(db, optionId);
      const warning = await deleteOption(admin, db, session.shop, {
        productId,
        optionId,
        // Counted from the CACHE, which is the server's own state — a client
        // that under-reports it could talk this into deleting the last option.
        // Keyed by the GID: that is what `Product.id` holds, and a numeric id
        // matches no row at all -- which counted 0 and refused every delete as
        // "the last option".
        remainingCount: await db.productOption.count({ where: { productId } }),
      });
      if (warning) {
        optionWarnings.push(warning);
        structuralFailures++;
      } else {
        // NOT savedOptions: a deleted option has no primary value to have
        // changed, and the generic invalidation below would find no entry for
        // it and skip it silently. Its translations are removed outright.
        removedOptionIds.push(optionId);
        removedValueIds.push(...cachedValueIds);
      }
    }

    for (const [optionId, changes] of Object.entries(optionsChanges)) {
      if (!isValidShopifyGID(optionId)) continue;
      const warning = await applyOptionChange(admin, db, session.shop, {
        productId,
        optionId,
        name: changes.name,
        values: {
          toUpdate: changes.valueUpdates,
          toAdd: changes.valuesToAdd,
          toAddLinked: changes.valuesToAddLinked,
          toDelete: changes.valuesToDelete,
        },
      });
      if (warning) {
        optionWarnings.push(warning);
        failedOptions.push(optionId);
      } else {
        savedOptions.push(optionId);
        if (changes.valuesToDelete?.length) removedValueIds.push(...changes.valuesToDelete);
      }
    }

    // One call does both halves. The client sends the full option order
    // whenever EITHER half moved, so a pure value reorder still has a list of
    // options to hang its values on.
    if (optionOrder.length > 0 && (optionOrder.length > 1 || Object.keys(optionValueOrder).length > 0)) {
      const warning = await reorderOptions(admin, db, session.shop, {
        productId,
        orderedIds: optionOrder.filter(isValidShopifyGID),
        valueOrder: optionValueOrder,
      });
      if (warning) {
        optionWarnings.push(warning);
        structuralFailures++;
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

          // Mirror saved metafield values into the local DB so the client's
          // post-save revalidation reads the fresh value (see option mirror above).
          for (const [mfId, value] of Object.entries(metafieldChanges)) {
            try {
              await db.productMetafield.update({ where: { id: mfId }, data: { value } });
            } catch (err) {
              logger.error(`[UnifiedContent] Failed to mirror primary metafield ${mfId} into DB`, {
                context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      } catch (err) {
        logger.error("[UnifiedContent] Failed to update metafields", {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
        Object.keys(metafieldChanges).forEach(mfId => failedMetafields.push(mfId));
      }
    }

    // 4. Delete translations for changed fields in all foreign languages
    //
    // Only what was actually SAVED. Unioning in every requested id invalidated
    // the foreign translations of a write Shopify REJECTED -- the primary value
    // is unchanged, so the translations were still correct and are now gone.
    // An id that appears in both lists (one value of an option saved, another
    // failed) counts as failed: the option's primary text did move, but taking
    // its translations on a half-applied write is the destructive reading.
    //
    // Whether the purge happens at all is a merchant switch (Settings →
    // Übersetzungen); the lookup fails OPEN so an error keeps the historic
    // behaviour.
    const changedOptionIds = savedOptions.filter((id) => !failedOptions.includes(id));
    const changedMetafieldIds = savedMetafields.filter((id) => !failedMetafields.includes(id));
    const somethingChanged = changedOptionIds.length > 0 || changedMetafieldIds.length > 0;
    const { loadTranslationChangePolicy } = await import(
      "~/services/translations/translation-change-policy.server"
    );
    const changePolicy = somethingChanged
      ? await loadTranslationChangePolicy(session.shop, db)
      : null;
    // A sub-resource is repaired by THIS save or by nothing at all: an option,
    // an option value and a metafield each translate on their OWN Shopify
    // resource, which no sync and no webhook in this app ever looks at. So with
    // auto-translate on, the re-translation below IS the repair and the
    // deletion stands down — read through the policy rather than written as
    // `false`, because which of the two switches applies is that module's
    // question, never a call site's.
    const autoTranslate = !!changePolicy?.autoTranslateExternalChanges;

    // Locales for both passes below, fetched once and only when one can run.
    let foreignLocales: string[] = [];
    let shopPrimaryLocale = "";
    if (somethingChanged && !!changePolicy) {
      try {
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
        foreignLocales = shopLocales
          .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary && l.published)
          .map((l: { locale: string }) => l.locale);
        shopPrimaryLocale =
          shopLocales.find((l: { primary: boolean }) => l.primary)?.locale || "";
      } catch (err) {
        // Non-fatal: the sub-resource writes have already gone through, so
        // failing the save here would report a write that succeeded as broken.
        logger.warn("[UnifiedContent] Could not load shop locales — sub-resource translations untouched", {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Decided AFTER the lookup, because it depends on its result: without a
    // known PRIMARY locale there is nothing to translate FROM, and the repair
    // cannot run — so the deletion has to, or the stale text stays live for
    // good on a surface nothing else ever revisits.
    const selfRetranslated = autoTranslate && !!shopPrimaryLocale && foreignLocales.length > 0;
    const purgeStaleTranslations =
      !!changePolicy &&
      (selfRetranslated
        ? changePolicy.purgeOnPrimaryChange
        : changePolicy.purgeUnreconciledSurfaces);

    if (purgeStaleTranslations && somethingChanged && foreignLocales.length > 0) {
      try {
        {
          // (the `foreignLocales.length > 0` guard now sits on the `if` above —
          // without it every changed sub-resource fired a
          // `translationsRemove(locales: [])` on a single-language shop)
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
                      marketId: "",
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
                        marketId: "",
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
                    marketId: "",
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

    // 4b. …or, with auto-translate on, REPLACE the stale translations instead
    // of deleting them. One group for the whole save: an option, an option
    // value and a metafield are three Shopify resources but one merchant
    // action, so they share a Task row, one batched detection and one AI
    // request per locale. Best-effort — the primary writes above have already
    // gone through, so nothing here may fail the save.
    if (selfRetranslated && somethingChanged) {
      const changed: Array<{ resourceId: string; resourceType: string; key: string }> = [];
      for (const optionId of changedOptionIds) {
        if (!isValidShopifyGID(optionId)) continue;
        const changes = optionsChanges[optionId];
        // Same rule as the purge above: only what the merchant actually moved.
        // An option whose VALUES changed did not necessarily get a new name.
        if (changes?.name !== undefined) {
          changed.push({ resourceId: optionId, resourceType: "ProductOption", key: "name" });
        }
        for (const valueUpdate of changes?.valueUpdates ?? []) {
          if (!valueUpdate.id || !isValidShopifyGID(valueUpdate.id)) continue;
          changed.push({
            resourceId: valueUpdate.id,
            resourceType: "ProductOptionValue",
            key: "name",
          });
        }
      }
      for (const metafieldId of changedMetafieldIds) {
        if (!isValidShopifyGID(metafieldId)) continue;
        changed.push({ resourceId: metafieldId, resourceType: "Metafield", key: "value" });
      }

      if (changed.length > 0) {
        try {
          const { reconcileAfterPrimarySave } = await import(
            "~/services/translations/stale-translation-sync.server"
          );
          await reconcileAfterPrimarySave({
            client: admin,
            shop: session.shop,
            // The GROUP is the product: one Task row the merchant recognises,
            // one in-flight key, one `markTranslationSaved`. Each entry names
            // the sub-resource its translation actually lives on.
            resourceId: productId,
            resourceType: "Product",
            contentKind: "product",
            // Read from the cache rather than taken from the form: the client
            // does not send a title here, and a Task row labelled with a GID is
            // one the merchant cannot match to anything they did.
            resourceTitle:
              (await db.product.findFirst({
                where: { shop: session.shop, id: productId },
                select: { title: true },
              }))?.title || productId,
            changed,
            foreignLocales,
            policy: changePolicy!,
            // No field semantics: an option name and a metafield value have no
            // named field to hang the merchant's per-field instructions or an
            // SEO character limit on. Same context string the bulk editor
            // passes for exactly these columns.
            translateAs: {
              kind: "values",
              context: "product options and metafield values",
              sourceLocale: shopPrimaryLocale,
            },
          });
        } catch (err) {
          logger.warn("[UnifiedContent] Sub-resource re-translation failed — translations kept", {
            context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 5. Translation rows whose OWNER is gone.
    //
    // A deleted option or value takes its Shopify resource with it, so there is
    // nothing left to call `translationsRemove` on -- and nothing else in the
    // app would ever visit these rows again. Left behind they are unbounded
    // drift in a table the bulk editor reads. GIDs are never reused, so this
    // cannot orphan a live translation.
    if (removedOptionIds.length > 0 || removedValueIds.length > 0) {
      try {
        if (removedOptionIds.length > 0) {
          await db.contentTranslation.deleteMany({
            where: { resourceId: { in: removedOptionIds }, resourceType: "ProductOption" },
          });
        }
        if (removedValueIds.length > 0) {
          await db.contentTranslation.deleteMany({
            where: { resourceId: { in: removedValueIds }, resourceType: "ProductOptionValue" },
          });
        }
      } catch (err) {
        // Cache hygiene, not correctness: the resource is gone either way.
        logger.warn("[UnifiedContent] Failed to clean up translations of deleted options", {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return json({
      actionType: "savePrimarySubResources",
      success: true,
      savedOptions,
      removedOptionIds,
      // Failure CODES — the client phrases them, this app ships in three
      // languages and the server has no business writing English here.
      //
      // `structuralFailures` counts the create/delete/reorder failures that
      // have no option id to report under. Without it the client saw
      // `failedOptions: []`, called the save a success, and cleared the
      // pending lists -- destroying the merchant's edit and saying it was
      // saved. This app treats that shape as the bug, not the nuisance.
      optionWarnings,
      structuralFailures,
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
