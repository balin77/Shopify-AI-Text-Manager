/**
 * Theme Templates Management - View and manage theme translatable content
 *
 * Uses the UnifiedContentEditor system for code reuse and consistency.
 * Templates have dynamic fields loaded from translatableContent.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { createContentLoader } from "~/utils/loader-factory.server";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { TEMPLATES_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { AIService, type AIProvider, toValidProvider } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { decryptApiKey } from "../utils/encryption.server";
import { getTaskExpirationDate, ENABLE_THEME_PRIMARY_EDIT } from "~/config/constants";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { safeJsonParse } from "~/utils/validation";
import type { FetcherData } from "~/types/content-editor.types";
import { logger } from "~/utils/logger.server";
import { extractReadableName } from "~/utils/templates-field-factory";
import { TRANSLATE_CONTENT, REMOVE_TRANSLATIONS, UPSERT_THEME_FILES } from "../graphql/content.mutations";
import { GET_THEMES, GET_THEME_FILES, GET_SHOP_LOCALES } from "../graphql/content.queries";

/** Shape of individual items within ThemeContent.translatableContent JSON array */
interface TranslatableField {
  key: string;
  value?: string;
  digest?: string;
}

/** Shape of a cached theme translation record */
interface ThemeTranslationRecord {
  key: string;
  value: string;
  locale?: string;
}

/** Shape of a theme navigation item returned by the loader */
interface ThemeNavItem {
  id: string;
  title: string;
  groupName: string;
  icon: string;
  groupId: string;
  role: string;
  contentCount: number;
  translatableContent: TranslatableField[];
  translations: ThemeTranslationRecord[];
}

// ============================================================================
// UTILITIES - Key-to-filename mapping and JSON value replacement
// ============================================================================

/**
 * Maps a Shopify translation key to a theme filename.
 * Returns null for keys that can't be mapped (group.json, bar, settings, etc.)
 */
function keyToFilename(key: string): string | null {
  // section.page.{name}.json.* → templates/page.{name}.json (name can contain dots)
  const pageMatch = key.match(/^section\.(page\..+?)\.json\./);
  if (pageMatch) return `templates/${pageMatch[1]}.json`;

  // section.{name}.json.* → templates/{name}.json (name can contain dots, e.g. "product.stoffwaren-anna")
  const sectionMatch = key.match(/^section\.(.+?)\.json\./);
  if (sectionMatch) return `templates/${sectionMatch[1]}.json`;

  // collections.json.* → templates/list-collections.json (Shopify's default name)
  if (key.startsWith("collections.json.")) return "templates/list-collections.json";

  // Unknown patterns — skip Shopify push
  return null;
}

/**
 * Recursively replaces string values in a JSON object.
 * Uses old→new value mapping with key hints for disambiguation.
 *
 * @returns Set of translation keys that were successfully replaced
 */
function replaceValuesInJson(
  obj: unknown,
  replacements: Map<string, { oldValue: string; newValue: string; keyHint: string }>,
  currentPath: string[] = [],
): Set<string> {
  const replaced = new Set<string>();

  if (obj === null || obj === undefined || typeof obj !== "object") {
    return replaced;
  }

  // Build a reverse lookup: oldValue → [{ translationKey, newValue, keyHint }]
  const oldValueLookup = new Map<string, Array<{ translationKey: string; newValue: string; keyHint: string }>>();
  for (const [translationKey, { oldValue, newValue, keyHint }] of replacements) {
    if (replaced.has(translationKey)) continue; // Already found
    if (!oldValue) continue; // Skip empty old values
    const existing = oldValueLookup.get(oldValue) || [];
    existing.push({ translationKey, newValue, keyHint });
    oldValueLookup.set(oldValue, existing);
  }

  const record = obj as Record<string, unknown>;
  for (const jsonKey of Object.keys(record)) {
    const value = record[jsonKey];

    if (typeof value === "string" && oldValueLookup.has(value)) {
      const candidates = oldValueLookup.get(value)!;

      // Try to find a match using key hint (last segment of translation key = JSON property name)
      let matched = candidates.find((c) => c.keyHint === jsonKey);

      // If no hint match and only one candidate, use it
      if (!matched && candidates.length === 1) {
        matched = candidates[0];
      }

      if (matched) {
        record[jsonKey] = matched.newValue;
        replaced.add(matched.translationKey);
        // Remove from lookup so it's not matched again
        const remaining = candidates.filter((c) => c.translationKey !== matched!.translationKey);
        if (remaining.length === 0) {
          oldValueLookup.delete(value);
        } else {
          oldValueLookup.set(value, remaining);
        }
      }
    } else if (typeof value === "object" && value !== null) {
      const childReplaced = replaceValuesInJson(value, replacements, [...currentPath, jsonKey]);
      for (const key of childReplaced) {
        replaced.add(key);
      }
    }
  }

  return replaced;
}

// ============================================================================
// LOADER - Load navigation metadata (groups list)
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "TEMPLATES",
  resourceType: null, // Templates use their own ThemeTranslation table
  itemsKey: "themes",

  async loadData(ctx) {
    // LAZY LOADING: Only load navigation metadata, not the full content
    const allGroupRows = await ctx.db.themeContent.findMany({
      where: { shop: ctx.session.shop },
      select: {
        groupId: true,
        groupName: true,
        groupIcon: true,
        translatableContent: true,
      },
    });

    // Aggregate by groupId, counting unique translatable field keys (deduplicated)
    const groupMap = new Map<string, { groupName: string; groupIcon: string; uniqueKeys: Set<string> }>();
    for (const row of allGroupRows) {
      const existing = groupMap.get(row.groupId);
      const items = Array.isArray(row.translatableContent) ? (row.translatableContent as TranslatableField[]) : [];
      if (existing) {
        for (const item of items) {
          if (item.key) existing.uniqueKeys.add(item.key);
        }
      } else {
        const keys = new Set<string>();
        for (const item of items) {
          if (item.key) keys.add(item.key);
        }
        groupMap.set(row.groupId, {
          groupName: row.groupName,
          groupIcon: row.groupIcon,
          uniqueKeys: keys,
        });
      }
    }

    // Create lightweight navigation items (sorted alphabetically)
    const themes = Array.from(groupMap.entries())
      .map(([groupId, group]) => ({
        id: `group_${groupId}`,
        title: group.groupName,
        groupName: group.groupName,
        icon: group.groupIcon,
        groupId: groupId,
        role: "THEME_GROUP",
        contentCount: group.uniqueKeys.size,
        translatableContent: [] as TranslatableField[],
        translations: [] as ThemeTranslationRecord[],
      }))
      .sort((a, b) => a.title.localeCompare(b.title));

    return { items: themes, ids: [] };
  },
});

// ============================================================================
// ACTION - Handle content updates
// ============================================================================

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = getFormString(formData, "action");
  const itemId = getFormString(formData, "itemId");

  // Extract groupId from itemId (format: group_xxx)
  const groupId = itemId?.replace("group_", "");

  if (!groupId) {
    return json({ success: false, error: "groupId is required" }, { status: 400 });
  }

  const { db } = await import("../db.server");

  // Load group data
  const themeGroups = await db.themeContent.findMany({
    where: {
      shop: session.shop,
      groupId: groupId
    }
  });

  if (themeGroups.length === 0) {
    return json({ success: false, error: "Group not found" }, { status: 404 });
  }

  const firstGroup = themeGroups[0];
  const resourceId = firstGroup.resourceId;

  // Build key → resourceId map: each field key belongs to a specific Shopify resource
  // (a template group can span multiple resources, e.g. JSON template + metaobjects)
  const keyToResourceId = new Map<string, string>();
  for (const group of themeGroups) {
    const items = (group.translatableContent as unknown) as TranslatableField[];
    if (Array.isArray(items)) {
      for (const item of items) {
        keyToResourceId.set(item.key, group.resourceId);
      }
    }
  }

  try {
    switch (actionType) {
      case "loadTranslations": {
        const locale = getFormString(formData, "locale");

        const translations = await db.themeTranslation.findMany({
          where: {
            shop: session.shop,
            groupId: groupId,
            locale: locale
          }
        });

        return json({
          success: true,
          translations,
          locale
        });
      }

      case "generateAIText": {
        const fieldType = getFormString(formData, "fieldType");
        const currentValue = getFormString(formData, "currentValue");
        const mainLanguage = getFormString(formData, "mainLanguage");
        const fieldLabel = extractReadableName(fieldType);

        // Create task entry
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "aiGeneration",
            status: "pending",
            resourceType: "templates",
            resourceId: `group_${groupId}`,
            resourceTitle: firstGroup.groupName,
            fieldType: fieldLabel,
            progress: 0,
            expiresAt: getTaskExpirationDate(),
          },
        });

        try {
          const settings = await db.aISettings.findUnique({
            where: { shop: session.shop }
          });

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
            },
            session.shop,
            task.id
          );

          const prompt = `Improve the following template field content.

Field: ${fieldType}
Current value: ${currentValue}
Context: ${firstGroup.groupName}
Language: ${mainLanguage}

IMPORTANT: Return ONLY the improved text, nothing else. No explanations, no options, no formatting, no labels. Just output the single best improved version of the content in ${mainLanguage}.`;

          const generatedContent = await aiService['askAI'](prompt);

          // Update task to completed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: generatedContent.substring(0, 1000),
            },
          });

          return json({
            success: true,
            generatedContent,
            fieldType
          });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          // Update task to failed
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

      case "translateField": {
        const fieldType = getFormString(formData, "fieldType");
        const sourceText = getFormString(formData, "sourceText");
        const targetLocale = getFormString(formData, "targetLocale");
        const primaryLocaleFromForm = getFormString(formData, "primaryLocale");
        const translateFieldLabel = extractReadableName(fieldType);

        if (!sourceText) {
          return json({
            success: false,
            error: "No source text available"
          }, { status: 400 });
        }

        // Create task entry
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "translation",
            status: "pending",
            resourceType: "templates",
            resourceId: `group_${groupId}`,
            resourceTitle: firstGroup.groupName,
            fieldType: translateFieldLabel,
            targetLocale,
            progress: 0,
            expiresAt: getTaskExpirationDate(),
          },
        });

        try {
          const settings = await db.aISettings.findUnique({
            where: { shop: session.shop }
          });

          // Update task to running
          await db.task.update({
            where: { id: task.id },
            data: { status: "running", progress: 20 },
          });

          const primaryLocale = primaryLocaleFromForm || "en";

          const aiService = new AIService(
            toValidProvider(settings?.preferredProvider),
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

          const translatedValue = await aiService.translateContent(
            sourceText,
            primaryLocale,
            targetLocale
          );

          // Auto-save the translation (use correct resourceId for this field)
          const fieldResId = keyToResourceId.get(fieldType) || resourceId;
          await db.themeTranslation.upsert({
            where: {
              shop_resourceId_groupId_key_locale: {
                shop: session.shop,
                resourceId: fieldResId,
                groupId: groupId,
                key: fieldType,
                locale: targetLocale
              }
            },
            update: {
              value: translatedValue,
              updatedAt: new Date()
            },
            create: {
              shop: session.shop,
              groupId: groupId,
              resourceId: fieldResId,
              locale: targetLocale,
              key: fieldType,
              value: translatedValue
            }
          });

          // Update task to completed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: translatedValue.substring(0, 1000),
            },
          });

          return json({
            success: true,
            translatedValue,
            fieldType,
            targetLocale
          });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          // Update task to failed
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

      case "translateFieldToAllLocales": {
        const fieldType = getFormString(formData, "fieldType");
        const sourceText = getFormString(formData, "sourceText");
        const targetLocalesJson = getFormString(formData, "targetLocales");
        const primaryLocaleFromForm = getFormString(formData, "primaryLocale");
        const translateAllFieldLabel = extractReadableName(fieldType);

        if (!sourceText) {
          return json({
            success: false,
            error: "No source text available"
          }, { status: 400 });
        }

        const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, []) : [];
        if (targetLocales.length === 0) {
          return json({
            success: false,
            error: "No target locales specified"
          }, { status: 400 });
        }

        // Create task entry
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "bulkTranslation",
            status: "pending",
            resourceType: "templates",
            resourceId: `group_${groupId}`,
            resourceTitle: firstGroup.groupName,
            fieldType: translateAllFieldLabel,
            progress: 0,
            expiresAt: getTaskExpirationDate(),
          },
        });

        try {
          const settings = await db.aISettings.findUnique({
            where: { shop: session.shop }
          });

          // Update task to running
          await db.task.update({
            where: { id: task.id },
            data: { status: "running", progress: 10 },
          });

          const primaryLocale = primaryLocaleFromForm || "en";

          const aiService = new AIService(
            toValidProvider(settings?.preferredProvider),
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

          // Translate the field to all target locales
          const translations: Record<string, string> = {};
          const totalLocales = targetLocales.length;
          const pendingUpserts: Array<{ locale: string; value: string }> = [];

          for (let i = 0; i < targetLocales.length; i++) {
            const locale = targetLocales[i];
            try {
              const translatedValue = await aiService.translateContent(
                sourceText,
                primaryLocale,
                locale
              );
              translations[locale] = translatedValue;
              pendingUpserts.push({ locale, value: translatedValue });

              // Update progress
              const progress = Math.round(10 + ((i + 1) / totalLocales) * 80);
              await db.task.update({
                where: { id: task.id },
                data: { progress },
              });
            } catch (error: unknown) {
              logger.error("Error translating field to locale", { context: "Templates", fieldType, locale, error: error instanceof Error ? error.message : String(error) });
              translations[locale] = sourceText; // Fallback to original
            }
          }

          // Batch save all translations in a single transaction (use correct resourceId for the field)
          const fieldResId2 = keyToResourceId.get(fieldType) || resourceId;
          if (pendingUpserts.length > 0) {
            await db.$transaction(
              pendingUpserts.map(({ locale, value }) =>
                db.themeTranslation.upsert({
                  where: {
                    shop_resourceId_groupId_key_locale: {
                      shop: session.shop,
                      resourceId: fieldResId2,
                      groupId: groupId,
                      key: fieldType,
                      locale: locale
                    }
                  },
                  update: {
                    value: value,
                    updatedAt: new Date()
                  },
                  create: {
                    shop: session.shop,
                    groupId: groupId,
                    resourceId: fieldResId2,
                    locale: locale,
                    key: fieldType,
                    value: value
                  }
                })
              )
            );
          }

          // Update task to completed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: `Translated to ${Object.keys(translations).length} locales`,
            },
          });

          return json({
            success: true,
            translations,
            fieldType
          });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          // Update task to failed
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

      case "translateAll":
      case "translateAllForLocale": {
        const targetLocalesJson = getFormString(formData, "targetLocales");
        const targetLocale = getFormString(formData, "targetLocale");
        const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, [targetLocale]) : [targetLocale];

        // Get all translatable content
        const allContent = themeGroups.flatMap((group) => (group.translatableContent as unknown) as TranslatableField[]);

        // Deduplicate
        const uniqueContent = new Map<string, TranslatableField>();
        for (const item of allContent) {
          if (!uniqueContent.has(item.key) && item.value) {
            uniqueContent.set(item.key, item);
          }
        }

        // Create task entry
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "bulkTranslation",
            status: "pending",
            resourceType: "templates",
            resourceId: `group_${groupId}`,
            resourceTitle: firstGroup.groupName,
            progress: 0,
            expiresAt: getTaskExpirationDate(),
          },
        });

        try {
          const settings = await db.aISettings.findUnique({
            where: { shop: session.shop }
          });

          // Update task to running
          await db.task.update({
            where: { id: task.id },
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
            },
            session.shop,
            task.id
          );

          const primaryLocale = getFormString(formData, "primaryLocale") || "en";

          // Translate to all target locales
          const translations: Record<string, Record<string, string>> = {};
          const totalItems = targetLocales.length * uniqueContent.size;
          let completedItems = 0;
          const pendingUpserts: Array<{ key: string; locale: string; value: string; resId: string }> = [];

          for (const locale of targetLocales) {
            translations[locale] = {};

            for (const [key, item] of uniqueContent.entries()) {
              try {
                const translated = await aiService.translateContent(
                  item.value || "",
                  primaryLocale,
                  locale
                );
                translations[locale][key] = translated;
                const fieldResId = keyToResourceId.get(key) || resourceId;
                pendingUpserts.push({ key, locale, value: translated, resId: fieldResId });

                // Update progress
                completedItems++;
                const progress = Math.round(5 + (completedItems / totalItems) * 90);
                await db.task.update({
                  where: { id: task.id },
                  data: { progress },
                });
              } catch (error: unknown) {
                logger.error("Error translating field", { context: "Templates", key, locale, error: error instanceof Error ? error.message : String(error) });
                translations[locale][key] = item.value || "";
              }
            }
          }

          // Batch save all translations in a single transaction
          if (pendingUpserts.length > 0) {
            await db.$transaction(
              pendingUpserts.map(({ key, locale, value, resId }) =>
                db.themeTranslation.upsert({
                  where: {
                    shop_resourceId_groupId_key_locale: {
                      shop: session.shop,
                      resourceId: resId,
                      groupId: groupId,
                      key: key,
                      locale: locale
                    }
                  },
                  update: {
                    value: value,
                    updatedAt: new Date()
                  },
                  create: {
                    shop: session.shop,
                    groupId: groupId,
                    resourceId: resId,
                    locale: locale,
                    key: key,
                    value: value
                  }
                })
              )
            );
          }

          // Update task to completed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              result: `Translated ${uniqueContent.size} fields to ${targetLocales.length} locales`,
            },
          });

          if (actionType === "translateAllForLocale") {
            return json({
              success: true,
              actionType: "translateAllForLocale",
              translations: translations[targetLocale] || {},
              targetLocale
            });
          }

          return json({
            success: true,
            actionType: "translateAll",
            translations
          });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          // Update task to failed
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

      case "updateContent": {
        const locale = getFormString(formData, "locale");
        const primaryLocale = getFormString(formData, "primaryLocale");

        // Parse changedFields if present (for translation deletion when primary locale changes)
        const changedFields: string[] = getFormJSON<string[]>(formData, "changedFields") || [];

        // Debug: Log all form data keys
        const allFormDataKeys: string[] = [];
        formData.forEach((value, key) => {
          allFormDataKeys.push(key);
        });
        logger.debug("[TEMPLATES] Update content - start", {
          context: "Templates",
          formDataKeys: allFormDataKeys,
          locale,
          primaryLocale,
          isPrimaryLocale: locale === primaryLocale,
          changedFields
        });

        // Collect all field values from form data
        const updatedFields: Record<string, string> = {};

        // Get all translatable content keys
        const allContent = themeGroups.flatMap((group) => (group.translatableContent as unknown) as TranslatableField[]);
        const uniqueKeys = new Set(allContent.map((item) => item.key));

        // Count form data field entries (exclude metadata keys)
        const metadataKeys = new Set(["action", "itemId", "locale", "primaryLocale", "changedFields", "imageAltTexts", "changedAltTextIndices", "contentType"]);
        let formFieldCount = 0;
        formData.forEach((_value, key) => {
          if (!metadataKeys.has(key)) formFieldCount++;
        });

        for (const key of uniqueKeys) {
          const value = formData.get(key);
          if (typeof value === "string") {
            updatedFields[key] = value;
          }
        }

        logger.info("[TEMPLATES] Update content - field matching", {
          context: "Templates",
          dbUniqueKeys: uniqueKeys.size,
          formFieldEntries: formFieldCount,
          matchedFields: Object.keys(updatedFields).length,
          locale,
          isPrimaryLocale: locale === primaryLocale,
        });

        if (Object.keys(updatedFields).length === 0) {
          logger.warn("[TEMPLATES] Update content - NO fields matched! Save is a no-op.", {
            context: "Templates",
            sampleDbKeys: Array.from(uniqueKeys).slice(0, 3),
            sampleFormKeys: allFormDataKeys.filter(k => !metadataKeys.has(k)).slice(0, 3),
          });
          return json({ success: true, actionType: "updateContent" }); // No changes
        }

        // ─── CRITICAL: Reject empty primary-language fields ───────────────
        // Shopify permanently removes template fields from its data when the
        // primary-locale value is saved as empty. Once removed, the field can
        // NEVER be restored — not through the API and not through the Admin UI.
        // Therefore we MUST block any save that would set a primary-locale
        // field to an empty (or whitespace-only) string.
        // DO NOT remove this check — it protects against irreversible data loss.
        // ──────────────────────────────────────────────────────────────────
        if (locale === primaryLocale) {
          const emptyKeys = Object.entries(updatedFields)
            .filter(([, value]) => value.trim() === "")
            .map(([key]) => key);

          if (emptyKeys.length > 0) {
            logger.warn("[TEMPLATES] Blocked save — empty primary-locale fields detected", {
              context: "Templates",
              locale,
              emptyKeys,
            });
            return json({
              success: false,
              errorKey: "emptyPrimaryFieldsError",
            }, { status: 400 });
          }
        }

        // STEP 1: Register translations with Shopify (only for foreign locales)
        // Shopify's translationsRegister does NOT accept the shop's primary locale
        if (locale !== primaryLocale) {
          const digestMap = new Map<string, string>();
          for (const item of allContent) {
            if (item.digest) {
              digestMap.set(item.key, item.digest);
            }
          }

          // Group translations by resource ID — each key may belong to a different resource
          const translationsByResource = new Map<string, Array<{ key: string; value: string; locale: string; translatableContentDigest: string }>>();
          const skippedKeys: string[] = [];

          for (const [key, value] of Object.entries(updatedFields)) {
            const digest = digestMap.get(key) || "";
            const fieldResId = keyToResourceId.get(key) || resourceId;

            if (!digest) {
              logger.warn("[TEMPLATES] No digest for key — skipping Shopify save", {
                context: "Templates",
                key,
                locale,
                resourceId: fieldResId
              });
              skippedKeys.push(key);
              continue;
            }

            if (!translationsByResource.has(fieldResId)) {
              translationsByResource.set(fieldResId, []);
            }
            translationsByResource.get(fieldResId)!.push({
              key,
              value,
              locale,
              translatableContentDigest: digest
            });
          }

          // Send one translationsRegister call per resource ID
          for (const [resId, translationInputs] of translationsByResource) {
            if (translationInputs.length === 0) continue;

            logger.info("[TEMPLATES] Sending translations to Shopify", {
              context: "Templates",
              resourceId: resId,
              locale,
              fieldCount: translationInputs.length,
              sampleKeys: translationInputs.slice(0, 3).map(t => t.key),
            });

            const response = await admin.graphql(TRANSLATE_CONTENT, {
              variables: {
                resourceId: resId,
                translations: translationInputs
              }
            });

            const data = await response.json();

            if (data.data?.translationsRegister?.userErrors?.length > 0) {
              const errors = data.data.translationsRegister.userErrors;
              logger.error("[TEMPLATES] Shopify translation errors", {
                context: "Templates",
                errors,
                resourceId: resId,
                locale
              });
              // Don't hard-fail — continue saving other resources and the local DB
              skippedKeys.push(...translationInputs.map(t => t.key));
            } else {
              logger.info("[TEMPLATES] Shopify translations registered successfully", {
                context: "Templates",
                locale,
                resourceId: resId,
                fieldCount: translationInputs.length
              });
            }
          }
        }

        // STEP 2: Update local database
        if (locale === primaryLocale) {
          // Guard: Primary locale editing requires ENABLE_THEME_PRIMARY_EDIT flag
          // This is a server-side safety net; the UI should already prevent this
          if (!ENABLE_THEME_PRIMARY_EDIT) {
            logger.warn("[TEMPLATES] Primary locale save rejected - ENABLE_THEME_PRIMARY_EDIT is false", {
              context: "Templates",
              locale,
              fieldCount: Object.keys(updatedFields).length,
            });
            return json({
              success: false,
              error: "Primary locale editing for templates requires write_themes scope (not yet enabled)"
            }, { status: 403 });
          }

          // STEP 2a: Push primary locale changes to Shopify via themeFilesUpsert
          {
            // Build old-value map from translatableContent for changed keys only
            const oldValueMap = new Map<string, string>();
            for (const group of themeGroups) {
              const content = (group.translatableContent as unknown) as TranslatableField[];
              for (const item of content) {
                if (updatedFields[item.key] !== undefined && item.value !== undefined) {
                  oldValueMap.set(item.key, item.value);
                }
              }
            }

            // Group changed keys by filename
            const keysByFilename = new Map<string, string[]>();
            const unmappedKeys: string[] = [];
            for (const key of Object.keys(updatedFields)) {
              // Only process keys whose value actually changed
              if (oldValueMap.get(key) === updatedFields[key]) continue;

              const filename = keyToFilename(key);
              if (filename) {
                const existing = keysByFilename.get(filename) || [];
                existing.push(key);
                keysByFilename.set(filename, existing);
              } else {
                unmappedKeys.push(key);
              }
            }

            if (unmappedKeys.length > 0) {
              logger.warn("[TEMPLATES] Keys could not be mapped to filenames — skipping Shopify push", {
                context: "Templates",
                unmappedKeys,
              });
            }

            if (keysByFilename.size > 0) {
              // Get active theme ID
              const themesResponse = await admin.graphql(GET_THEMES, { variables: { first: 10 } });
              const themesData = await themesResponse.json();
              const mainTheme = themesData.data?.themes?.edges?.find(
                (edge: { node: { role: string } }) => edge.node.role === "MAIN"
              );

              if (!mainTheme) {
                logger.error("[TEMPLATES] No MAIN theme found — cannot push primary locale changes", {
                  context: "Templates",
                });
                return json({
                  success: false,
                  error: "No active (MAIN) theme found. Cannot save primary locale changes to Shopify."
                }, { status: 500 });
              }

              const themeId = mainTheme.node.id;
              const filenames = Array.from(keysByFilename.keys());

              logger.info("[TEMPLATES] Reading theme files from Shopify", {
                context: "Templates",
                themeId,
                filenames,
              });

              // Read current files from Shopify
              const filesResponse = await admin.graphql(GET_THEME_FILES, {
                variables: { themeId, filenames }
              });
              const filesData = await filesResponse.json();

              logger.debug("[TEMPLATES] Raw theme files response", {
                context: "Templates",
                hasTheme: !!filesData.data?.theme,
                hasFiles: !!filesData.data?.theme?.files,
                nodeCount: filesData.data?.theme?.files?.nodes?.length ?? 0,
                errors: (filesData as any).errors,
              });

              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Shopify response shape varies
              const fileNodes: any[] = filesData.data?.theme?.files?.nodes || [];

              // Process each file: find old values and replace with new values
              const filesToUpsert: Array<{ filename: string; body: { type: string; value: string } }> = [];
              const shopifyErrors: string[] = [];

              for (const [filename, keys] of keysByFilename) {
                const fileNode = fileNodes.find((n: any) => n.filename === filename);

                // Debug: log the full body structure to understand Shopify's response format
                logger.debug("[TEMPLATES] Theme file node details", {
                  context: "Templates",
                  filename,
                  found: !!fileNode,
                  bodyKeys: fileNode?.body ? Object.keys(fileNode.body) : null,
                  bodyType: typeof fileNode?.body,
                  contentPreview: typeof fileNode?.body?.content === "string"
                    ? fileNode.body.content.substring(0, 300)
                    : `(type: ${typeof fileNode?.body?.content})`,
                });

                // Try to extract content from the body — handle different shapes
                const rawContent = fileNode?.body?.content ?? fileNode?.body;
                if (!rawContent || typeof rawContent !== "string") {
                  logger.warn("[TEMPLATES] Theme file not found or no text content", {
                    context: "Templates",
                    filename,
                    keys,
                    rawContentType: typeof rawContent,
                  });
                  shopifyErrors.push(`File not found or not a text file: ${filename}`);
                  continue;
                }

                // Shopify theme files can have leading /* ... */ comments — strip them before parsing
                const leadingCommentRegex = /^\s*\/\*[\s\S]*?\*\/\s*/;
                const hasLeadingComment = leadingCommentRegex.test(rawContent);
                const jsonContent = hasLeadingComment ? rawContent.replace(leadingCommentRegex, "") : rawContent;

                let fileJson: unknown;
                try {
                  fileJson = JSON.parse(jsonContent);
                } catch {
                  logger.error("[TEMPLATES] Failed to parse theme file JSON", {
                    context: "Templates",
                    filename,
                    contentPreview: rawContent.substring(0, 500),
                  });
                  shopifyErrors.push(`Invalid JSON in file: ${filename}`);
                  continue;
                }

                // Build replacements map for this file
                const replacements = new Map<string, { oldValue: string; newValue: string; keyHint: string }>();
                for (const key of keys) {
                  const oldValue = oldValueMap.get(key) || "";
                  const newValue = updatedFields[key];
                  // Last segment of the key (after last dot) as hint for JSON property name
                  const keyParts = key.split(".");
                  const keyHint = keyParts[keyParts.length - 1];
                  replacements.set(key, { oldValue, newValue, keyHint });
                }

                const replacedKeys = replaceValuesInJson(fileJson, replacements);

                logger.info("[TEMPLATES] Value replacement results", {
                  context: "Templates",
                  filename,
                  totalKeys: keys.length,
                  replacedCount: replacedKeys.size,
                  replacedKeys: Array.from(replacedKeys),
                  missedKeys: keys.filter((k) => !replacedKeys.has(k)),
                });

                // Even if some keys weren't found, still upsert the file with what we could replace
                if (replacedKeys.size > 0) {
                  filesToUpsert.push({
                    filename,
                    body: {
                      type: "TEXT",
                      // Preserve the leading comment if the original file had one
                      value: hasLeadingComment
                        ? rawContent.match(leadingCommentRegex)![0] + JSON.stringify(fileJson, null, 2)
                        : JSON.stringify(fileJson, null, 2),
                    },
                  });
                }
              }

              // Call themeFilesUpsert for all modified files
              if (filesToUpsert.length > 0) {
                logger.info("[TEMPLATES] Pushing changes to Shopify via themeFilesUpsert", {
                  context: "Templates",
                  themeId,
                  fileCount: filesToUpsert.length,
                  filenames: filesToUpsert.map((f) => f.filename),
                });

                try {
                  const upsertResponse = await admin.graphql(UPSERT_THEME_FILES, {
                    variables: { themeId, files: filesToUpsert }
                  });
                  const upsertData = await upsertResponse.json();

                  if (upsertData.data?.themeFilesUpsert?.userErrors?.length > 0) {
                    const errors = upsertData.data.themeFilesUpsert.userErrors;
                    logger.error("[TEMPLATES] themeFilesUpsert returned errors", {
                      context: "Templates",
                      errors,
                    });
                    shopifyErrors.push(...errors.map((e: { message: string }) => e.message));
                  } else {
                    logger.info("[TEMPLATES] themeFilesUpsert succeeded", {
                      context: "Templates",
                      upsertedFiles: upsertData.data?.themeFilesUpsert?.upsertedThemeFiles?.map(
                        (f: { filename: string }) => f.filename
                      ),
                    });
                  }
                } catch (upsertError) {
                  const msg = upsertError instanceof Error ? upsertError.message : String(upsertError);
                  logger.error("[TEMPLATES] themeFilesUpsert failed", {
                    context: "Templates",
                    error: msg,
                  });
                  // Check for permission/scope errors
                  if (msg.includes("access") || msg.includes("scope") || msg.includes("permission")) {
                    return json({
                      success: false,
                      error: `Shopify rejected the theme update. You may need the Protected Scope Exemption for write_themes. Error: ${msg}`
                    }, { status: 403 });
                  }
                  shopifyErrors.push(msg);
                }
              }

              // If there were Shopify errors, return them but still continue with local DB update
              if (shopifyErrors.length > 0) {
                logger.warn("[TEMPLATES] Some Shopify errors occurred during primary locale save", {
                  context: "Templates",
                  errors: shopifyErrors,
                });
                // Don't hard-fail — continue with local DB update below
              }
            }
          }

          // STEP 2b: Update primary locale in local DB (translatableContent in ThemeContent)
          for (const group of themeGroups) {
            const content = (group.translatableContent as unknown) as TranslatableField[];
            let hasChanges = false;

            for (const item of content) {
              if (updatedFields[item.key] !== undefined) {
                item.value = updatedFields[item.key];
                hasChanges = true;
              }
            }

            if (hasChanges) {
              await db.themeContent.update({
                where: {
                  shop_resourceId_groupId: {
                    shop: session.shop,
                    resourceId: group.resourceId,
                    groupId: groupId
                  }
                },
                data: {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON column
                  translatableContent: content as any,
                  lastSyncedAt: new Date()
                }
              });
            }
          }

          // Delete translations for changed fields (they are now outdated)
          if (changedFields.length > 0) {
            logger.debug("[TEMPLATES] Deleting translations for changed fields", {
              context: "Templates",
              keysToDelete: changedFields,
              groupId
            });

            // STEP A: Delete from Shopify via translationsRemove
            // Group changed keys by resourceId (a template group can span multiple Shopify resources)
            const changedKeysByResource = new Map<string, string[]>();
            for (const key of changedFields) {
              const resId = keyToResourceId.get(key) || resourceId;
              const existing = changedKeysByResource.get(resId) || [];
              existing.push(key);
              changedKeysByResource.set(resId, existing);
            }

            // Get all foreign locales to delete translations across all of them
            const localesResponse = await admin.graphql(GET_SHOP_LOCALES);
            const localesData = await localesResponse.json();
            const foreignLocales = (localesData.data?.shopLocales || [])
              .filter((l: { primary: boolean; published: boolean }) => !l.primary && l.published)
              .map((l: { locale: string }) => l.locale);

            if (foreignLocales.length > 0) {
              for (const [resId, keys] of changedKeysByResource) {
                try {
                  const removeResponse = await admin.graphql(REMOVE_TRANSLATIONS, {
                    variables: {
                      resourceId: resId,
                      translationKeys: keys,
                      locales: foreignLocales,
                    }
                  });
                  const removeData = await removeResponse.json();

                  if (removeData.data?.translationsRemove?.userErrors?.length > 0) {
                    logger.warn("[TEMPLATES] Shopify translationsRemove errors (non-fatal)", {
                      context: "Templates",
                      errors: removeData.data.translationsRemove.userErrors,
                      resourceId: resId,
                      keys,
                    });
                  } else {
                    logger.info("[TEMPLATES] Shopify translations removed", {
                      context: "Templates",
                      resourceId: resId,
                      keyCount: keys.length,
                      localeCount: foreignLocales.length,
                    });
                  }
                } catch (removeError) {
                  // Non-fatal: local DB deletion below will still run
                  logger.warn("[TEMPLATES] translationsRemove failed (non-fatal)", {
                    context: "Templates",
                    error: removeError instanceof Error ? removeError.message : String(removeError),
                    resourceId: resId,
                  });
                }
              }
            }

            // STEP B: Delete from local DB
            const deleteResult = await db.themeTranslation.deleteMany({
              where: {
                shop: session.shop,
                groupId: groupId,
                key: { in: changedFields }
              }
            });

            logger.debug("[TEMPLATES] Deleted translation entries", { context: "Templates", count: deleteResult.count });
          } else {
            logger.debug("[TEMPLATES] No changedFields to delete translations for", { context: "Templates" });
          }
        } else {
          // Update translations: batch upsert in a single transaction (use correct resourceId per key)
          const entries = Object.entries(updatedFields);
          if (entries.length > 0) {
            await db.$transaction(
              entries.map(([key, value]) => {
                const keyResId = keyToResourceId.get(key) || resourceId;
                return db.themeTranslation.upsert({
                  where: {
                    shop_resourceId_groupId_key_locale: {
                      shop: session.shop,
                      resourceId: keyResId,
                      groupId: groupId,
                      key: key,
                      locale: locale
                    }
                  },
                  update: {
                    value: value,
                    updatedAt: new Date()
                  },
                  create: {
                    shop: session.shop,
                    groupId: groupId,
                    resourceId: keyResId,
                    locale: locale,
                    key: key,
                    value: value
                  }
                });
              })
            );
          }
        }

        return json({ success: true, actionType: "updateContent" });
      }

      default:
        return json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error("[TEMPLATES-ACTION] Error", { context: "Templates", error: msg, stack });
    return json({ success: false, error: msg }, { status: 500 });
  }
};

// ============================================================================
// COMPONENT
// ============================================================================

export default function TemplatesPage() {
  const { themes, shop, shopLocales: loaderShopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<FetcherData>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // State for lazy-loaded theme data
  const [loadedThemes, setLoadedThemes] = useState<Record<string, { translatableContent?: TranslatableField[]; pagination?: { page: number; limit: number; totalCount: number; totalPages: number } }>>({});
  const [loadedTranslations, setLoadedTranslations] = useState<Record<string, Record<string, ThemeTranslationRecord[]>>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  // Track previous language and groupId to prevent re-loading values on every render
  const previousLanguageRef = useRef<string | null>(null);
  const previousGroupIdRef = useRef<string | null>(null);

  // Field pagination state
  const [fieldPagination, setFieldPagination] = useState<Record<string, {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
    search: string;
  }>>({});
  const DEFAULT_FIELDS_PER_PAGE = 25;

  // Ref to track loaded translations without triggering re-renders
  const loadedTranslationsRef = useRef(loadedTranslations);
  loadedTranslationsRef.current = loadedTranslations;

  // Get current theme data
  const currentThemeData = selectedGroupId ? loadedThemes[selectedGroupId] : null;

  // Transform themes to items with loaded content and translations
  const items = useMemo(() => {
    return themes.map((theme: ThemeNavItem) => {
      const loadedData = loadedThemes[theme.groupId];
      const themeTranslations = loadedTranslations[theme.groupId] || {};

      if (loadedData) {
        // Merge all translations from different locales
        const allTranslations: ThemeTranslationRecord[] = [];
        for (const [locale, translations] of Object.entries(themeTranslations)) {
          for (const translation of translations) {
            allTranslations.push({
              key: translation.key,
              value: translation.value,
              locale: locale,
            });
          }
        }

        return {
          ...theme,
          translatableContent: loadedData.translatableContent || [],
          translations: allTranslations,
        };
      }
      return theme;
    });
  }, [themes, loadedThemes, loadedTranslations]);

  // Preload all foreign language translations for a group (parallel loading)
  const preloadAllTranslations = useCallback(async (groupId: string) => {
    const foreignLocales = loaderShopLocales.filter((l): l is NonNullable<typeof l> => l != null && !l.primary);
    if (foreignLocales.length === 0) return;

    // Use ref to check already loaded locales (avoids stale closure)
    const currentLoaded = loadedTranslationsRef.current;
    const localesToLoad = foreignLocales.filter(
      (l) => !currentLoaded[groupId]?.[l.locale]
    );
    if (localesToLoad.length === 0) return;

    // Load all translations in parallel using API route
    const results = await Promise.allSettled(
      localesToLoad.map(async (locale) => {
        const formData = new FormData();
        formData.append("action", "loadTranslations");
        formData.append("locale", locale.locale);

        const response = await fetch(`/api/templates/${groupId}`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          return { locale: locale.locale, translations: [] };
        }

        const data = await response.json();
        return { locale: locale.locale, translations: data.translations || [] };
      })
    );

    // Update state with all loaded translations
    const newTranslations: Record<string, ThemeTranslationRecord[]> = {};
    results.forEach((result) => {
      if (result.status === "fulfilled" && result.value.translations) {
        newTranslations[result.value.locale] = result.value.translations;
      }
    });

    if (Object.keys(newTranslations).length > 0) {
      setLoadedTranslations(prev => ({
        ...prev,
        [groupId]: {
          ...(prev[groupId] || {}),
          ...newTranslations,
        }
      }));
    }
  }, [loaderShopLocales]);

  // Load theme data on demand (for initial load) with pagination
  const loadThemeData = useCallback(async (groupId: string, page: number = 1, search: string = "") => {
    const paginationKey = groupId;
    const currentPagination = fieldPagination[paginationKey];

    // Check if we need to reload (different page/search or not loaded yet)
    const needsReload = !loadedThemes[groupId] ||
      currentPagination?.page !== page ||
      currentPagination?.search !== search;

    if (!needsReload) {
      // Data already loaded with same pagination, but still preload translations if needed
      preloadAllTranslations(groupId);
      return;
    }

    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(DEFAULT_FIELDS_PER_PAGE),
        ...(search && { search })
      });

      const response = await fetch(`/api/templates/${groupId}?${params}`);
      if (!response.ok) throw new Error('Failed to load theme data');

      const data = await response.json();
      setLoadedThemes(prev => ({
        ...prev,
        [groupId]: data.theme
      }));

      // Store pagination metadata
      if (data.theme?.pagination) {
        setFieldPagination(prev => ({
          ...prev,
          [groupId]: {
            page: data.theme.pagination.page,
            limit: data.theme.pagination.limit,
            totalCount: data.theme.pagination.totalCount,
            totalPages: data.theme.pagination.totalPages,
            search: search,
          }
        }));
      }

      // Preload all foreign language translations in background
      preloadAllTranslations(groupId);
    } catch {
      showInfoBox(
        "Error loading theme content",
        "critical",
        t.content?.error || "Error"
      );
    } finally {
      setIsLoading(false);
    }
  }, [loadedThemes, fieldPagination, showInfoBox, t, preloadAllTranslations]);

  // Separate fetcher for loading translations (to not interfere with main actions)
  const translationFetcher = useFetcher();

  // Load translations for a specific locale using fetcher
  const loadTranslationsForLocale = useCallback((groupId: string, locale: string) => {
    // Skip if already loaded or if it's the primary locale (primary uses translatableContent)
    if (loadedTranslations[groupId]?.[locale] || locale === primaryLocale) {
      return;
    }

    // Skip if already loading
    if (translationFetcher.state !== 'idle') {
      return;
    }

    const formData = new FormData();
    formData.append("action", "loadTranslations");
    formData.append("itemId", `group_${groupId}`);
    formData.append("locale", locale);

    translationFetcher.submit(formData, { method: "POST" });
  }, [loadedTranslations, primaryLocale, translationFetcher]);

  // Field pagination handlers
  const handleFieldPageChange = useCallback((newPage: number) => {
    if (!selectedGroupId) return;
    const currentSearch = fieldPagination[selectedGroupId]?.search || "";
    loadThemeData(selectedGroupId, newPage, currentSearch);
  }, [selectedGroupId, fieldPagination, loadThemeData]);

  const handleFieldSearch = useCallback((searchQuery: string) => {
    if (!selectedGroupId) return;
    // Reset to page 1 when searching
    loadThemeData(selectedGroupId, 1, searchQuery);
  }, [selectedGroupId, loadThemeData]);

  // Get current field pagination for selected group
  const currentFieldPagination = selectedGroupId ? fieldPagination[selectedGroupId] : null;

  // Auto-load first item (data loading only)
  useEffect(() => {
    if (themes.length > 0 && !selectedGroupId) {
      const firstTheme = themes[0] as ThemeNavItem | undefined;
      if (firstTheme) {
        setSelectedGroupId(firstTheme.groupId);
        loadThemeData(firstTheme.groupId);
      }
    }
  }, [themes, selectedGroupId, loadThemeData]);

  // Callback to update translations cache when translateFieldToAllLocales completes
  const handleTranslateToAllLocalesComplete = useCallback((fieldKey: string, translations: Record<string, string>) => {
    if (!selectedGroupId) return;

    setLoadedTranslations(prev => {
      const newCache = { ...prev };
      const groupCache = { ...(newCache[selectedGroupId] || {}) };

      // Update each locale's cache with the new translation
      for (const [locale, translatedValue] of Object.entries(translations)) {
        const localeCache = [...(groupCache[locale] || [])];

        // Find and update or add the translation
        const existingIndex = localeCache.findIndex((tr) => tr.key === fieldKey);
        if (existingIndex >= 0) {
          localeCache[existingIndex] = { ...localeCache[existingIndex], value: translatedValue };
        } else {
          localeCache.push({ key: fieldKey, value: translatedValue, locale });
        }

        groupCache[locale] = localeCache;
      }

      newCache[selectedGroupId] = groupCache;
      return newCache;
    });
  }, [selectedGroupId]);

  // Create editor with dynamic config
  const editor = useUnifiedContentEditor({
    config: TEMPLATES_CONFIG,
    items,
    shopLocales: loaderShopLocales,
    primaryLocale,
    fetcher,
    showInfoBox,
    t,
    onTranslateToAllLocalesComplete: handleTranslateToAllLocalesComplete,
  });

  // Ref to store editor helpers to avoid triggering effects on every render
  const editorHelpersRef = useRef(editor.helpers);
  editorHelpersRef.current = editor.helpers;

  // Refs for reload effect (avoid stale closures and unnecessary re-triggers)
  const selectedGroupIdRef = useRef(selectedGroupId);
  selectedGroupIdRef.current = selectedGroupId;
  const fieldPaginationRef = useRef(fieldPagination);
  fieldPaginationRef.current = fieldPagination;
  const editorLanguageRef = useRef(editor.state.currentLanguage);
  editorLanguageRef.current = editor.state.currentLanguage;

  // Store original handler reference before overriding
  const originalHandleItemSelectRef = useRef(editor.handlers.handleItemSelect);
  originalHandleItemSelectRef.current = editor.handlers.handleItemSelect;

  // Override item select handler to load data first
  editor.handlers.handleItemSelect = (itemId: string) => {
    const theme = themes.find((t: ThemeNavItem) => t.id === itemId);
    if (theme) {
      setSelectedGroupId(theme.groupId);

      // If already loaded, just select and preload translations
      if (loadedThemes[theme.groupId] && fieldPagination[theme.groupId]) {
        originalHandleItemSelectRef.current(itemId);
        // Preload translations if not already loaded
        preloadAllTranslations(theme.groupId);
      } else {
        // Load data with pagination, then select
        setIsLoading(true);
        const params = new URLSearchParams({
          page: "1",
          limit: String(DEFAULT_FIELDS_PER_PAGE),
        });

        fetch(`/api/templates/${theme.groupId}?${params}`)
          .then(response => {
            if (!response.ok) throw new Error('Failed to load theme data');
            return response.json();
          })
          .then(data => {
            setLoadedThemes(prev => ({
              ...prev,
              [theme.groupId]: data.theme
            }));

            // Store pagination metadata
            if (data.theme?.pagination) {
              setFieldPagination(prev => ({
                ...prev,
                [theme.groupId]: {
                  page: data.theme.pagination.page,
                  limit: data.theme.pagination.limit,
                  totalCount: data.theme.pagination.totalCount,
                  totalPages: data.theme.pagination.totalPages,
                  search: "",
                }
              }));
            }

            // Preload all foreign language translations in background
            preloadAllTranslations(theme.groupId);
            // Select after data is loaded
            setTimeout(() => {
              originalHandleItemSelectRef.current(itemId);
            }, 0);
          })
          .catch(() => {
            showInfoBox("Error loading theme content", "critical", t.content?.error || "Error");
          })
          .finally(() => {
            setIsLoading(false);
          });
      }
    }
  };

  // Select first item after data is loaded (must be after originalHandleItemSelectRef is defined)
  const hasSelectedInitialItem = useRef(false);
  useEffect(() => {
    if (themes.length > 0 && selectedGroupId && loadedThemes[selectedGroupId] && !hasSelectedInitialItem.current) {
      const theme = themes.find((t: ThemeNavItem) => t.groupId === selectedGroupId);
      if (theme && originalHandleItemSelectRef.current) {
        hasSelectedInitialItem.current = true;
        originalHandleItemSelectRef.current(theme.id);
      }
    }
  }, [loadedThemes, selectedGroupId, themes]);

  // Update editable values when pagination changes (new page of fields loaded)
  const previousPaginationRef = useRef<{ page: number; search: string } | null>(null);
  useEffect(() => {
    if (!selectedGroupId) return;
    const pag = fieldPagination[selectedGroupId];
    if (!pag) return;

    const prev = previousPaginationRef.current;
    const pageChanged = prev && (prev.page !== pag.page || prev.search !== pag.search);
    previousPaginationRef.current = { page: pag.page, search: pag.search };

    // Only run when page/search actually changed (not on first load - that's handled by item select)
    if (!pageChanged) return;

    const themeData = loadedThemes[selectedGroupId];
    if (!themeData?.translatableContent) return;

    const currentLanguage = editor.state.currentLanguage;
    const newValues: Record<string, string> = {};

    if (currentLanguage === primaryLocale) {
      // Primary locale: values come from translatableContent
      themeData.translatableContent.forEach((item: TranslatableField) => {
        newValues[item.key] = item.value || "";
      });
    } else {
      // Foreign locale: values come from cached translations
      const cachedTranslations = loadedTranslations[selectedGroupId]?.[currentLanguage];
      themeData.translatableContent.forEach((item: TranslatableField) => {
        const translation = cachedTranslations?.find((tr) => tr.key === item.key);
        newValues[item.key] = translation?.value || "";
      });
    }

    // Update editable values for the new page's fields
    Object.entries(newValues).forEach(([key, value]) => {
      editorHelpersRef.current.setEditableValue(key, value);
    });
    editorHelpersRef.current.setOriginalTemplateValues(newValues);
  }, [fieldPagination, selectedGroupId, loadedThemes, editor.state.currentLanguage, primaryLocale, loadedTranslations]);

  // Load translations when language or group changes
  useEffect(() => {
    const currentLanguage = editor.state.currentLanguage;

    // Only run when language or group actually changes (prevents re-loading on every render)
    const languageChanged = previousLanguageRef.current !== currentLanguage;
    const groupChanged = previousGroupIdRef.current !== selectedGroupId;

    if (!languageChanged && !groupChanged) return;

    previousLanguageRef.current = currentLanguage;
    previousGroupIdRef.current = selectedGroupId;

    if (!selectedGroupId || !currentLanguage || currentLanguage === primaryLocale) return;

    // Check if already cached
    const cachedTranslations = loadedTranslations[selectedGroupId]?.[currentLanguage];

    if (cachedTranslations) {
      // Use cached translations - update editable values directly
      const themeData = loadedThemes[selectedGroupId];
      if (themeData?.translatableContent) {
        const newValues: Record<string, string> = {};
        themeData.translatableContent.forEach((item: TranslatableField) => {
          const translation = cachedTranslations.find((tr) => tr.key === item.key);
          const value = translation?.value || "";
          newValues[item.key] = value;
          editorHelpersRef.current.setEditableValue(item.key, value);
        });
        // Update original values so hasChanges is false after language switch
        editorHelpersRef.current.setOriginalTemplateValues(newValues);
      }
    } else {
      // Load from server
      loadTranslationsForLocale(selectedGroupId, currentLanguage);
    }
  }, [editor.state.currentLanguage, selectedGroupId, primaryLocale, loadTranslationsForLocale, loadedTranslations, loadedThemes]);

  // Handle translation fetcher response
  const processedTranslationFetcherRef = useRef<unknown>(null);
  useEffect(() => {
    const data = translationFetcher.data as { success?: boolean; translations?: ThemeTranslationRecord[]; locale?: string } | undefined;
    if (!data?.success || !data?.translations || !data?.locale) return;
    // Prevent re-processing when deps like loadedThemes change but data hasn't
    if (processedTranslationFetcherRef.current === translationFetcher.data) return;
    processedTranslationFetcherRef.current = translationFetcher.data;

    const { translations, locale } = data;

    // Store translations in cache
    if (selectedGroupId) {
      setLoadedTranslations(prev => ({
        ...prev,
        [selectedGroupId]: {
          ...(prev[selectedGroupId] || {}),
          [locale]: translations,
        }
      }));

      // If this is the current language, update editable values directly
      if (locale === editor.state.currentLanguage) {
        const themeData = loadedThemes[selectedGroupId];
        if (themeData?.translatableContent) {
          // Build new values object with translations
          const newValues: Record<string, string> = {};
          themeData.translatableContent.forEach((item: TranslatableField) => {
            const translation = translations.find((tr) => tr.key === item.key);
            newValues[item.key] = translation?.value || "";
          });

          // Update all values at once
          Object.entries(newValues).forEach(([key, value]) => {
            editorHelpersRef.current.setEditableValue(key, value);
          });

          // Update original values so hasChanges is false after language switch
          editorHelpersRef.current.setOriginalTemplateValues(newValues);
        }
      }
    }
  }, [translationFetcher.data, selectedGroupId, editor.state.currentLanguage, loadedThemes]);

  // Track processed save responses to prevent duplicate processing
  const processedSaveRef = useRef<unknown>(null);

  // Update caches after successful save
  useEffect(() => {
    if (!fetcher.data || typeof fetcher.data !== 'object') return;
    if (!('success' in fetcher.data) || !fetcher.data.success) return;

    // Only process content update saves, not translations or AI responses
    if ('translatedValue' in fetcher.data || 'generatedContent' in fetcher.data || 'translations' in fetcher.data) return;

    // Skip if already processed
    if (processedSaveRef.current === fetcher.data) return;
    processedSaveRef.current = fetcher.data;


    const currentLanguage = editor.state.currentLanguage;
    const currentValues = editor.state.editableValues;

    if (selectedGroupId && loadedThemes[selectedGroupId]) {
      const themeData = loadedThemes[selectedGroupId];

      if (currentLanguage === primaryLocale) {
        // PRIMARY LOCALE SAVE: Update loadedThemes and invalidate translation cache
        if (themeData.translatableContent && Array.isArray(themeData.translatableContent)) {
          // Create updated translatableContent with new values
          const updatedContent = themeData.translatableContent.map((item: TranslatableField) => {
            if (currentValues[item.key] !== undefined) {
              return { ...item, value: currentValues[item.key] };
            }
            return item;
          });

          // Update the loadedThemes cache
          setLoadedThemes(prev => ({
            ...prev,
            [selectedGroupId]: {
              ...prev[selectedGroupId],
              translatableContent: updatedContent
            }
          }));

          // ── IMPORTANT: Surgically remove translations for CHANGED keys only ──
          // When primary content changes, the server deletes stale foreign
          // translations on Shopify — but ONLY for the keys that actually changed.
          // We must mirror this on the client: remove only those translations from
          // the cache, keeping unchanged translations intact.
          // Previously this deleted the ENTIRE group cache, which caused ALL foreign
          // locale buttons to show "missing" and a flash of empty fields when
          // switching to a foreign locale.
          // DO NOT change this to delete the entire group — that causes the bug above.
          // ───────────────────────────────────────────────────────────────────────
          const changedKeys = new Set<string>();
          themeData.translatableContent.forEach((item: TranslatableField) => {
            if (currentValues[item.key] !== undefined && currentValues[item.key] !== item.value) {
              changedKeys.add(item.key);
            }
          });

          if (changedKeys.size > 0) {
            setLoadedTranslations(prev => {
              const groupCache = prev[selectedGroupId];
              if (!groupCache) return prev;

              const newGroupCache: Record<string, ThemeTranslationRecord[]> = {};
              for (const [locale, translations] of Object.entries(groupCache)) {
                newGroupCache[locale] = translations.filter(t => !changedKeys.has(t.key));
              }

              return { ...prev, [selectedGroupId]: newGroupCache };
            });

            // Also update the ref so preloadAllTranslations sees the correct state
            const refGroup = loadedTranslationsRef.current[selectedGroupId];
            if (refGroup) {
              const newRefGroup: Record<string, ThemeTranslationRecord[]> = {};
              for (const [locale, translations] of Object.entries(refGroup)) {
                newRefGroup[locale] = translations.filter(t => !changedKeys.has(t.key));
              }
              loadedTranslationsRef.current = {
                ...loadedTranslationsRef.current,
                [selectedGroupId]: newRefGroup,
              };
            }
          }
        }
      } else {
        // FOREIGN LOCALE SAVE: Update loadedTranslations cache with new values
        setLoadedTranslations(prev => {
          const groupCache = prev[selectedGroupId] || {};
          const localeCache = groupCache[currentLanguage] || [];

          // Update, add, or REMOVE translations for changed keys.
          // IMPORTANT: Empty values must be removed (splice), not kept with
          // value "". Otherwise the items memo includes them in allTranslations,
          // which can cause stale translations to reappear in the UI.
          const updatedCache = [...localeCache];
          Object.entries(currentValues).forEach(([key, value]) => {
            const existingIndex = updatedCache.findIndex((tr) => tr.key === key);
            if (value) {
              if (existingIndex >= 0) {
                updatedCache[existingIndex] = { ...updatedCache[existingIndex], value };
              } else {
                updatedCache.push({ key, value, locale: currentLanguage });
              }
            } else if (existingIndex >= 0) {
              updatedCache.splice(existingIndex, 1);
            }
          });

          return {
            ...prev,
            [selectedGroupId]: {
              ...groupCache,
              [currentLanguage]: updatedCache
            }
          };
        });
      }
    }
  }, [fetcher.data, selectedGroupId, loadedThemes, editor.state.editableValues, editor.state.currentLanguage, primaryLocale]);

  // Track processed translation responses to prevent duplicate cache updates
  const processedTranslationRef = useRef<unknown>(null);

  // Update loadedTranslations cache after translateFieldToAllLocales completes
  useEffect(() => {
    if (!fetcher.data || typeof fetcher.data !== 'object') return;
    if (!('success' in fetcher.data) || !fetcher.data.success) return;
    if (!('translations' in fetcher.data) || !('fieldType' in fetcher.data)) return;
    // Make sure it's translateFieldToAllLocales (has translations object, not array)
    if ('locale' in fetcher.data) return; // Skip single locale translations

    // Skip if already processed
    if (processedTranslationRef.current === fetcher.data) return;
    processedTranslationRef.current = fetcher.data;

    const { translations, fieldType } = fetcher.data as { translations: Record<string, string>; fieldType: string };

    if (!selectedGroupId) return;

    // Update the loadedTranslations cache with new translations
    setLoadedTranslations(prev => {
      const newCache = { ...prev };
      const groupCache = newCache[selectedGroupId] || {};

      // Update each locale's cache with the new translation
      for (const [locale, translatedValue] of Object.entries(translations)) {
        const localeCache = [...(groupCache[locale] || [])];

        // Find and update or add the translation
        const existingIndex = localeCache.findIndex((tr) => tr.key === fieldType);
        if (existingIndex >= 0) {
          localeCache[existingIndex] = { ...localeCache[existingIndex], value: translatedValue };
        } else {
          localeCache.push({ key: fieldType, value: translatedValue, locale });
        }

        groupCache[locale] = localeCache;
      }

      newCache[selectedGroupId] = groupCache;
      return newCache;
    });
  }, [fetcher.data, selectedGroupId]);

  // Update loadedTranslations cache after translateAll (all fields → all locales) completes
  const processedTranslateAllRef = useRef<unknown>(null);
  useEffect(() => {
    if (!fetcher.data || typeof fetcher.data !== 'object') return;
    if (!('success' in fetcher.data) || !fetcher.data.success) return;
    if (!('actionType' in fetcher.data)) return;
    if (processedTranslateAllRef.current === fetcher.data) return;

    if (!selectedGroupId) return;

    if (fetcher.data.actionType === 'translateAll') {
      processedTranslateAllRef.current = fetcher.data;
      // translations shape: { locale: { key: value, ... }, ... }
      const translations = (fetcher.data as { translations: Record<string, Record<string, string>> }).translations;
      setLoadedTranslations(prev => {
        const newCache = { ...prev };
        const groupCache = { ...(newCache[selectedGroupId] || {}) };

        for (const [locale, fields] of Object.entries(translations)) {
          const localeCache = [...(groupCache[locale] || [])];

          for (const [key, value] of Object.entries(fields)) {
            const existingIndex = localeCache.findIndex((tr) => tr.key === key);
            if (existingIndex >= 0) {
              localeCache[existingIndex] = { ...localeCache[existingIndex], value };
            } else {
              localeCache.push({ key, value, locale });
            }
          }

          groupCache[locale] = localeCache;
        }

        newCache[selectedGroupId] = groupCache;
        return newCache;
      });
    } else if (fetcher.data.actionType === 'translateAllForLocale') {
      processedTranslateAllRef.current = fetcher.data;
      // translations shape: { key: value, ... }, targetLocale: string
      const { translations, targetLocale } = fetcher.data as { translations: Record<string, string>; targetLocale: string };
      setLoadedTranslations(prev => {
        const newCache = { ...prev };
        const groupCache = { ...(newCache[selectedGroupId] || {}) };
        const localeCache = [...(groupCache[targetLocale] || [])];

        for (const [key, value] of Object.entries(translations)) {
          const existingIndex = localeCache.findIndex((tr) => tr.key === key);
          if (existingIndex >= 0) {
            localeCache[existingIndex] = { ...localeCache[existingIndex], value };
          } else {
            localeCache.push({ key, value, locale: targetLocale });
          }
        }

        groupCache[targetLocale] = localeCache;
        newCache[selectedGroupId] = groupCache;
        return newCache;
      });
    }
  }, [fetcher.data, selectedGroupId]);

  // ============================================================================
  // RELOAD: Invalidate caches and re-fetch fresh data after revalidation completes
  // After the ReloadButton syncs from Shopify to DB, we need to re-fetch theme
  // data and translations from the API (which reads from the now-updated DB).
  // Without this, loadedThemes and loadedTranslations hold stale cached data.
  // ============================================================================
  const prevRevalidatorStateRef = useRef(revalidator.state);
  useEffect(() => {
    const prevState = prevRevalidatorStateRef.current;
    prevRevalidatorStateRef.current = revalidator.state;

    // Only act when revalidation transitions from loading → idle
    if (prevState !== 'loading' || revalidator.state !== 'idle') return;
    const groupId = selectedGroupIdRef.current;
    if (!groupId) return;

    // Only clear translation cache on explicit reload (ReloadButton).
    // The ReloadButton adds a _reload URL param before calling revalidate().
    // After saves/translations, the specific response handlers already update
    // loadedTranslations correctly — clearing here would wipe those updates.
    const url = new URL(window.location.href);
    const isExplicitReload = url.searchParams.has('_reload');

    if (isExplicitReload) {
      // Clean up the reload marker from the URL
      url.searchParams.delete('_reload');
      window.history.replaceState({}, '', url.toString());

      // Invalidate translation cache so preloadAllTranslations will re-fetch
      setLoadedTranslations(prev => {
        const next = { ...prev };
        delete next[groupId];
        return next;
      });
      // Also update ref immediately so preloadAllTranslations sees cleared cache
      const clearedRef = { ...loadedTranslationsRef.current };
      delete clearedRef[groupId];
      loadedTranslationsRef.current = clearedRef;
    }

    // Only re-fetch full theme data on explicit reload.
    // After saves/translations, the response handlers already update the caches.
    if (!isExplicitReload) return;

    // Helper: fetch theme data for a given page and update all caches + editable values
    const fetchAndApply = async (page: number, search: string) => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(DEFAULT_FIELDS_PER_PAGE),
        ...(search && { search })
      });

      const res = await fetch(`/api/templates/${groupId}?${params}`);
      if (!res.ok) throw new Error('Failed to reload theme data');
      const data = await res.json();

      // Handle pagination shift: if we requested a page beyond the new total,
      // fall back to page 1 (e.g., total count decreased after sync)
      const pagination = data.theme?.pagination;
      if (pagination && page > 1 && pagination.totalPages > 0 && page > pagination.totalPages) {
        return fetchAndApply(1, search);
      }

      // Update loadedThemes cache with fresh data
      setLoadedThemes(prev => ({
        ...prev,
        [groupId]: data.theme
      }));

      // Update pagination metadata
      if (pagination) {
        setFieldPagination(prev => ({
          ...prev,
          [groupId]: {
            page: pagination.page,
            limit: pagination.limit,
            totalCount: pagination.totalCount,
            totalPages: pagination.totalPages,
            search: search,
          }
        }));
      }

      // Build new editable values from fresh data
      const translatableContent: TranslatableField[] = data.theme?.translatableContent || [];
      if (translatableContent.length === 0) return;

      const currentLanguage = editorLanguageRef.current;
      const newValues: Record<string, string> = {};

      if (currentLanguage === primaryLocale) {
        // Primary locale: values from fresh translatableContent
        translatableContent.forEach((item) => {
          newValues[item.key] = item.value || "";
        });
      } else {
        // Foreign locale: fetch fresh translations for current language
        const formData = new FormData();
        formData.append("action", "loadTranslations");
        formData.append("locale", currentLanguage);

        const transResponse = await fetch(`/api/templates/${groupId}`, {
          method: "POST",
          body: formData,
        });

        if (transResponse.ok) {
          const transData = await transResponse.json();
          const translations: ThemeTranslationRecord[] = transData.translations || [];

          // Update translations cache for this locale
          setLoadedTranslations(prev => ({
            ...prev,
            [groupId]: {
              ...(prev[groupId] || {}),
              [currentLanguage]: translations,
            }
          }));

          translatableContent.forEach((item) => {
            const translation = translations.find((tr) => tr.key === item.key);
            newValues[item.key] = translation?.value || "";
          });
        } else {
          // If translation fetch fails, keep fields empty rather than showing stale data
          translatableContent.forEach((item) => {
            newValues[item.key] = "";
          });
        }
      }

      // Atomic update: replace ALL editable values and original values in one batch.
      // This avoids race conditions from individual setEditableValue calls where
      // other effects (e.g. retry mechanism) could interleave and overwrite values.
      editorHelpersRef.current.reloadTemplateValues(newValues);

      // Preload translations for all other foreign locales in background
      preloadAllTranslations(groupId);
    };

    // Start the reload with current page/search
    const currentPag = fieldPaginationRef.current[groupId];
    const page = currentPag?.page || 1;
    const search = currentPag?.search || "";

    fetchAndApply(page, search).catch((err) => {
      console.error('[Templates Reload] fetchAndApply failed:', err);
    });
  }, [revalidator.state, primaryLocale, preloadAllTranslations]);

  // Handle response messages - NOTE: Success messages are handled by useUnifiedContentEditor hook
  // Only show error messages here to avoid duplicates
  // errorKey responses (e.g. emptyPrimaryFieldsError) are handled by the editor hook
  // which also auto-restores empty fields — so we skip them here to avoid double InfoBox.
  useEffect(() => {
    if (fetcher.data && typeof fetcher.data === 'object') {
      if ('error' in fetcher.data && !('errorKey' in fetcher.data) && !fetcher.data.success) {
        const errorData = fetcher.data as { error?: string; success: boolean };
        showInfoBox(
          errorData.error || "Unknown error",
          "critical",
          t.content?.error || "Error"
        );
      }
    }
  }, [fetcher.data, showInfoBox, t]);

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.content?.error || "Error");
    }
  }, [error, showInfoBox, t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <MainNavigation />
      <ContentTypeNavigation />
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={TEMPLATES_CONFIG}
          items={items}
          shopLocales={loaderShopLocales}
          primaryLocale={primaryLocale}
          editor={editor}
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData}
          t={t}
          hideItemListImages={true}
          hideItemListStatusBars={true}
          fieldPagination={currentFieldPagination}
          onFieldPageChange={handleFieldPageChange}
          onFieldSearch={handleFieldSearch}
          isFieldsLoading={isLoading}
          revalidator={revalidator}
          sortOptions={[
            { field: "title", label: "Title" },
          ]}
        />
      </div>
    </div>
  );
}
