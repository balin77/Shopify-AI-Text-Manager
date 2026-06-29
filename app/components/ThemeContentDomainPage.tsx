/**
 * ThemeContentDomainPage — shared editor page for every ThemeContent-backed
 * rubric (Templates / System / Online-Store-Extras / Selling-Plans).
 *
 * Extracted verbatim from the original Templates page so all rubrics share one
 * implementation. Parameterised by:
 *   - data            loader data ({ themes, shop, shopLocales, primaryLocale, error })
 *   - config          ContentEditorConfig (dynamic-field config per rubric)
 *   - apiBasePath     lazy-load API base, e.g. "/api/templates" or
 *                     "/api/theme-content/system"
 *   - planContentType ContentType used by the PlanAccessGate
 *
 * The page's own fetchers POST to the host route's action (built via
 * makeThemeContentRouteAction); direct fetches hit `apiBasePath`.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useFetcher, useRevalidator } from "@remix-run/react";
import { Banner } from "@shopify/polaris";
import { UnifiedContentEditor } from "./UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { PlanAccessGate } from "./PlanAccessGate";
import type { FetcherData, TranslatableContentItem, ContentEditorConfig, ShopLocale } from "~/types/content-editor.types";
import type { ContentType } from "~/config/plans";
import type { TranslatableField } from "~/actions/templates/shared";
import type { ThemeNavItem, ThemeTranslationRecord } from "~/types/theme-content-domain";

interface ThemeContentDomainPageProps {
  data: {
    themes: ThemeNavItem[];
    shop: string;
    shopLocales: ShopLocale[];
    primaryLocale: string;
    error?: string | null;
  };
  config: ContentEditorConfig;
  apiBasePath: string;
  planContentType: ContentType;
  /**
   * Optional Shopify resource-type scope. The Theme rubric splits the single
   * "theme" domain into several tabs by resource type; each tab passes its
   * type(s) so the shared lazy-load endpoint returns only that tab's rows
   * (key-pattern groupIds are not unique across resource types). Sent as
   * repeatable `rt` query params (GET) / form fields (POST).
   */
  resourceTypes?: string[];
  /**
   * Optional informational banner rendered above the editor (e.g. a pointer to
   * related content that lives in another rubric).
   */
  infoBanner?: React.ReactNode;
}

export function ThemeContentDomainPage({ data, config, apiBasePath, planContentType, resourceTypes, infoBanner }: ThemeContentDomainPageProps) {
  const { themes, shop, shopLocales: loaderShopLocales, primaryLocale, error } = data;
  const fetcher = useFetcher<FetcherData>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Append the tab's resource-type scope to lazy-load requests. `rt` is
  // repeatable so multi-type tabs (e.g. Theme-Standardinhalte) work too.
  const rtQuerySuffix = useMemo(
    () => (resourceTypes ?? []).map((rt) => `&rt=${encodeURIComponent(rt)}`).join(""),
    [resourceTypes]
  );
  const appendResourceTypes = useCallback(
    (formData: FormData) => {
      for (const rt of resourceTypes ?? []) formData.append("rt", rt);
    },
    [resourceTypes]
  );

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
        appendResourceTypes(formData);

        const response = await fetch(`${apiBasePath}/${groupId}`, {
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
  }, [loaderShopLocales, apiBasePath, appendResourceTypes]);

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

      const response = await fetch(`${apiBasePath}/${groupId}?${params}${rtQuerySuffix}`);
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
  }, [loadedThemes, fieldPagination, showInfoBox, t, preloadAllTranslations, apiBasePath, rtQuerySuffix]);

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
    config: config,
    items: items as unknown as TranslatableContentItem[],
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

        fetch(`${apiBasePath}/${theme.groupId}?${params}${rtQuerySuffix}`)
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
            showInfoBox(t.content?.errorLoadingThemeContent || "Error loading theme content", "critical", t.content?.error || "Error");
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

      const res = await fetch(`${apiBasePath}/${groupId}?${params}${rtQuerySuffix}`);
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
        appendResourceTypes(formData);

        const transResponse = await fetch(`${apiBasePath}/${groupId}`, {
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
  }, [revalidator.state, primaryLocale, preloadAllTranslations, apiBasePath, rtQuerySuffix, appendResourceTypes]);

  // NOTE: All fetcher error handling (save errors, translateAll errors, errorKey responses)
  // is handled by useUnifiedContentEditor's catch-all error effect. No duplicate handler needed here.

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.content?.error || "Error");
    }
  }, [error, showInfoBox, t]);

  const selectedEmbedTechnical =
    !!selectedGroupId && themes.some((item: ThemeNavItem) => item.groupId === selectedGroupId && item.embedTechnical);

  return (
    <PlanAccessGate contentType={planContentType}>
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {infoBanner && (
          <div style={{ padding: "0.5rem 1rem 0" }}>{infoBanner}</div>
        )}
        {selectedEmbedTechnical && (
          <div style={{ padding: "0.5rem 1rem 0" }}>
            <Banner tone="warning" title={t.content?.appEmbedWarningTitle || "Technical content"}>
              {t.content?.appEmbedWarning ||
                "This is app-embed content (mostly CSS selectors and configuration). Translating it may break the embed on your storefront."}
            </Banner>
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={config}
          items={items as unknown as TranslatableContentItem[]}
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
    </div>
    </PlanAccessGate>
  );
}
