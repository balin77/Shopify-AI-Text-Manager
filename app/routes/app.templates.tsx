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
import { AIService, type AIProvider } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { decryptApiKey } from "../utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { safeJsonParse } from "~/utils/validation";
import type { ShopLocale } from "~/types/content-editor.types";
import { logger } from "~/utils/logger.server";

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

        // Create task entry
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "aiGeneration",
            status: "pending",
            resourceType: "templates",
            resourceId: `group_${groupId}`,
            resourceTitle: firstGroup.groupName,
            fieldType,
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
            (settings?.preferredProvider as AIProvider) || 'huggingface',
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
            fieldType,
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
            (settings?.preferredProvider as AIProvider) || 'huggingface',
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

          // Auto-save the translation
          await db.themeTranslation.upsert({
            where: {
              shop_resourceId_groupId_key_locale: {
                shop: session.shop,
                resourceId: resourceId,
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
              resourceId: resourceId,
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
            fieldType,
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
            (settings?.preferredProvider as AIProvider) || 'huggingface',
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

          // Batch save all translations in a single transaction
          if (pendingUpserts.length > 0) {
            await db.$transaction(
              pendingUpserts.map(({ locale, value }) =>
                db.themeTranslation.upsert({
                  where: {
                    shop_resourceId_groupId_key_locale: {
                      shop: session.shop,
                      resourceId: resourceId,
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
                    resourceId: resourceId,
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
            (settings?.preferredProvider as AIProvider) || 'huggingface',
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
          const pendingUpserts: Array<{ key: string; locale: string; value: string }> = [];

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
                pendingUpserts.push({ key, locale, value: translated });

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
              pendingUpserts.map(({ key, locale, value }) =>
                db.themeTranslation.upsert({
                  where: {
                    shop_resourceId_groupId_key_locale: {
                      shop: session.shop,
                      resourceId: resourceId,
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
                    resourceId: resourceId,
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
              translations: translations[targetLocale] || {},
              targetLocale
            });
          }

          return json({
            success: true,
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

        for (const key of uniqueKeys) {
          const value = formData.get(key);
          if (typeof value === "string") {
            updatedFields[key] = value;
          }
        }

        if (Object.keys(updatedFields).length === 0) {
          return json({ success: true }); // No changes
        }

        if (locale === primaryLocale) {
          // Update primary locale: Update translatableContent in ThemeContent
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
          // Update translations: batch upsert in a single transaction
          const entries = Object.entries(updatedFields);
          if (entries.length > 0) {
            await db.$transaction(
              entries.map(([key, value]) =>
                db.themeTranslation.upsert({
                  where: {
                    shop_resourceId_groupId_key_locale: {
                      shop: session.shop,
                      resourceId: resourceId,
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
                    resourceId: resourceId,
                    locale: locale,
                    key: key,
                    value: value
                  }
                })
              )
            );
          }
        }

        return json({ success: true });
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
  const fetcher = useFetcher<typeof action>();
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
  useEffect(() => {
    const data = translationFetcher.data as { success?: boolean; translations?: ThemeTranslationRecord[]; locale?: string } | undefined;
    if (!data?.success || !data?.translations || !data?.locale) return;

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

          // IMPORTANT: Invalidate ALL translation caches for this group
          // This ensures that deleted translations are not shown from cache
          setLoadedTranslations(prev => {
            const newCache = { ...prev };
            delete newCache[selectedGroupId]; // Remove all cached translations for this group
            return newCache;
          });
        }
      } else {
        // FOREIGN LOCALE SAVE: Update loadedTranslations cache with new values
        setLoadedTranslations(prev => {
          const groupCache = prev[selectedGroupId] || {};
          const localeCache = groupCache[currentLanguage] || [];

          // Update or add translations for changed keys
          const updatedCache = [...localeCache];
          Object.entries(currentValues).forEach(([key, value]) => {
            const existingIndex = updatedCache.findIndex((tr) => tr.key === key);
            if (existingIndex >= 0) {
              updatedCache[existingIndex] = { ...updatedCache[existingIndex], value };
            } else if (value) {
              // Only add if there's actually a value
              updatedCache.push({ key, value, locale: currentLanguage });
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

  // Handle response messages - NOTE: Success messages are handled by useUnifiedContentEditor hook
  // Only show error messages here to avoid duplicates
  useEffect(() => {
    if (fetcher.data && typeof fetcher.data === 'object') {
      if ('error' in fetcher.data && !fetcher.data.success) {
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
