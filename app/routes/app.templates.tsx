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

        const settings = await db.aISettings.findUnique({
          where: { shop: session.shop }
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
          }
        );

        const prompt = `Improve or generate content for this field: ${fieldType}
Current value: ${currentValue}
Context: ${firstGroup.groupName}
Language: ${mainLanguage}

Please provide improved content that is clear and concise.`;

        const generatedContent = await aiService['askAI'](prompt);

        return json({
          success: true,
          generatedContent,
          fieldType
        });
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

        const settings = await db.aISettings.findUnique({
          where: { shop: session.shop }
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
          }
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

        return json({
          success: true,
          translatedValue,
          fieldType,
          targetLocale
        });
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

        const settings = await db.aISettings.findUnique({
          where: { shop: session.shop }
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
          }
        );

        const primaryLocale = formData.get("primaryLocale") as string || "de";

        // Translate to all target locales
        const translations: Record<string, Record<string, string>> = {};

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
            } catch (error) {
              console.error(`Error translating field ${key}:`, error);
              translations[locale][key] = item.value;
            }
          }
        }

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
      }

      case "updateContent": {
        const locale = formData.get("locale") as string;
        const primaryLocale = formData.get("primaryLocale") as string;

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

  // Load theme data on demand (for initial load)
  const loadThemeData = useCallback(async (groupId: string) => {
    if (loadedThemes[groupId]) return;

    setIsLoading(true);
    try {
      const response = await fetch(`/api/templates/${groupId}`);
      if (!response.ok) throw new Error('Failed to load theme data');

      const data = await response.json();
      setLoadedThemes(prev => ({
        ...prev,
        [groupId]: data.theme
      }));
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
  }, [loadedThemes, showInfoBox, t]);

  // Load translations for a specific locale
  const loadTranslationsForLocale = useCallback(async (groupId: string, locale: string) => {
    // Skip if already loaded or if it's the primary locale (primary uses translatableContent)
    if (loadedTranslations[groupId]?.[locale] || locale === primaryLocale) {
      return;
    }

    try {
      const formData = new FormData();
      formData.append("action", "loadTranslations");
      formData.append("itemId", `group_${groupId}`);
      formData.append("locale", locale);

      const response = await fetch(`/app/templates`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();
      if (data.success && data.translations) {
        setLoadedTranslations(prev => ({
          ...prev,
          [groupId]: {
            ...(prev[groupId] || {}),
            [locale]: data.translations,
          }
        }));
      }
    } catch (error) {
      console.error('Error loading translations:', error);
    }
  }, [loadedTranslations, primaryLocale]);

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

  // Store original handler reference before overriding
  const originalHandleItemSelectRef = useRef(editor.handlers.handleItemSelect);
  originalHandleItemSelectRef.current = editor.handlers.handleItemSelect;

  // Override item select handler to load data first
  editor.handlers.handleItemSelect = (itemId: string) => {
    const theme = themes.find((t: any) => t.id === itemId);
    if (theme) {
      setSelectedGroupId(theme.groupId);

      // If already loaded, just select
      if (loadedThemes[theme.groupId]) {
        originalHandleItemSelectRef.current(itemId);
      } else {
        // Load data, then select
        setIsLoading(true);
        fetch(`/api/templates/${theme.groupId}`)
          .then(response => response.json())
          .then(data => {
            setLoadedThemes(prev => ({
              ...prev,
              [theme.groupId]: data.theme
            }));
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

  // Load translations when language changes
  useEffect(() => {
    const currentLanguage = editor.state.currentLanguage;
    if (selectedGroupId && currentLanguage && currentLanguage !== primaryLocale) {
      loadTranslationsForLocale(selectedGroupId, currentLanguage);
    }
  }, [editor.state.currentLanguage, selectedGroupId, primaryLocale, loadTranslationsForLocale]);

  // Update editable values when translations are loaded for the current language
  useEffect(() => {
    const currentLanguage = editor.state.currentLanguage;
    if (!selectedGroupId || !currentLanguage || currentLanguage === primaryLocale) return;

    const translations = loadedTranslations[selectedGroupId]?.[currentLanguage];
    if (!translations || translations.length === 0) return;

    // Get the loaded theme data for field definitions
    const themeData = loadedThemes[selectedGroupId];
    if (!themeData?.translatableContent) return;

    // Update editable values with loaded translations
    for (const translation of translations) {
      const currentValue = editor.helpers.getEditableValue(translation.key);
      // Only update if the value is different (avoid loops)
      if (currentValue !== translation.value) {
        editor.helpers.setEditableValue(translation.key, translation.value);
      }
    }
  }, [loadedTranslations, selectedGroupId, editor.state.currentLanguage, primaryLocale, loadedThemes, editor.helpers]);

  // Handle response messages
  useEffect(() => {
    if (fetcher.data && typeof fetcher.data === 'object') {
      if ('success' in fetcher.data && fetcher.data.success) {
        // Don't show message for translation responses (they have their own)
        if (!('translatedValue' in fetcher.data) && !('generatedContent' in fetcher.data) && !('translations' in fetcher.data)) {
          showInfoBox(
            t.content?.changesSaved || "Changes saved successfully!",
            "success",
            t.content?.success || "Success"
          );
        }
      } else if ('error' in fetcher.data) {
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
      />
    </>
  );
}
