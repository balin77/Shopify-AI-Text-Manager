/**
 * Translation Action Handlers
 *
 * Extracted from unified-content.actions.ts
 * Handles: translateField, translateAll, translateAllForLocale, translateFieldToAllLocales
 */

import { data as json } from "react-router";
import { TranslationService } from "../../../src/services/translation.service";
import { getFormString } from "../../utils/form-data.utils";
import { isValidLocale, safeJsonParse } from "../../utils/validation";
import { getFullErrorMessage } from "../../utils/error-handler";
import { getInstructionWithDefault } from "~/utils/ai-instructions.utils";
import { buildTranslateInstructions } from "~/utils/character-limits";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "../../utils/logger.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Session } from "@shopify/shopify-api";
import type { PrismaClient } from "@prisma/client";
import type { ContentActionHandlerContext } from "./alt-text.action";
import type { DataResponse } from "~/types/data-response";

// ============================================================================
// METAOBJECT TRANSLATION HELPER (local copy)
// ============================================================================

async function translateMetaobjectEntries(params: {
  admin: AdminApiContext;
  session: Session;
  db: PrismaClient;
  /**
   * Keyed by `<Metaobject GID>#<field key>` — the editor's compound field key
   * (PLAN_METAOBJECTS_EDITOR §6.1). It used to be the bare entry GID, which is
   * why this helper looked up "the label field" for every entry: there was no
   * other field it could have meant. Now the key names the field itself.
   */
  metaobjectFields: Record<string, string>;
  targetLocales: string[];
  translationService: TranslationService;
  customInstructions?: string;
}): Promise<{ translations: Record<string, Record<string, string>>; failedLocales: string[] }> {
  const { admin, session, db, metaobjectFields, targetLocales, translationService, customInstructions } = params;
  const { TRANSLATE_CONTENT } = await import("../../graphql/content.mutations");
  const { GET_TRANSLATABLE_CONTENT } = await import("../../graphql/content.queries");
  const { parseMetaobjectFieldKey } = await import("~/services/metaobject-fields.shared");

  // Build short-key mapping for cleaner AI prompts. A key that is NOT compound
  // is dropped rather than guessed at: it would reach `metaobject(id: …)` as a
  // malformed id and translate nothing, which is worse than saying so.
  const compoundKeys = Object.keys(metaobjectFields).filter((key) => parseMetaobjectFieldKey(key) !== null);
  const shortToKey: Record<string, string> = {};
  const shortFields: Record<string, string> = {};

  compoundKeys.forEach((key, i) => {
    const short = `entry_${i}`;
    shortToKey[short] = key;
    shortFields[short] = metaobjectFields[key];
  });

  if (compoundKeys.length === 0) {
    return { translations: {}, failedLocales: [...targetLocales] };
  }

  // AI translation (all entries × all locales in one request)
  const aiResult = await translationService.translateProduct(
    shortFields,
    targetLocales,
    "metaobject",
    customInstructions
  );

  // Map AI results back to GID keys
  const allTranslations: Record<string, Record<string, string>> = {};
  const failedLocales: string[] = [];

  for (const locale of targetLocales) {
    const localeResult = aiResult[locale];
    if (!localeResult || Object.keys(localeResult).length === 0) {
      failedLocales.push(locale);
      continue;
    }
    allTranslations[locale] = {};
    for (const [shortKey, value] of Object.entries(localeResult)) {
      const compound = shortToKey[shortKey];
      if (compound && value) {
        allTranslations[locale][compound] = String(value);
      }
    }
  }

  // Save translations to Shopify + DB for each metaobject × locale
  for (const [locale, fieldMap] of Object.entries(allTranslations)) {
    for (const [compound, translatedValue] of Object.entries(fieldMap)) {
      const parsed = parseMetaobjectFieldKey(compound);
      if (!parsed) continue;
      const { metaobjectId, fieldKey } = parsed;
      try {
        // The cache row is the tenancy check AND the source of the type the DB
        // row is stamped with. `itemId` on this page is `metaobject_type_<type>`
        // and stamping THAT is what the definition stale-delete then removes
        // (PLAN_METAOBJECTS_EDITOR B5) — masked while every key was a label
        // field, real now that any field key can occur.
        const cached = await db.metaobject.findUnique({
          where: { shop_id: { shop: session.shop, id: metaobjectId } },
          select: { type: true },
        });
        if (!cached) continue;

        // Fetch digest for THIS field. `translatableContent` only lists keys
        // that have a primary value, so a missing digest means the source field
        // is empty — nothing to translate, not a failure.
        const digestResponse = await admin.graphql(GET_TRANSLATABLE_CONTENT, {
          variables: { resourceId: metaobjectId },
        });
        const digestData = await digestResponse.json();
        const tc = digestData.data?.translatableResource?.translatableContent || [];
        const digestEntry = tc.find((c: { key: string; digest: string | null }) => c.key === fieldKey);
        if (!digestEntry?.digest) continue;

        // Register translation
        await admin.graphql(TRANSLATE_CONTENT, {
          variables: {
            resourceId: metaobjectId,
            translations: [{
              key: fieldKey,
              value: translatedValue,
              locale,
              translatableContentDigest: digestEntry.digest,
            }],
          },
        });

        // Upsert DB
        await db.metaobjectTranslation.upsert({
          where: {
            shop_metaobjectId_key_locale_marketId: {
              marketId: "",
              shop: session.shop,
              metaobjectId,
              key: fieldKey,
              locale,
            },
          },
          create: {
            shop: session.shop,
            metaobjectId,
            type: cached.type,
            key: fieldKey,
            value: translatedValue,
            locale,
            outdated: false,
          },
          update: {
            value: translatedValue,
            outdated: false,
            // Repairs a row an older build stamped with the pseudo-item id.
            type: cached.type,
            updatedAt: new Date(),
          },
        });
      } catch (err: unknown) {
        logger.error("[translateMetaobjectEntries] Error saving translation", {
          context: "Metaobjects",
          metaobjectId,
          fieldKey,
          locale,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { translations: allTranslations, failedLocales };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Determine the actual Shopify resource type from the item GID.
 * For the blogs editor, the config says "Article" but Blog container items
 * have GIDs like gid://shopify/Blog/123 and need "Blog" as resource type.
 */
function getEffectiveResourceType(itemId: string, configResourceType: string): string {
  return itemId.includes("/Blog/") ? "Blog" : configResourceType;
}

// ============================================================================
// TRANSLATE FIELD
// ============================================================================

export async function handleTranslateField(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { session, contentConfig, db, aiInstructions, itemId, provider, serviceConfig, seoTitleMaxChars, seoLimits, translationMode } = ctx;

  const fieldType = getFormString(formData, "fieldType");
  const sourceText = getFormString(formData, "sourceText");
  const targetLocale = getFormString(formData, "targetLocale");
  if (!targetLocale || !isValidLocale(targetLocale)) {
    return json({ success: false, error: "Invalid target locale format" }, { status: 400 });
  }

  // Create task entry
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "translation",
      status: "pending",
      resourceType: getEffectiveResourceType(itemId, contentConfig.resourceType),
      resourceId: itemId,
      fieldType,
      targetLocale,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    // Create translation service with shop and taskId for queue management
    const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

    const changedFields: Record<string, string> = {};
    changedFields[fieldType] = sourceText;

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    // Get translate instructions (from DB or default) and — when the merchant
    // has SEO-optimized translation mode on — append per-field length caps so
    // long primary text gets paraphrased to fit the SEO limits.
    const translateInstructions = buildTranslateInstructions(
      getInstructionWithDefault(aiInstructions, "translateInstructions"),
      translationMode,
      [fieldType],
      { seoTitleMaxChars, limits: seoLimits },
    );

    const translations = await translationServiceWithTask.translateProduct(
      changedFields,
      [targetLocale],
      contentConfig.contentType,
      translateInstructions,
    );
    const translatedValue = translations[targetLocale]?.[fieldType] || "";
    if (!translatedValue || !translatedValue.trim()) {
      throw new Error(`AI returned empty translation for field "${fieldType}"`);
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
      },
    });

    return json({ actionType: "translateField", success: true, translatedValue, fieldType, targetLocale });
  } catch (error: unknown) {
    const errorMsg = getFullErrorMessage(error);
    try {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
    } catch (updateErr) {
      console.error("Failed to update task status:", updateErr);
    }
    return json({ actionType: "translateField", success: false, error: errorMsg, fieldType }, { status: 500 });
  }
}

// ============================================================================
// TRANSLATE ALL (to ALL enabled locales)
// ============================================================================

export async function handleTranslateAll(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { admin, session, contentConfig, db, aiInstructions, itemId, shopifyContentService, provider, serviceConfig, seoTitleMaxChars, seoLimits, translationMode } = ctx;

  const targetLocalesStr = getFormString(formData, "targetLocales");
  const contextTitle = getFormString(formData, "title");
  const sourceLocale = getFormString(formData, "sourceLocale") || "en";
  if (!isValidLocale(sourceLocale)) {
    return json({ success: false, error: "Invalid source locale format" }, { status: 400 });
  }

  // Create task entry
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: getEffectiveResourceType(itemId, contentConfig.resourceType),
      resourceId: itemId,
      resourceTitle: contextTitle,
      fieldType: "all",
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const changedFields: Record<string, string> = {};

    // Collect field values - for metaobjects, extract GID-based keys from formData
    if (contentConfig.resourceType === "Metaobject") {
      for (const [key, value] of formData.entries()) {
        if (key.startsWith("gid://shopify/Metaobject/") && String(value).trim()) {
          changedFields[key] = String(value);
        }
      }
    } else {
      contentConfig.fieldDefinitions.forEach((field) => {
        const value = getFormString(formData, field.key);
        if (value) {
          changedFields[field.key] = value;
        }
      });
    }

    if (Object.keys(changedFields).length === 0) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: "No fields to translate",
        },
      });
      return json({ success: false, error: "No fields to translate" }, { status: 400 });
    }

    // Create translation service with shop and taskId for queue management
    const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    // Get translate instructions (from DB or default) + SEO length caps for
    // the fields being sent, so seo_optimized mode paraphrases oversize
    // translations instead of overflowing the SEO cap.
    const translateInstructionsAll = buildTranslateInstructions(
      getInstructionWithDefault(aiInstructions, "translateInstructions"),
      translationMode,
      Object.keys(changedFields),
      { seoTitleMaxChars, limits: seoLimits },
    );

    // Metaobjects need custom translation flow: each entry is a separate Shopify resource
    if (contentConfig.resourceType === "Metaobject") {
      const targetLocales = targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : [];
      const result = await translateMetaobjectEntries({
        admin, session, db,
        metaobjectFields: changedFields,
        targetLocales,
        translationService: translationServiceWithTask,
        customInstructions: translateInstructionsAll,
      });

      await db.task.update({
        where: { id: task.id },
        data: {
          status: result.failedLocales.length > 0 ? "completed_with_errors" : "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({
            success: true,
            locales: Object.keys(result.translations),
            failedLocales: result.failedLocales,
          }),
        },
      });

      return json({ actionType: "translateAll", success: true, translations: result.translations, failedLocales: result.failedLocales, rejectedFields: {}, skippedFields: {} });
    }

    const result = await shopifyContentService.translateAllContent({
      resourceId: itemId,
      resourceType: getEffectiveResourceType(itemId, contentConfig.resourceType),
      shop: session.shop,
      fields: changedFields,
      translationService: translationServiceWithTask,
      db,
      targetLocales: targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : undefined,
      contentType: contentConfig.contentType,
      taskId: task.id,
      customInstructions: translateInstructionsAll,
      sourceLocale,
      // Phrase each locale's translation so THAT locale's tracked keyword
      // survives, instead of translating the primary text literally.
      keywordAwareTranslation: ctx.aiSettings?.keywordAwareTranslation ?? true,
    });

    const { translations: allTranslations, failedLocales, rejectedFields, skippedFields } = result;

    await db.task.update({
      where: { id: task.id },
      data: {
        status: failedLocales.length > 0 ? "completed_with_errors" : "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({
          success: true,
          locales: Object.keys(allTranslations),
          failedLocales,
          rejectedFields,
          skippedFields,
        }),
      },
    });

    return json({ actionType: "translateAll", success: true, translations: allTranslations, failedLocales, rejectedFields, skippedFields });
  } catch (error: unknown) {
    const errorMsg = getFullErrorMessage(error);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMsg,
      },
    });
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}

// ============================================================================
// TRANSLATE ALL FOR LOCALE (to ONE specific locale)
// ============================================================================

export async function handleTranslateAllForLocale(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { admin, session, contentConfig, db, aiInstructions, itemId, shopifyContentService, provider, serviceConfig, seoTitleMaxChars, seoLimits, translationMode } = ctx;

  const targetLocale = getFormString(formData, "targetLocale");
  const contextTitle = getFormString(formData, "title");
  const sourceLocale = getFormString(formData, "sourceLocale") || "en";
  if (!targetLocale || !isValidLocale(targetLocale)) {
    return json({ success: false, error: "Invalid target locale format" }, { status: 400 });
  }
  if (!isValidLocale(sourceLocale)) {
    return json({ success: false, error: "Invalid source locale format" }, { status: 400 });
  }

  // Create task entry
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: getEffectiveResourceType(itemId, contentConfig.resourceType),
      resourceId: itemId,
      resourceTitle: contextTitle,
      targetLocale,
      fieldType: "all",
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const changedFields: Record<string, string> = {};

    // Collect field values - for metaobjects, extract GID-based keys from formData
    if (contentConfig.resourceType === "Metaobject") {
      for (const [key, value] of formData.entries()) {
        if (key.startsWith("gid://shopify/Metaobject/") && String(value).trim()) {
          changedFields[key] = String(value);
        }
      }
    } else {
      contentConfig.fieldDefinitions.forEach((field) => {
        const value = getFormString(formData, field.key);
        if (value) {
          changedFields[field.key] = value;
        }
      });
    }

    if (Object.keys(changedFields).length === 0) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: "No fields to translate",
        },
      });
      return json({ success: false, error: "No fields to translate" }, { status: 400 });
    }

    // Create translation service with shop and taskId for queue management
    const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    // Get translate instructions (from DB or default) + SEO length caps.
    const translateInstructionsForLocale = buildTranslateInstructions(
      getInstructionWithDefault(aiInstructions, "translateInstructions"),
      translationMode,
      Object.keys(changedFields),
      { seoTitleMaxChars, limits: seoLimits },
    );

    // Metaobjects need custom translation flow
    if (contentConfig.resourceType === "Metaobject") {
      const result = await translateMetaobjectEntries({
        admin, session, db,
        metaobjectFields: changedFields,
        targetLocales: [targetLocale],
        translationService: translationServiceWithTask,
        customInstructions: translateInstructionsForLocale,
      });

      const translations = result.translations[targetLocale] || {};

      await db.task.update({
        where: { id: task.id },
        data: {
          status: result.failedLocales.length > 0 ? "completed_with_errors" : "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ success: true, targetLocale, translations, failedLocales: result.failedLocales }),
        },
      });

      return json({ actionType: "translateAllForLocale", success: true, translations, targetLocale, failedLocales: result.failedLocales, rejectedFields: {}, skippedFields: {} });
    }

    // Translate to only ONE specific locale
    const result = await shopifyContentService.translateAllContent({
      resourceId: itemId,
      resourceType: getEffectiveResourceType(itemId, contentConfig.resourceType),
      shop: session.shop,
      fields: changedFields,
      translationService: translationServiceWithTask,
      db,
      targetLocales: [targetLocale],
      contentType: contentConfig.contentType,
      taskId: task.id,
      customInstructions: translateInstructionsForLocale,
      sourceLocale,
      // Phrase each locale's translation so THAT locale's tracked keyword
      // survives, instead of translating the primary text literally.
      keywordAwareTranslation: ctx.aiSettings?.keywordAwareTranslation ?? true,
    });

    const { translations: allTranslations, failedLocales, rejectedFields, skippedFields } = result;

    // Extract translations for the target locale
    const translations = allTranslations[targetLocale] || {};

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({
          success: true,
          targetLocale,
          translations,
          failedLocales,
          rejectedFields,
          skippedFields,
        }),
      },
    });

    return json({ actionType: "translateAllForLocale", success: true, translations, targetLocale, failedLocales, rejectedFields, skippedFields });
  } catch (error: unknown) {
    const errorMsg = getFullErrorMessage(error);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMsg,
      },
    });
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}

// ============================================================================
// TRANSLATE FIELD TO ALL LOCALES
// ============================================================================

export async function handleTranslateFieldToAllLocales(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { session, contentConfig, db, aiInstructions, itemId, shopifyContentService, provider, serviceConfig, seoTitleMaxChars, seoLimits, translationMode } = ctx;

  const fieldType = getFormString(formData, "fieldType");
  const sourceText = getFormString(formData, "sourceText");
  const targetLocalesStr = getFormString(formData, "targetLocales");
  const contextTitle = getFormString(formData, "contextTitle");
  const sourceLocale = getFormString(formData, "sourceLocale") || "en";
  if (!isValidLocale(sourceLocale)) {
    return json({ success: false, error: "Invalid source locale format" }, { status: 400 });
  }

  logger.debug('[UnifiedContent] translateFieldToAllLocales', { fieldType, targetLocales: targetLocalesStr });

  // Create task entry
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: getEffectiveResourceType(itemId, contentConfig.resourceType),
      resourceId: itemId,
      resourceTitle: contextTitle,
      fieldType,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const changedFields: Record<string, string> = {};
    changedFields[fieldType] = sourceText;

    if (!sourceText) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: "No source text to translate",
        },
      });
      return json({ success: false, error: "No source text to translate" }, { status: 400 });
    }

    // Create translation service with shop and taskId for queue management
    const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    // Get translate instructions (from DB or default) + SEO length cap for
    // this specific field (only one field is being translated here).
    const translateInstructionsFieldToAll = buildTranslateInstructions(
      getInstructionWithDefault(aiInstructions, "translateInstructions"),
      translationMode,
      [fieldType],
      { seoTitleMaxChars, limits: seoLimits },
    );

    const result = await shopifyContentService.translateAllContent({
      resourceId: itemId,
      resourceType: getEffectiveResourceType(itemId, contentConfig.resourceType),
      shop: session.shop,
      fields: changedFields,
      translationService: translationServiceWithTask,
      db,
      targetLocales: targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : undefined,
      contentType: contentConfig.contentType,
      taskId: task.id,
      customInstructions: translateInstructionsFieldToAll,
      sourceLocale,
      // Phrase each locale's translation so THAT locale's tracked keyword
      // survives, instead of translating the primary text literally.
      keywordAwareTranslation: ctx.aiSettings?.keywordAwareTranslation ?? true,
    });

    const { translations: allTranslations, failedLocales, rejectedFields, skippedFields } = result;

    // Extract just the field value for each locale (frontend expects Record<locale, string>)
    // allTranslations is Record<locale, Record<fieldType, string>>
    // We need to flatten it to Record<locale, string>
    const flattenedTranslations: Record<string, string> = {};
    for (const [locale, fields] of Object.entries(allTranslations)) {
      flattenedTranslations[locale] = (fields as Record<string, string>)[fieldType] || "";
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ translations: flattenedTranslations, fieldType, failedLocales, rejectedFields, skippedFields }),
      },
    });

    return json({ actionType: "translateFieldToAllLocales", success: true, translations: flattenedTranslations, fieldType, failedLocales, rejectedFields, skippedFields });
  } catch (error: unknown) {
    const errorMsg = getFullErrorMessage(error);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMsg,
      },
    });
    return json({ actionType: "translateFieldToAllLocales", success: false, error: errorMsg, fieldType }, { status: 500 });
  }
}
