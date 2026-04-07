/**
 * Translation Action Handlers
 *
 * Extracted from unified-content.actions.ts
 * Handles: translateField, translateAll, translateAllForLocale, translateFieldToAllLocales
 */

import { json } from "@remix-run/node";
import { TranslationService } from "../../../src/services/translation.service";
import { getFormString } from "../../utils/form-data.utils";
import { isValidLocale, safeJsonParse } from "../../utils/validation";
import { getFullErrorMessage } from "../../utils/error-handler";
import { getInstructionWithDefault } from "~/utils/ai-instructions.utils";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "../../utils/logger.server";
import { findMetaobjectLabelField } from "../../constants/shopifyFields";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { Session } from "@shopify/shopify-api";
import type { PrismaClient } from "@prisma/client";
import type { ContentActionHandlerContext } from "./alt-text.action";

// ============================================================================
// METAOBJECT TRANSLATION HELPER (local copy)
// ============================================================================

async function translateMetaobjectEntries(params: {
  admin: AdminApiContext;
  session: Session;
  db: PrismaClient;
  itemId: string;
  metaobjectFields: Record<string, string>;
  targetLocales: string[];
  translationService: TranslationService;
  customInstructions?: string;
}): Promise<{ translations: Record<string, Record<string, string>>; failedLocales: string[] }> {
  const { admin, session, db, itemId, metaobjectFields, targetLocales, translationService, customInstructions } = params;
  const { TRANSLATE_CONTENT } = await import("../../graphql/content.mutations");
  const { GET_TRANSLATABLE_CONTENT } = await import("../../graphql/content.queries");

  // Build short-key mapping for cleaner AI prompts
  const gids = Object.keys(metaobjectFields);
  const gidToShort: Record<string, string> = {};
  const shortToGid: Record<string, string> = {};
  const shortFields: Record<string, string> = {};

  gids.forEach((gid, i) => {
    const short = `entry_${i}`;
    gidToShort[gid] = short;
    shortToGid[short] = gid;
    shortFields[short] = metaobjectFields[gid];
  });

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
      const gid = shortToGid[shortKey];
      if (gid && value) {
        allTranslations[locale][gid] = String(value);
      }
    }
  }

  // Save translations to Shopify + DB for each metaobject × locale
  for (const [locale, fieldMap] of Object.entries(allTranslations)) {
    for (const [gid, translatedValue] of Object.entries(fieldMap)) {
      try {
        // Find label field key for this metaobject
        const moResponse = await admin.graphql(
          `#graphql
            query getMetaobject($id: ID!) {
              metaobject(id: $id) { fields { key type } }
            }`,
          { variables: { id: gid } }
        );
        const moData = await moResponse.json();
        const fields = moData.data?.metaobject?.fields || [];
        const labelField = findMetaobjectLabelField(fields);
        if (!labelField) continue;

        // Fetch digest
        const digestResponse = await admin.graphql(GET_TRANSLATABLE_CONTENT, {
          variables: { resourceId: gid },
        });
        const digestData = await digestResponse.json();
        const tc = digestData.data?.translatableResource?.translatableContent || [];
        const digestEntry = tc.find((c: any) => c.key === labelField.key);
        if (!digestEntry?.digest) continue;

        // Register translation
        await admin.graphql(TRANSLATE_CONTENT, {
          variables: {
            resourceId: gid,
            translations: [{
              key: labelField.key,
              value: translatedValue,
              locale,
              translatableContentDigest: digestEntry.digest,
            }],
          },
        });

        // Upsert DB
        await db.metaobjectTranslation.upsert({
          where: {
            shop_metaobjectId_key_locale: {
              shop: session.shop,
              metaobjectId: gid,
              key: labelField.key,
              locale,
            },
          },
          create: {
            shop: session.shop,
            metaobjectId: gid,
            type: itemId,
            key: labelField.key,
            value: translatedValue,
            locale,
            outdated: false,
          },
          update: {
            value: translatedValue,
            outdated: false,
            updatedAt: new Date(),
          },
        });
      } catch (err: any) {
        logger.error("[translateMetaobjectEntries] Error saving translation", {
          context: "Metaobjects",
          gid,
          locale,
          error: err.message,
        });
      }
    }
  }

  return { translations: allTranslations, failedLocales };
}

// ============================================================================
// TRANSLATE FIELD
// ============================================================================

export async function handleTranslateField(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<Response> {
  const { session, contentConfig, db, aiInstructions, itemId, provider, serviceConfig } = ctx;

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
      resourceType: contentConfig.resourceType,
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

    // Get translate instructions (from DB or default)
    const translateInstructions = getInstructionWithDefault(aiInstructions, "translateInstructions");

    const translations = await translationServiceWithTask.translateProduct(
      changedFields,
      [targetLocale],
      contentConfig.contentType,
      translateInstructions || undefined
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
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}

// ============================================================================
// TRANSLATE ALL (to ALL enabled locales)
// ============================================================================

export async function handleTranslateAll(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<Response> {
  const { admin, session, contentConfig, db, aiInstructions, itemId, shopifyContentService, provider, serviceConfig } = ctx;

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
      resourceType: contentConfig.resourceType,
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

    // Get translate instructions (from DB or default)
    const translateInstructionsAll = getInstructionWithDefault(aiInstructions, "translateInstructions");

    // Metaobjects need custom translation flow: each entry is a separate Shopify resource
    if (contentConfig.resourceType === "Metaobject") {
      const targetLocales = targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : [];
      const result = await translateMetaobjectEntries({
        admin, session, db, itemId,
        metaobjectFields: changedFields,
        targetLocales,
        translationService: translationServiceWithTask,
        customInstructions: translateInstructionsAll || undefined,
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
      resourceType: contentConfig.resourceType,
      shop: session.shop,
      fields: changedFields,
      translationService: translationServiceWithTask,
      db,
      targetLocales: targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : undefined,
      contentType: contentConfig.contentType,
      taskId: task.id,
      customInstructions: translateInstructionsAll || undefined,
      sourceLocale,
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
): Promise<Response> {
  const { admin, session, contentConfig, db, aiInstructions, itemId, shopifyContentService, provider, serviceConfig } = ctx;

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
      resourceType: contentConfig.resourceType,
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

    // Get translate instructions (from DB or default)
    const translateInstructionsForLocale = getInstructionWithDefault(aiInstructions, "translateInstructions");

    // Metaobjects need custom translation flow
    if (contentConfig.resourceType === "Metaobject") {
      const result = await translateMetaobjectEntries({
        admin, session, db, itemId,
        metaobjectFields: changedFields,
        targetLocales: [targetLocale],
        translationService: translationServiceWithTask,
        customInstructions: translateInstructionsForLocale || undefined,
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
      resourceType: contentConfig.resourceType,
      shop: session.shop,
      fields: changedFields,
      translationService: translationServiceWithTask,
      db,
      targetLocales: [targetLocale],
      contentType: contentConfig.contentType,
      taskId: task.id,
      customInstructions: translateInstructionsForLocale || undefined,
      sourceLocale,
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
): Promise<Response> {
  const { session, contentConfig, db, aiInstructions, itemId, shopifyContentService, provider, serviceConfig } = ctx;

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
      resourceType: contentConfig.resourceType,
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

    // Get translate instructions (from DB or default)
    const translateInstructionsFieldToAll = getInstructionWithDefault(aiInstructions, "translateInstructions");

    const result = await shopifyContentService.translateAllContent({
      resourceId: itemId,
      resourceType: contentConfig.resourceType,
      shop: session.shop,
      fields: changedFields,
      translationService: translationServiceWithTask,
      db,
      targetLocales: targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : undefined,
      contentType: contentConfig.contentType,
      taskId: task.id,
      customInstructions: translateInstructionsFieldToAll || undefined,
      sourceLocale,
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
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}
