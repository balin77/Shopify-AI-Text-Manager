/**
 * Theme Templates Management - View and manage theme translatable content
 *
 * Uses the UnifiedContentEditor system for code reuse and consistency.
 * Templates have dynamic fields loaded from translatableContent.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { TEMPLATES_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { AIService } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { decryptApiKey } from "../utils/encryption.server";
import { getTaskExpirationDate } from "../../src/utils/task.utils";

// ============================================================================
// LOADER - Load navigation metadata (groups list)
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    // Load shopLocales
    const localesResponse = await admin.graphql(
      `#graphql
        query getShopLocales {
          shopLocales {
            locale
            name
            primary
            published
          }
        }`
    );

    const localesData = await localesResponse.json();
    const shopLocales = localesData.data?.shopLocales || [];
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

    // LAZY LOADING: Only load navigation metadata, not the full content
    const { db } = await import("../db.server");

    // OPTIMIZED: Use groupBy to get unique groups with counts in a single efficient query
    const groupsWithCounts = await db.themeContent.groupBy({
      by: ['groupId', 'groupName', 'groupIcon'],
      where: { shop: session.shop },
      _count: {
        groupId: true
      }
    });

    // Create lightweight navigation items (sorted alphabetically)
    const themes = groupsWithCounts
      .map(group => ({
        id: `group_${group.groupId}`,
        title: group.groupName,
        groupName: group.groupName,
        icon: group.groupIcon,
        groupId: group.groupId,
        role: 'THEME_GROUP',
        contentCount: group._count.groupId,
        // Required for UnifiedContentEditor compatibility
        translatableContent: [], // Will be loaded on demand
        translations: [],
      }))
      .sort((a, b) => a.title.localeCompare(b.title));

    return json({
      themes,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    console.error("[TEMPLATES-LOADER] Error:", error);
    return json({
      themes: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "de",
      error: error.message
    }, { status: 500 });
  }
};

// ============================================================================
// ACTION - Handle content updates
// ============================================================================

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("action") as string;
  const itemId = formData.get("itemId") as string;

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
        const locale = formData.get("locale") as string;

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
        const fieldType = formData.get("fieldType") as string;
        const currentValue = formData.get("currentValue") as string;
        const mainLanguage = formData.get("mainLanguage") as string;

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
            settings?.preferredProvider as any || 'huggingface',
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
        } catch (error: any) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: (error.message || String(error)).substring(0, 1000),
            },
          });
          return json({ success: false, error: error.message }, { status: 500 });
        }
      }

      case "translateField": {
        const fieldType = formData.get("fieldType") as string;
        const sourceText = formData.get("sourceText") as string;
        const targetLocale = formData.get("targetLocale") as string;
        const primaryLocaleFromForm = formData.get("primaryLocale") as string;

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

          const primaryLocale = primaryLocaleFromForm || "de";

          const aiService = new AIService(
            settings?.preferredProvider as any || 'huggingface',
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
        } catch (error: any) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: (error.message || String(error)).substring(0, 1000),
            },
          });
          return json({ success: false, error: error.message }, { status: 500 });
        }
      }

      case "translateFieldToAllLocales": {
        const fieldType = formData.get("fieldType") as string;
        const sourceText = formData.get("sourceText") as string;
        const targetLocalesJson = formData.get("targetLocales") as string;
        const primaryLocaleFromForm = formData.get("primaryLocale") as string;

        if (!sourceText) {
          return json({
            success: false,
            error: "No source text available"
          }, { status: 400 });
        }

        const targetLocales = targetLocalesJson ? JSON.parse(targetLocalesJson) : [];
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
            type: "translationBulk",
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

          const primaryLocale = primaryLocaleFromForm || "de";

          const aiService = new AIService(
            settings?.preferredProvider as any || 'huggingface',
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

          for (let i = 0; i < targetLocales.length; i++) {
            const locale = targetLocales[i];
            try {
              const translatedValue = await aiService.translateContent(
                sourceText,
                primaryLocale,
                locale
              );
              translations[locale] = translatedValue;

              // Auto-save each translation
              await db.themeTranslation.upsert({
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
                  value: translatedValue,
                  updatedAt: new Date()
                },
                create: {
                  shop: session.shop,
                  groupId: groupId,
                  resourceId: resourceId,
                  locale: locale,
                  key: fieldType,
                  value: translatedValue
                }
              });

              // Update progress
              const progress = Math.round(10 + ((i + 1) / totalLocales) * 80);
              await db.task.update({
                where: { id: task.id },
                data: { progress },
              });
            } catch (error) {
              console.error(`Error translating field ${fieldType} to ${locale}:`, error);
              translations[locale] = sourceText; // Fallback to original
            }
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
        } catch (error: any) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: (error.message || String(error)).substring(0, 1000),
            },
          });
          return json({ success: false, error: error.message }, { status: 500 });
        }
      }

      case "translateAll":
      case "translateAllForLocale": {
        const targetLocalesJson = formData.get("targetLocales") as string;
        const targetLocale = formData.get("targetLocale") as string;
        const targetLocales = targetLocalesJson ? JSON.parse(targetLocalesJson) : [targetLocale];

        // Get all translatable content
        const allContent = themeGroups.flatMap((group) => group.translatableContent as any[]);

        // Deduplicate
        const uniqueContent = new Map<string, any>();
        for (const item of allContent) {
          if (!uniqueContent.has(item.key) && item.value) {
            uniqueContent.set(item.key, item);
          }
        }

        // Create task entry
        const task = await db.task.create({
          data: {
            shop: session.shop,
            type: "translationBulk",
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
            settings?.preferredProvider as any || 'huggingface',
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

          const primaryLocale = formData.get("primaryLocale") as string || "de";

          // Translate to all target locales
          const translations: Record<string, Record<string, string>> = {};
          const totalItems = targetLocales.length * uniqueContent.size;
          let completedItems = 0;

          for (const locale of targetLocales) {
            translations[locale] = {};

            for (const [key, item] of uniqueContent.entries()) {
              try {
                const translated = await aiService.translateContent(
                  item.value,
                  primaryLocale,
                  locale
                );
                translations[locale][key] = translated;

                // Save translation to database
                await db.themeTranslation.upsert({
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
                    value: translated,
                    updatedAt: new Date()
                  },
                  create: {
                    shop: session.shop,
                    groupId: groupId,
                    resourceId: resourceId,
                    locale: locale,
                    key: key,
                    value: translated
                  }
                });

                // Update progress
                completedItems++;
                const progress = Math.round(5 + (completedItems / totalItems) * 90);
                await db.task.update({
                  where: { id: task.id },
                  data: { progress },
                });
              } catch (error) {
                console.error(`Error translating field ${key}:`, error);
                translations[locale][key] = item.value;
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
        } catch (error: any) {
          // Update task to failed
          await db.task.update({
            where: { id: task.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: (error.message || String(error)).substring(0, 1000),
            },
          });
          return json({ success: false, error: error.message }, { status: 500 });
        }
      }

      case "updateContent": {
        const locale = formData.get("locale") as string;
        const primaryLocale = formData.get("primaryLocale") as string;

        // Parse changedFields if present (for translation deletion when primary locale changes)
        const changedFieldsStr = formData.get("changedFields") as string;
        const changedFields: string[] = changedFieldsStr ? JSON.parse(changedFieldsStr) : [];

        // Debug: Log all form data keys
        const allFormDataKeys: string[] = [];
        formData.forEach((value, key) => {
          allFormDataKeys.push(key);
        });
        console.log(`[TEMPLATES-ACTION] 📝 updateContent - All FormData keys:`, allFormDataKeys);
        console.log(`[TEMPLATES-ACTION] 📝 updateContent called:`, {
          locale,
          primaryLocale,
          changedFieldsStr,
          changedFields,
          isPrimaryLocale: locale === primaryLocale
        });

        // Collect all field values from form data
        const updatedFields: Record<string, string> = {};

        // Get all translatable content keys
        const allContent = themeGroups.flatMap((group) => group.translatableContent as any[]);
        const uniqueKeys = new Set(allContent.map((item) => item.key));

        for (const key of uniqueKeys) {
          const value = formData.get(key);
          if (value !== null) {
            updatedFields[key] = value as string;
          }
        }

        if (Object.keys(updatedFields).length === 0) {
          return json({ success: true }); // No changes
        }

        if (locale === primaryLocale) {
          // Update primary locale: Update translatableContent in ThemeContent
          for (const group of themeGroups) {
            const content = group.translatableContent as any[];
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
                  translatableContent: content,
                  lastSyncedAt: new Date()
                }
              });
            }
          }

          // Delete translations for changed fields (they are now outdated)
          if (changedFields.length > 0) {
            console.log(`[TEMPLATES-ACTION] 🗑️ Deleting translations for changed fields:`, changedFields);

            await db.themeTranslation.deleteMany({
              where: {
                shop: session.shop,
                groupId: groupId,
                key: { in: changedFields }
              }
            });

            console.log(`[TEMPLATES-ACTION] ✅ Translations deleted for keys:`, changedFields);
          }
        } else {
          // Update translation: Use ThemeTranslation table
          for (const [key, value] of Object.entries(updatedFields)) {
            await db.themeTranslation.upsert({
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
            });
          }
        }

        return json({ success: true });
      }

      default:
        return json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (error: any) {
    console.error(`[TEMPLATES-ACTION] Error:`, error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
};

// ============================================================================
// COMPONENT
// ============================================================================

export default function TemplatesPage() {
  const { themes, shop, shopLocales: loaderShopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // State for lazy-loaded theme data
  const [loadedThemes, setLoadedThemes] = useState<Record<string, any>>({});
  const [loadedTranslations, setLoadedTranslations] = useState<Record<string, Record<string, any[]>>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const editorRef = useRef<any>(null);

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
    return themes.map((theme: any) => {
      const loadedData = loadedThemes[theme.groupId];
      const themeTranslations = loadedTranslations[theme.groupId] || {};

      if (loadedData) {
        // Merge all translations from different locales
        const allTranslations: any[] = [];
        for (const [locale, translations] of Object.entries(themeTranslations)) {
          for (const translation of translations as any[]) {
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
    const foreignLocales = loaderShopLocales.filter((l: any) => !l.primary);
    if (foreignLocales.length === 0) return;

    // Use ref to check already loaded locales (avoids stale closure)
    const currentLoaded = loadedTranslationsRef.current;
    const localesToLoad = foreignLocales.filter(
      (l: any) => !currentLoaded[groupId]?.[l.locale]
    );
    if (localesToLoad.length === 0) return;

    // Load all translations in parallel using API route
    const results = await Promise.allSettled(
      localesToLoad.map(async (locale: any) => {
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
    const newTranslations: Record<string, any[]> = {};
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
    } catch (error) {
      console.error('Error loading theme data:', error);
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
      const firstTheme = themes[0] as any;
      if (firstTheme) {
        setSelectedGroupId(firstTheme.groupId);
        loadThemeData(firstTheme.groupId);
      }
    }
  }, [themes, selectedGroupId, loadThemeData]);

  // Create editor with dynamic config
  const editor = useUnifiedContentEditor({
    config: TEMPLATES_CONFIG,
    items,
    shopLocales: loaderShopLocales,
    primaryLocale,
    fetcher,
    showInfoBox,
    t,
  });

  // Ref to store editor helpers to avoid triggering effects on every render
  const editorHelpersRef = useRef(editor.helpers);
  editorHelpersRef.current = editor.helpers;

  // Store original handler reference before overriding
  const originalHandleItemSelectRef = useRef(editor.handlers.handleItemSelect);
  originalHandleItemSelectRef.current = editor.handlers.handleItemSelect;

  // Override item select handler to load data first
  editor.handlers.handleItemSelect = (itemId: string) => {
    const theme = themes.find((t: any) => t.id === itemId);
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
          .then(response => response.json())
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
          .catch(error => {
            console.error('Error loading theme data:', error);
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
      const theme = themes.find((t: any) => t.groupId === selectedGroupId);
      if (theme && originalHandleItemSelectRef.current) {
        hasSelectedInitialItem.current = true;
        originalHandleItemSelectRef.current(theme.id);
      }
    }
  }, [loadedThemes, selectedGroupId, themes]);

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
        themeData.translatableContent.forEach((item: any) => {
          const translation = cachedTranslations.find((t: any) => t.key === item.key);
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
    const data = translationFetcher.data as any;
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
          themeData.translatableContent.forEach((item: any) => {
            const translation = translations.find((t: any) => t.key === item.key);
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
  const processedSaveRef = useRef<any>(null);

  // Update loadedThemes cache after successful save (so changes persist on reload)
  useEffect(() => {
    if (!fetcher.data || typeof fetcher.data !== 'object') return;
    if (!('success' in fetcher.data) || !fetcher.data.success) return;

    // Only process content update saves, not translations or AI responses
    if ('translatedValue' in fetcher.data || 'generatedContent' in fetcher.data || 'translations' in fetcher.data) return;

    // Skip if already processed
    if (processedSaveRef.current === fetcher.data) return;
    processedSaveRef.current = fetcher.data;

    // Update the cached loadedThemes with current editable values
    if (selectedGroupId && loadedThemes[selectedGroupId] && editor.state.currentLanguage === primaryLocale) {
      const currentValues = editor.state.editableValues;
      const themeData = loadedThemes[selectedGroupId];

      if (themeData.translatableContent && Array.isArray(themeData.translatableContent)) {
        // Create updated translatableContent with new values
        const updatedContent = themeData.translatableContent.map((item: any) => {
          if (currentValues[item.key] !== undefined) {
            return { ...item, value: currentValues[item.key] };
          }
          return item;
        });

        // Update the cache
        setLoadedThemes(prev => ({
          ...prev,
          [selectedGroupId]: {
            ...prev[selectedGroupId],
            translatableContent: updatedContent
          }
        }));
      }
    }
  }, [fetcher.data, selectedGroupId, loadedThemes, editor.state.editableValues, editor.state.currentLanguage, primaryLocale]);

  // Handle response messages - NOTE: Success messages are handled by useUnifiedContentEditor hook
  // Only show error messages here to avoid duplicates
  useEffect(() => {
    if (fetcher.data && typeof fetcher.data === 'object') {
      if ('error' in fetcher.data && !fetcher.data.success) {
        showInfoBox(
          (fetcher.data as any).error,
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
    <>
      <MainNavigation />
      <ContentTypeNavigation />
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
      />
    </>
  );
}
