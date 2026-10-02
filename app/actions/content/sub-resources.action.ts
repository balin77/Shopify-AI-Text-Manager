/**
 * Sub-Resources Action Handlers
 *
 * Extracted from unified-content.actions.ts
 * Handles: loadSubResourceTranslations, saveSubResourceTranslations, translateSubResources,
 *          translateSubResourceToAllLocales, savePrimarySubResources
 */

import { data as json } from "react-router";
import { buildTranslateInstructions } from "~/utils/character-limits";
import { getInstructionWithDefault } from "~/utils/ai-instructions.utils";
import { AIService, isAuthError, isManagedRefusal } from "../../../src/services/ai.service";
import { managedRefusalResponseFromError } from "~/utils/ai-refusal-response.server";
import { getFormString } from "../../utils/form-data.utils";
import { collectRetranslationTaskIds } from "~/services/translations/retranslation-tasks.shared";
import { isValidLocale, isValidShopifyGID } from "../../utils/validation";
import { parseValueOrderPayload } from "~/services/product-options.shared";
import { isBatchTranslatableValueType } from "~/services/metaobject-fields.shared";
import { getFullErrorMessage } from "../../utils/error-handler";
import { markTranslationSaved } from "~/utils/translation-save-lock.server";
import { subResourceLockId, subResourceSyncShieldId } from "~/services/translations/translation-locks.shared";
import {
  LOCALE_KEY_SEP,
  mirrorConfirmedContentTranslations,
  removeAndVerify,
  removeVerifiedWithGapReread,
} from "~/services/translations/verified-translations.server";
import { getTaskExpirationDate } from "~/config/constants";
import { taskTitleOrFallback } from "~/services/tasks/resource-title.server";
import { logger } from "../../utils/logger.server";
import type { ContentActionHandlerContext } from "./alt-text.action";
import type { DataResponse } from "~/types/data-response";

/**
 * Shields the product's sub-resource translation CACHE from a sync that read
 * Shopify before this interactive write (or clear) landed. Sync-only: no
 * repair watches this key, so a merchant's translate never aborts a running
 * re-translation of the group (see translation-locks.shared.ts). Marked for
 * either layer -- the sync's rewrite deletes every layer it fetched.
 */
function markSubResourceSyncShield(productId: string | null | undefined): void {
  if (productId && productId.startsWith("gid://shopify/Product/")) {
    markTranslationSaved(subResourceSyncShieldId(productId));
  }
}

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
    return json({ success: false, actionType: "loadSubResourceTranslations", error: "Invalid locale format" }, { status: 400 });
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
        return json({ success: false, actionType: "loadSubResourceTranslations", error: `Invalid resource ID: ${rid}` }, { status: 400 });
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
          batch.map(rid => shopifyContentService.loadTranslationsWithDigests(rid, locale))
        );
        results.forEach((result, idx) => {
          if (result.status === "fulfilled" && result.value) {
            const rid = batch[idx];
            if (!translations[rid]) translations[rid] = {};
            // Derive resourceType from GID (e.g. gid://shopify/ProductOption/123 → ProductOption)
            const gidMatch = rid.match(/gid:\/\/shopify\/(\w+)\//);
            const resourceType = gidMatch ? gidMatch[1] : "Unknown";
            // The digest comes from the SAME read (null for an outdated row), so
            // the mirror is visible to the stale-translation detection.
            for (const t of result.value.translations) {
              translations[rid][t.key] = t.value;
              // Persist to DB so next navigation finds it via the loader pipeline
              dbWrites.push(
                db.contentTranslation.upsert({
                  where: { shop_resourceId_key_locale_marketId: { marketId: "",  shop: session.shop, resourceId: rid, key: t.key, locale } },
                  create: { shop: session.shop, resourceId: rid, resourceType, key: t.key, value: t.value, locale, digest: t.digest },
                  update: { value: t.value, digest: t.digest },
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
              batch.map(rid => shopifyContentService.loadTranslationsWithDigests(rid, locale, market.id))
            );
            results.forEach((result, idx) => {
              if (result.status === "fulfilled" && result.value) {
                const rid = batch[idx];
                const gidMatch = rid.match(/gid:\/\/shopify\/(\w+)\//);
                const resourceType = gidMatch ? gidMatch[1] : "Unknown";
                for (const t of result.value.translations) {
                  dbWrites.push(
                    db.contentTranslation.upsert({
                      where: { shop_resourceId_key_locale_marketId: { marketId: market.id, shop: session.shop, resourceId: rid, key: t.key, locale } },
                      create: { shop: session.shop, resourceId: rid, resourceType, key: t.key, value: t.value, locale, marketId: market.id, digest: t.digest },
                      update: { value: t.value, digest: t.digest },
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
    return json({ success: false, actionType: "loadSubResourceTranslations", error: msg }, { status: 500 });
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
  const { admin, session } = ctx;

  const locale = getFormString(formData, "locale");
  if (!locale || !isValidLocale(locale)) {
    return json({ success: false, actionType: "saveSubResourceTranslations", error: "Invalid locale format" }, { status: 400 });
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
    /** Resources with a key Shopify exposes no digest for: not writable there,
     *  which is a property of the field and not a refused write. */
    const notTranslatable: string[] = [];

    // Before the first write (a sync that read Shopify a moment ago must not
    // rewrite the cache under it) and again after the last one (below).
    const shieldProductId = ctx.itemId || getFormString(formData, "itemId");
    if (Object.keys(translationsData).length > 0) markSubResourceSyncShield(shieldProductId);

    logger.info('[UnifiedContent] saveSubResourceTranslations - Starting save operation', {
      context: "UnifiedContent",
      locale,
      resourceCount: Object.keys(translationsData).length,
      translationsData: JSON.stringify(translationsData), // Log full data to see what's missing
      resourceIds: Object.keys(translationsData),
    });

    for (const [resourceId, fields] of Object.entries(translationsData)) {
      if (!isValidShopifyGID(resourceId)) continue;

      try {
        const resourceType = resourceTypes[resourceId] || "Unknown";

        // Separate empty and non-empty values. EVERY clear is a REMOVAL, never
        // a registered "": Shopify rejects a blank option translation, a cleared
        // market override must revert to the inherited global value, and a
        // cleared GLOBAL metafield translation means "no translation" exactly as
        // on every other surface (registering "" stored a blank the storefront
        // then served instead of falling back to the primary text).
        const translationInputs: Array<{ key: string; value: string; locale: string }> = [];
        const keysToDelete: string[] = [];

        for (const [key, value] of Object.entries(fields)) {
          if (value === "") {
            keysToDelete.push(key);
          } else {
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

        /** Set when ANY key of this resource was not confirmed by Shopify. */
        let resourceFailed = false;

        // Save non-empty translations to Shopify (market-scoped when marketId
        // set). VERIFIED: only keys Shopify echoed are mirrored, with their
        // digest. A key it refused, did not echo, or had no digest for was NOT
        // stored -- the resource is reported failed, never mirrored as saved.
        if (translationInputs.length > 0) {
          const result = await shopifyContentService.saveTranslations(resourceId, translationInputs, marketId);
          await mirrorConfirmedContentTranslations(db, {
            shop: session.shop,
            resourceId,
            resourceType,
            locale,
            marketId,
            sent: translationInputs,
            result,
            digests: result.digests,
          });
          if (result.noDigest.length > 0 && !notTranslatable.includes(resourceId)) {
            notTranslatable.push(resourceId);
          }
          if (result.unconfirmedKeys.length > 0) {
            resourceFailed = true;
            logger.error(`[UnifiedContent] Shopify did not confirm every sub-resource translation for ${resourceId}`, {
              context: "UnifiedContent",
              resourceId,
              locale,
              unconfirmedKeys: result.unconfirmedKeys,
              noDigest: result.noDigest,
              userErrors: result.userErrors,
            });
          }
        }

        // Claim the SUB-RESOURCE the merchant just wrote. A detached
        // re-translation started by an earlier primary save watches every
        // resource of its group, and this is how it learns that a hand-written
        // value landed while it was working — without it the AI overwrites the
        // merchant minutes later, which is the one outcome
        // `isTranslationRecentlySaved` exists to prevent.
        markTranslationSaved(resourceId);

        // Remove the cleared keys. marketIds null = remove the global
        // translation; a market removes only that override. VERIFIED (echo, then
        // the re-read on a gap): the local row -- a DB-only mirror row included
        // -- is deleted only for a key Shopify confirmed gone.
        if (keysToDelete.length > 0) {
          const removal = await removeAndVerify(admin, resourceId, keysToDelete, locale, marketId);
          const confirmedKeys = keysToDelete.filter((key) => removal.confirmedKeys.has(key));
          if (confirmedKeys.length > 0) {
            await db.contentTranslation.deleteMany({
              where: { shop: session.shop, resourceId, key: { in: confirmedKeys }, locale, marketId },
            });
          }
          if (confirmedKeys.length < keysToDelete.length) {
            resourceFailed = true;
            logger.error(`[UnifiedContent] Shopify did not confirm removing translations for ${resourceId} — local rows kept`, {
              context: "UnifiedContent",
              resourceId,
              locale,
              unconfirmed: keysToDelete.filter((key) => !removal.confirmedKeys.has(key)),
              userErrors: removal.userErrors,
            });
          }
        }

        if (resourceFailed) {
          failedResources.push(resourceId);
          continue;
        }

        // A resource whose only problem is a digest-less key was not saved,
        // and was not refused either: reported under `notTranslatable`.
        if (!notTranslatable.includes(resourceId)) savedResources.push(resourceId);
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

    if (Object.keys(translationsData).length > 0) markSubResourceSyncShield(shieldProductId);

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
      notTranslatable,
    });
  } catch (error: unknown) {
    const msg = getFullErrorMessage(error);
    return json({ success: false, actionType: "saveSubResourceTranslations", error: msg }, { status: 500 });
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
    return json(
      { success: false, actionType: "translateSubResources", fieldId: getFormString(formData, "fieldId"), error: "Invalid target locale" },
      { status: 400 },
    );
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
  const subResourceLabel = resourceLabels.length > 50
    ? `${sourceData.length} sub-resource${sourceData.length > 1 ? 's' : ''}`
    : resourceLabels;
  // The options/metafields alone never said WHICH product they belong to —
  // the card showed "Farbe, Größe" under a bare "Product" badge. The item
  // leads; the sub-resources follow it, because `fieldType` here is the
  // constant "sub-resources" and would otherwise name nothing specific.
  const itemTitle = await taskTitleOrFallback(
    db, session.shop, contentConfig.resourceType, itemId,
  );
  const taskTitle = itemTitle ? `${itemTitle} – ${subResourceLabel}` : subResourceLabel;

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

    // Save translations to Shopify + DB. VERIFIED: only keys Shopify echoed are
    // mirrored (with their digest) and returned to the page; a resource with a
    // refused / unechoed / digest-less key is a failed resource.
    const savedResources: string[] = [];
    const failedResources: string[] = [];
    const notTranslatable: string[] = [];
    const confirmedTranslations: Record<string, Record<string, string>> = {};

    for (const [resourceId, fields] of Object.entries(translations)) {
      try {
        // Build translation inputs (saveTranslations handles digest internally)
        const translationInputs: Array<{ key: string; value: string; locale: string }> = [];
        for (const [key, value] of Object.entries(fields)) {
          translationInputs.push({ key, value, locale: targetLocale });
        }

        if (translationInputs.length > 0) {
          const sourceItem = sourceData.find(s => s.resourceId === resourceId);
          const resourceType = sourceItem?.resourceType || "Unknown";
          const result = await shopifyContentService.saveTranslations(resourceId, translationInputs);
          await mirrorConfirmedContentTranslations(db, {
            shop: session.shop,
            resourceId,
            resourceType,
            locale: targetLocale,
            sent: translationInputs,
            result,
            digests: result.digests,
          });
          for (const key of result.confirmedKeys) {
            (confirmedTranslations[resourceId] ??= {})[key] = result.confirmedValues.get(key) ?? fields[key];
          }
          // Claim the sub-resource (global layer) after a CONFIRMED write: a
          // detached repair watches each resource it is about to write and
          // must abandon it rather than overwrite this value.
          if (result.confirmedKeys.size > 0) {
            markTranslationSaved(resourceId);
            markSubResourceSyncShield(itemId);
          }
          if (result.noDigest.length > 0 && !notTranslatable.includes(resourceId)) {
            notTranslatable.push(resourceId);
          }
          if (result.unconfirmedKeys.length > 0) {
            logger.error(`[UnifiedContent] Shopify did not confirm every translated sub-resource key for ${resourceId}`, {
              context: "UnifiedContent",
              resourceId,
              targetLocale,
              unconfirmedKeys: result.unconfirmedKeys,
              noDigest: result.noDigest,
              userErrors: result.userErrors,
            });
            failedResources.push(resourceId);
            continue;
          }
        }

        if (!notTranslatable.includes(resourceId)) savedResources.push(resourceId);
      } catch (err) {
        logger.error(`[UnifiedContent] Failed to translate sub-resource ${resourceId}`, {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
        failedResources.push(resourceId);
      }
    }

    // Update task: "completed_with_errors" (the status the other translation
    // tasks use) when any resource failed, with the failures in the result.
    await db.task.update({
      where: { id: task.id },
      data: {
        status: failedResources.length > 0 ? "completed_with_errors" : "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({
          translatedCount: savedResources.length,
          failedCount: failedResources.length,
          failedResources,
          notTranslatable,
          failedLocales: failedResources.length > 0 ? [targetLocale] : [],
          targetLocale,
        }),
      },
    });

    return json({
      actionType: "translateSubResources",
      success: true,
      // Only what Shopify confirmed: the page paints these as saved translations.
      translations: confirmedTranslations,
      savedResources,
      failedResources,
      notTranslatable,
      failedLocales: failedResources.length > 0 ? [targetLocale] : [],
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
    const refused = managedRefusalResponseFromError(error, ctx.aiSettings, { actionType: "translateSubResources", fieldId: getFormString(formData, "fieldId") });
    if (refused) return refused;
    return json({ success: false, actionType: "translateSubResources", fieldId: getFormString(formData, "fieldId"), error: msg }, { status: 500 });
  }
}

// ============================================================================
// TRANSLATE SUB-RESOURCES TO ALL LOCALES (from primary language)
// ============================================================================

export async function handleTranslateSubResourceToAllLocales(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { admin, session, contentConfig, db, itemId, shopifyContentService, provider, serviceConfig, aiInstructions, translationMode, seoLimits } = ctx;

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
    .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary)
    .map((l: { locale: string }) => l.locale);

  if (targetLocales.length === 0) {
    return json({ actionType: "translateSubResourceToAllLocales", success: true, translations: {} });
  }

  // Build a descriptive task title
  const resourceLabels = sourceData.map(s => s.label).join(", ");
  const subResourceLabel = resourceLabels.length > 50
    ? `${sourceData.length} sub-resource${sourceData.length > 1 ? 's' : ''}`
    : resourceLabels;
  // The options/metafields alone never said WHICH product they belong to —
  // the card showed "Farbe, Größe" under a bare "Product" badge. The item
  // leads; the sub-resources follow it, because `fieldType` here is the
  // constant "sub-resources" and would otherwise name nothing specific.
  const itemTitle = await taskTitleOrFallback(
    db, session.shop, contentConfig.resourceType, itemId,
  );
  const taskTitle = itemTitle ? `${itemTitle} – ${subResourceLabel}` : subResourceLabel;

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

    // ONE AI pass for every language. The values do not vary by locale here —
    // they are the product's option names, option values and metafield values —
    // so this used to ask the SAME strings once per language, which on an
    // eight-language shop was eight requests for one click.
    // `translateBatchValuesToLocales` chunks on both dimensions, so sixty
    // metafields still split where they have to and a handful still go in one.
    const fieldsToTranslate: Record<string, string> = {};
    for (const item of sourceData) {
      fieldsToTranslate[`${item.resourceId}::${item.key}`] = item.value;
    }
    const values = Object.values(fieldsToTranslate);
    const keys = Object.keys(fieldsToTranslate);

    if (values.length > 0) {
      let perLocale: Record<string, string[]> = {};
      try {
        perLocale = await aiService.translateBatchValuesToLocales(
          values,
          primaryLocale,
          targetLocales,
          "product options and metafield values",
          // An option name and a metafield value are merchant content like a
          // title is, so the instruction that says how to word things applies
          // here too — the bulk grid's equivalent call now carries them, and one
          // setting behaving differently on two screens is the thing to avoid.
          // No field keys: a bare value has no named field for an SEO cap.
          {
            instructions: buildTranslateInstructions(
              getInstructionWithDefault(aiInstructions, "translateInstructions"),
              translationMode,
              [],
              { limits: seoLimits as unknown as Record<string, number> | null },
            ),
          },
        );
      } catch (err) {
        // Only a run whose EVERY chunk failed throws, so this is every locale.
        // An invalid API key aborts instead: every retry would 401 too, and
        // reporting success with all locales failed hides the real cause.
        // A managed refusal (budget, taster, consent) aborts for the same
        // reason: every locale would be refused identically.
        if (isAuthError(err) || isManagedRefusal(err)) throw err;
        logger.error("[UnifiedContent] Failed to translate sub-resources", {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
      }

      for (const targetLocale of targetLocales) {
        const translatedValues = perLocale[targetLocale];
        // A locale the batch could not deliver at all is a failed locale, the
        // same as before. A locale it delivered PARTLY keeps what came back: an
        // entry a chunk missed is "" and falls through the guard below, which is
        // the same "never write the source as a translation" rule the per-locale
        // version had.
        if (!translatedValues) {
          failedLocales.push(targetLocale);
          continue;
        }
        const translations: Record<string, Record<string, string>> = {};
        for (let i = 0; i < keys.length; i++) {
          const translated = translatedValues[i];
          // Skip fields the model didn't return — never write the
          // untranslated source value back as a "translation" (N-H3).
          if (!translated || !translated.trim()) continue;
          const [resourceId, key] = keys[i].split("::");
          if (!translations[resourceId]) translations[resourceId] = {};
          translations[resourceId][key] = translated;
        }
        if (Object.keys(translations).length === 0) {
          failedLocales.push(targetLocale);
          continue;
        }
        allTranslations[targetLocale] = translations;
      }

      await db.task
        .update({ where: { id: task.id }, data: { progress: 60 } })
        .catch(() => undefined);
    }

    // Save all translations to Shopify + DB. VERIFIED: a locale in which any
    // resource was refused / unechoed is a FAILED locale (and
    // that resource a failed resource); a digest-less key is `notTranslatable`.
    const failedResources: string[] = [];
    const notTranslatable: string[] = [];
    // Locales in which Shopify confirmed at least one key. "Not failed" is not
    // "translated": a locale whose every field is notTranslatable wrote nothing,
    // and reporting it as translated made a run that changed nothing read as a
    // clean "completed".
    const writtenLocales = new Set<string>();
    // The values Shopify CONFIRMED, per locale -> resource -> key: the client
    // stages them under the locale they were written for, so a merchant who
    // switched language while this ran sees them without a reload (the
    // loader re-read alone did not reach a view that was already open).
    const confirmedByLocale: Record<string, Record<string, Record<string, string>>> = {};
    for (const [locale, translations] of Object.entries(allTranslations)) {
      for (const [resourceId, fields] of Object.entries(translations)) {
        try {
          const translationInputs: Array<{ key: string; value: string; locale: string }> = [];
          for (const [key, value] of Object.entries(fields)) {
            translationInputs.push({ key, value, locale });
          }

          if (translationInputs.length > 0) {
            const sourceItem = sourceData.find(s => s.resourceId === resourceId);
            const resourceType = sourceItem?.resourceType || "Unknown";
            const result = await shopifyContentService.saveTranslations(resourceId, translationInputs);
            await mirrorConfirmedContentTranslations(db, {
              shop: session.shop,
              resourceId,
              resourceType,
              locale,
              sent: translationInputs,
              result,
              digests: result.digests,
            });
            if (result.confirmedKeys.size > 0) {
              writtenLocales.add(locale);
              for (const input of translationInputs) {
                if (!result.confirmedKeys.has(input.key)) continue;
                ((confirmedByLocale[locale] ??= {})[resourceId] ??= {})[input.key] = input.value;
              }
              // Same claim as the single-locale path, global layer.
              markTranslationSaved(resourceId);
              markSubResourceSyncShield(itemId);
            }
            if (result.noDigest.length > 0 && !notTranslatable.includes(resourceId)) {
              notTranslatable.push(resourceId);
            }
            if (result.unconfirmedKeys.length > 0) {
              logger.error(`[UnifiedContent] Shopify did not confirm every sub-resource key for ${resourceId} in ${locale}`, {
                context: "UnifiedContent",
                unconfirmedKeys: result.unconfirmedKeys,
                noDigest: result.noDigest,
                userErrors: result.userErrors,
              });
              if (!failedLocales.includes(locale)) failedLocales.push(locale);
              if (!failedResources.includes(resourceId)) failedResources.push(resourceId);
            }
          }
        } catch (err) {
          logger.error(`[UnifiedContent] Failed to save sub-resource translation for ${resourceId} in ${locale}`, {
            context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
          });
          if (!failedLocales.includes(locale)) failedLocales.push(locale);
          if (!failedResources.includes(resourceId)) failedResources.push(resourceId);
        }
      }
    }

    const translatedLocales = targetLocales.filter(
      (l: string) => writtenLocales.has(l) && !failedLocales.includes(l),
    );
    // Update task: "completed_with_errors" when any locale or resource failed,
    // or when nothing at all was written although fields were left untranslated.
    const nothingWritten = translatedLocales.length === 0 && notTranslatable.length > 0;
    await db.task.update({
      where: { id: task.id },
      data: {
        status: failedLocales.length > 0 || failedResources.length > 0 || nothingWritten ? "completed_with_errors" : "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({
          translatedLocales,
          failedLocales,
          failedResources,
          notTranslatable,
        }),
      },
    });

    // Return translations in the format expected by the hook (for current locale only - we return empty since already saved)
    return json({
      actionType: "translateSubResourceToAllLocales",
      success: true,
      translations: {}, // Already saved to Shopify; the confirmed values travel per locale below
      localeTranslations: confirmedByLocale,
      translatedLocales,
      failedLocales,
      failedResources,
      notTranslatable,
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
    const refused = managedRefusalResponseFromError(error, ctx.aiSettings, { actionType: "translateSubResourceToAllLocales", fieldId: getFormString(formData, "fieldId") });
    if (refused) return refused;
    return json({ success: false, actionType: "translateSubResourceToAllLocales", fieldId: getFormString(formData, "fieldId"), error: msg }, { status: 500 });
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
    return json({ success: false, actionType: "savePrimarySubResources", error: "Invalid product ID" }, { status: 400 });
  }

  // Hoisted out of the try: a save that fails half way has still started the
  // repairs of the resources it had finished, and the catch hands those ids on.
  const retranslationTaskIds: string[] = [];
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
    /** The Task row this save handed the detached re-translation to (one group
     *  for the whole product, so at most one) — on its way back to the page so
     *  it can reload once the AI is through instead of leaving the merchant in
     *  front of empty translations that are merely in flight. */
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
          .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary)
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

    // Sub-resources whose stale foreign translation Shopify did not confirm
    // removing (kept locally); surfaced as a warning on a save that worked.
    const purgeUnconfirmed: string[] = [];
    if (purgeStaleTranslations && somethingChanged && foreignLocales.length > 0) {
      // The purge deletes translation rows a sync reading Shopify a moment
      // earlier would put straight back; marked again once it is done.
      markSubResourceSyncShield(productId);
      // The MARKET overrides of every sub-resource this save moved. Nothing
      // re-translates one (the repair writes global rows only), so once the
      // option name or the metafield value changes the override is as stale as
      // the global row beside it — and a sub-resource is outside every webhook
      // and every sync-side reconciliation in this app, so nothing else looks
      // again. Option VALUES are covered by the option's own entry below only
      // where their ids are known; the removal loop addresses each id itself.
      try {
        const { purgeMarketOverrides } = await import(
          "~/services/translations/market-layer-purge.server"
        );
        const { contentTranslationMirror } = await import(
          "~/services/translations/stale-translation-sync.server"
        );
        const mirror = contentTranslationMirror(session.shop);
        // Exactly what the global removals below address, and no more. An
        // option whose VALUES changed did not necessarily get a new NAME — the
        // global loop guards on `changes?.name !== undefined` and the
        // auto-translate branch repeats it, so a market purge without that
        // guard would delete a hand-written market name whose primary text
        // never moved. Option VALUES are their OWN resource and need their own
        // refs; a `ProductOptionValue` row can never match a `ProductOption`
        // one, so leaving them out simply missed them.
        const nameRefs = changedOptionIds
          .filter((id) => isValidShopifyGID(id) && optionsChanges[id]?.name !== undefined)
          .map((id) => ({ resourceId: id, resourceType: "ProductOption" }));
        const valueRefs = changedOptionIds
          .filter((id) => isValidShopifyGID(id))
          .flatMap((id) =>
            (optionsChanges[id]?.valueUpdates ?? [])
              .filter((update) => isValidShopifyGID(update.id))
              .map((update) => ({ resourceId: update.id, resourceType: "ProductOptionValue" })),
          );
        const metafieldRefs = changedMetafieldIds
          .filter((id) => isValidShopifyGID(id))
          .map((id) => ({ resourceId: id, resourceType: "Metafield" }));

        // `name` and `value` are asked for together because the lookup is ONE
        // query over the whole set and a row only matches its own resource
        // type's key — a ProductOption has no `value` row to find.
        if (nameRefs.length + valueRefs.length + metafieldRefs.length > 0) {
          await purgeMarketOverrides({
            gateway,
            mirror,
            refs: [...nameRefs, ...valueRefs, ...metafieldRefs],
            locales: foreignLocales,
            keys: ["name", "value"],
            context: "subResource",
          });
        }
      } catch {
        // Logged inside; a stale override never fails a save that succeeded.
      }
      try {
        // (the `foreignLocales.length > 0` guard sits on the `if` above --
        // without it every changed sub-resource fired a
        // `translationsRemove(locales: [])` on a single-language shop)
        //
        // ONE verified removal per sub-resource, in the §6.6 pattern: a single
        // multi-locale call, then the single-locale re-read ONLY for a locale
        // that has a gap AND a local row. The local row is deleted ONLY for a
        // confirmed (locale, key): an unconfirmed removal keeps it (the next
        // sync corrects it), and a DB-only mirror row Shopify never held is
        // confirmed by the re-read and cleared. `admin`, not the gateway: this
        // is request-bound, but the gateway is what throttle-retries: a bare
        // `admin` call dropped a removal on the first THROTTLED answer.
        const purgeForeign = async (resourceId: string, resourceType: string, key: string) => {
          let localPairs: Set<string> | undefined;
          try {
            const rows: Array<{ locale: string; key: string }> = await db.contentTranslation.findMany({
              where: { shop: session.shop, resourceId, resourceType, key, marketId: "", locale: { in: foreignLocales } },
              select: { locale: true, key: true },
            });
            localPairs = new Set(rows.map((row) => `${row.locale}${LOCALE_KEY_SEP}${row.key}`));
          } catch {
            // Unknown local rows: every gap is re-read instead.
            localPairs = undefined;
          }
          const removal = await removeVerifiedWithGapReread(gateway, resourceId, [key], foreignLocales, "", { localPairs });
          const confirmedLocales = foreignLocales.filter((l) => removal.confirmedPairs.has(`${l}${LOCALE_KEY_SEP}${key}`));
          if (confirmedLocales.length > 0) {
            await db.contentTranslation.deleteMany({
              where: { shop: session.shop, resourceId, resourceType, key, locale: { in: confirmedLocales }, marketId: "" },
            });
          }
          if (removal.unconfirmedPairs.length > 0) {
            purgeUnconfirmed.push(resourceId);
            logger.warn(`[UnifiedContent] Shopify did not confirm removing ${resourceType} translations for ${resourceId} — local rows kept`, {
              context: "UnifiedContent",
              resourceId,
              unconfirmed: removal.unconfirmedPairs.length,
              userErrors: removal.userErrors,
            });
          }
        };

        // Delete option translations
        for (const optionId of changedOptionIds) {
          if (!isValidShopifyGID(optionId)) continue;

          const changes = optionsChanges[optionId];

          try {
            // Only delete option name translation if the name was actually changed
            if (changes?.name !== undefined) {
              await purgeForeign(optionId, "ProductOption", "name");
            }

            // Only delete translations for values that actually changed
            if (changes?.valueUpdates !== undefined && changes.valueUpdates.length > 0) {
              // Use value IDs from the changes payload directly
              for (const valueUpdate of changes.valueUpdates) {
                if (!valueUpdate.id) continue;
                await purgeForeign(valueUpdate.id, "ProductOptionValue", "name");
              }
            }
          } catch (err) {
            purgeUnconfirmed.push(optionId);
            logger.error(`[UnifiedContent] Failed to delete translations for option ${optionId}`, {
              context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Delete metafield translations
        for (const metafieldId of changedMetafieldIds) {
          if (!isValidShopifyGID(metafieldId)) continue;

          try {
            await purgeForeign(metafieldId, "Metafield", "value");
          } catch (err) {
            purgeUnconfirmed.push(metafieldId);
            logger.error(`[UnifiedContent] Failed to delete translations for metafield ${metafieldId}`, {
              context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        logger.error("[UnifiedContent] Failed to delete translations for changed sub-resources", {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
      }
      markSubResourceSyncShield(productId);
    }

    // 4b. …or, with auto-translate on, REPLACE the stale translations instead
    // of deleting them. One group for the whole save: an option, an option
    // value and a metafield are three Shopify resources but one merchant
    // action, so they share a Task row, one batched detection and one AI
    // request per locale. Best-effort — the primary writes above have already
    // gone through, so nothing here may fail the save.
    if (selfRetranslated && somethingChanged) {
      try {
      const changed: Array<{
        resourceId: string;
        resourceType: string;
        key: string;
        retranslatable?: boolean;
      }> = [];
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
      // A metafield's TYPE decides whether its value can go through the generic
      // prompt at all: a multi-line text comes back with its newlines stripped
      // and a list field is raw JSON, and both would be echo-confirmed and
      // mirrored — a corruption recorded as a success, where the previous
      // behaviour was a plain deletion. The bulk editor draws the same line.
      const metafieldTypes = new Map<string, string>(
        changedMetafieldIds.length > 0
          ? (
              await db.productMetafield.findMany({
                where: { productId, id: { in: changedMetafieldIds } },
                select: { id: true, type: true },
              })
            ).map((row: { id: string; type: string }) => [row.id, row.type])
          : [],
      );
      for (const metafieldId of changedMetafieldIds) {
        if (!isValidShopifyGID(metafieldId)) continue;
        changed.push({
          resourceId: metafieldId,
          resourceType: "Metafield",
          key: "value",
          // An UNKNOWN type (not in the cache) counts as unsafe: guessing
          // "single line" is the direction that corrupts.
          retranslatable: isBatchTranslatableValueType(metafieldTypes.get(metafieldId) ?? ""),
        });
      }

      if (changed.length > 0) {
        {
          const { reconcileAfterPrimarySave } = await import(
            "~/services/translations/stale-translation-sync.server"
          );
          const outcome = await reconcileAfterPrimarySave({
            client: admin,
            shop: session.shop,
            // The GROUP is the product: one Task row the merchant recognises,
            // one in-flight key, one `markTranslationSaved`. Each entry names
            // the sub-resource its translation actually lives on.
            resourceId: productId,
            resourceType: "Product",
            // Same reason as the alt-text repair: the Task row names the
            // product, the lock does not, so the product's OWN field
            // reconciliation on the next webhook is not blocked by this.
            lockId: subResourceLockId(productId),
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
          // The run is detached, so its Task id is the only handle the page has
          // on it. Without it a merchant watched an option name's translations
          // stay empty for the minute the AI was working.
          if (outcome.taskId) retranslationTaskIds.push(outcome.taskId);
        }
      }
      } catch (err) {
        // Everything from the metafield-type lookup onwards: the sub-resource
        // writes have already gone through, so a failure here must not report a
        // completed save as broken and invite a re-save that repeats every
        // Shopify write.
        logger.warn("[UnifiedContent] Sub-resource re-translation failed — translations kept", {
          context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
        });
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
      retranslationTaskIds: collectRetranslationTaskIds(retranslationTaskIds),
      ...(purgeUnconfirmed.length > 0
        ? { warnings: ["translationPurgeUnconfirmed"], unconfirmedPurge: purgeUnconfirmed }
        : {}),
    });
  } catch (error: unknown) {
    const msg = getFullErrorMessage(error);
    logger.error("[UnifiedContent] savePrimarySubResources error", {
      context: "UnifiedContent", error: msg,
    });
    return json({ success: false, actionType: "savePrimarySubResources", error: msg, ...(retranslationTaskIds.length > 0 ? { retranslationTaskIds: collectRetranslationTaskIds(retranslationTaskIds) } : {}) }, { status: 500 });
  }
}
