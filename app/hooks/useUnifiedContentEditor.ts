/**
 * Unified Content Editor Hook
 *
 * Based on the products page implementation with all bug fixes.
 * Provides a complete state management and handler system for content editing.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRevalidator } from "@remix-run/react";
import { useNavigationGuard, useChangeTracking, getTranslatedValue } from "../utils/contentEditor.utils";
import type {
  UseContentEditorProps,
  UseContentEditorReturn,
  EditorState,
  EditorHandlers,
} from "../types/content-editor.types";

export function useUnifiedContentEditor(props: UseContentEditorProps): UseContentEditorReturn {
  const { config, items, shopLocales, primaryLocale, fetcher, showInfoBox, t } = props;
  const revalidator = useRevalidator();

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [editableValues, setEditableValues] = useState<Record<string, string>>({});
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [htmlModes, setHtmlModes] = useState<Record<string, 'html' | 'rendered'>>({});
  const [enabledLanguages, setEnabledLanguages] = useState<string[]>(
    shopLocales.map((l: any) => l.locale)
  );
  // Track if we're in the middle of an accept-and-translate flow to prevent immediate deletion
  const [isAcceptAndTranslateFlow, setIsAcceptAndTranslateFlow] = useState(false);
  // Track if we're currently loading data to prevent false change detection
  // Initialize to true if an item is selected to prevent race condition
  const [isLoadingData, setIsLoadingData] = useState(!!selectedItemId);
  // Track when initial data is ready (used to prevent field flash on load)
  const [isInitialDataReady, setIsInitialDataReady] = useState(false);
  // Track if clear all confirmation modal is open
  const [isClearAllModalOpen, setIsClearAllModalOpen] = useState(false);

  // Alt-text state for images (indexed by image position)
  const [imageAltTexts, setImageAltTexts] = useState<Record<number, string>>({});
  const [altTextSuggestions, setAltTextSuggestions] = useState<Record<number, string>>({});
  // Track original alt-texts to detect changes (using state to trigger re-renders)
  const [originalAltTexts, setOriginalAltTexts] = useState<Record<number, string>>({});
  // Ref to access imageAltTexts in effects without adding as dependency
  const imageAltTextsRef = useRef<Record<number, string>>({});
  imageAltTextsRef.current = imageAltTexts;

  // Track pending auto-save for alt-texts (set by bulk generation and translation effects)
  const pendingAltTextAutoSaveRef = useRef<Record<number, string> | null>(null);

  // Retry mechanism for empty fields
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 300;

  // Track deleted translation keys - these should not be shown even if revalidation brings them back temporarily
  const deletedTranslationKeysRef = useRef<Set<string>>(new Set());

  // IMPORTANT: Memoize selectedItem to prevent infinite re-renders
  // Without this, items.find() returns a new object reference on every revalidation,
  // which triggers useChangeTracking and other effects, causing an infinite loop
  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId),
    [items, selectedItemId]
  );

  // Compute effective field definitions (supports dynamic fields for templates)
  const effectiveFieldDefinitions = useMemo(() => {
    if (config.dynamicFields && config.getFieldDefinitions && selectedItem) {
      return config.getFieldDefinitions(selectedItem);
    }
    return config.fieldDefinitions;
  }, [config.dynamicFields, config.getFieldDefinitions, config.fieldDefinitions, selectedItem]);

  // Navigation guard
  const {
    pendingNavigation,
    highlightSaveButton,
    saveButtonRef,
    handleNavigationAttempt,
    clearPendingNavigation,
  } = useNavigationGuard();

  // Change tracking - only track changes if we're not currently loading data
  const hasFieldChanges = useChangeTracking(
    isLoadingData ? null : (selectedItem || null), // Pass null while loading to prevent false change detection
    currentLanguage,
    primaryLocale,
    editableValues as any, // TODO: Fix type mismatch
    config.contentType
  );

  // Check for alt-text changes
  const hasAltTextChanges = useMemo(() => {
    const originalKeys = Object.keys(originalAltTexts);
    const currentKeys = Object.keys(imageAltTexts);

    // If no alt-texts at all, no changes
    if (originalKeys.length === 0 && currentKeys.length === 0) return false;

    // Check if any values differ
    // Important: Don't use || "" fallback - we need to distinguish undefined from ""
    const allKeys = new Set([...originalKeys, ...currentKeys]);
    for (const key of allKeys) {
      const numKey = Number(key);
      const original = originalAltTexts[numKey];
      const current = imageAltTexts[numKey];
      // undefined !== "" should return true (user cleared the field)
      if (original !== current) return true;
    }
    return false;
  }, [imageAltTexts, originalAltTexts]);

  // Combined hasChanges
  const hasChanges = hasFieldChanges || hasAltTextChanges;

  // ============================================================================
  // LOAD ITEM DATA (when item or language changes)
  // ============================================================================

  // Track previous selectedItemId to detect actual item changes vs revalidation
  const prevSelectedItemIdRef = useRef<string | null>(null);
  const prevCurrentLanguageRef = useRef<string>(currentLanguage);

  // Ref to access selectedItem without adding it to effect dependencies
  // This prevents the effect from re-running when selectedItem reference changes
  const selectedItemRef = useRef(selectedItem);
  selectedItemRef.current = selectedItem;

  useEffect(() => {
    const item = selectedItemRef.current;
    if (!item) {
      if (isLoadingData) setIsLoadingData(false);
      return;
    }

    // Only reload data if:
    // 1. The item ID actually changed (user selected a different item)
    // 2. The language changed (user switched languages)
    const itemIdChanged = prevSelectedItemIdRef.current !== selectedItemId;
    const languageChanged = prevCurrentLanguageRef.current !== currentLanguage;

    if (!itemIdChanged && !languageChanged) {
      // Don't log on skip to reduce console spam
      return;
    }

    // Update refs
    prevSelectedItemIdRef.current = selectedItemId;
    prevCurrentLanguageRef.current = currentLanguage;

    // Mark as loading immediately
    setIsLoadingData(true);

    // Reset accept-and-translate flag when changing items or languages
    setIsAcceptAndTranslateFlow(false);

    // Reset retry count when changing languages (to allow fresh retries)
    if (languageChanged) {
      retryCountRef.current = 0;
    }

    // Clear deleted translation keys and processed response refs when switching to a different item
    if (itemIdChanged) {
      deletedTranslationKeysRef.current.clear();
      processedSaveResponseRef.current = null;
      processedResponseRef.current = null;
      processedTranslateFieldRef.current = null;
      retryCountRef.current = 0; // Reset retry count for new item
      setIsInitialDataReady(false); // Reset data ready flag for new item
      console.log('[DATA-LOAD] Cleared refs for new item');
    }

    const newValues: Record<string, string> = {};

    if (currentLanguage === primaryLocale) {
      // Load primary locale values
      effectiveFieldDefinitions.forEach((field) => {
        newValues[field.key] = getItemFieldValue(item, field.key, primaryLocale, config);
      });
    } else {
      // Load translated values
      effectiveFieldDefinitions.forEach((field) => {
        // Check if this translation key was deleted - if so, show empty field
        if (deletedTranslationKeysRef.current.has(field.translationKey)) {
          console.log('[DATA-LOAD] Skipping deleted translation key:', field.translationKey);
          newValues[field.key] = "";
          return;
        }

        const translatedValue = getTranslatedValue(
          item,
          field.translationKey,
          currentLanguage,
          "",
          primaryLocale
        );
        newValues[field.key] = translatedValue;
      });
    }

    setEditableValues(newValues);
    // IMPORTANT: Only depend on selectedItemId, not selectedItem, to prevent re-runs on reference changes
  }, [selectedItemId, currentLanguage, effectiveFieldDefinitions, primaryLocale, config]);

  // Mark loading as complete after editableValues have been updated
  // This is in a separate useEffect to ensure the state update has completed
  useEffect(() => {
    if (selectedItemId && isLoadingData) {
      // Use longer timeout to ensure React render cycle is complete
      // This prevents the yellow "untranslated" flash on initial load
      const timer = setTimeout(() => {
        setIsLoadingData(false);
        setIsInitialDataReady(true);
      }, 50);
      return () => clearTimeout(timer);
    }
    // Use selectedItemId instead of selectedItem to prevent re-runs on reference changes
  }, [editableValues, selectedItemId, isLoadingData]);

  // Retry mechanism: If all fields are empty but item has data, retry loading
  useEffect(() => {
    const item = selectedItemRef.current;
    if (!item || !selectedItemId || isLoadingData) return;

    // Check if we have field definitions
    if (effectiveFieldDefinitions.length === 0) return;

    // Check if ALL editable values are empty
    const allValuesEmpty = Object.values(editableValues).every(v => !v || v === "");
    if (!allValuesEmpty) {
      // Values loaded successfully, reset retry count
      retryCountRef.current = 0;
      return;
    }

    // Check if item should have data
    let itemHasData = false;

    if (currentLanguage === primaryLocale) {
      // Primary locale: check if item has any data to load
      itemHasData = effectiveFieldDefinitions.some(field => {
        const value = getItemFieldValue(item, field.key, primaryLocale, config);
        return value && value.length > 0;
      });
    } else {
      // Foreign locale: check if item has any translations for this locale
      itemHasData = effectiveFieldDefinitions.some(field => {
        const translatedValue = getTranslatedValue(
          item,
          field.translationKey,
          currentLanguage,
          "",
          primaryLocale
        );
        return translatedValue && translatedValue.length > 0;
      });
    }

    // If item has data but values are empty, and we haven't exceeded retries, try again
    if (itemHasData && retryCountRef.current < MAX_RETRIES) {
      retryCountRef.current += 1;
      console.log(`[RETRY] Fields empty but item has data. Retry ${retryCountRef.current}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms`);

      const timer = setTimeout(() => {
        // Trigger a re-load by briefly changing refs to force the main load effect to run
        const newValues: Record<string, string> = {};

        if (currentLanguage === primaryLocale) {
          effectiveFieldDefinitions.forEach((field) => {
            newValues[field.key] = getItemFieldValue(item, field.key, primaryLocale, config);
          });
        } else {
          effectiveFieldDefinitions.forEach((field) => {
            if (deletedTranslationKeysRef.current.has(field.translationKey)) {
              newValues[field.key] = "";
              return;
            }
            const translatedValue = getTranslatedValue(
              item,
              field.translationKey,
              currentLanguage,
              "",
              primaryLocale
            );
            newValues[field.key] = translatedValue;
          });
        }

        console.log(`[RETRY] Reloaded values:`, Object.keys(newValues).length, 'fields');
        setEditableValues(newValues);
      }, RETRY_DELAY_MS);

      return () => clearTimeout(timer);
    }
  }, [editableValues, selectedItemId, isLoadingData, currentLanguage, primaryLocale, effectiveFieldDefinitions, config]);

  // ============================================================================
  // AUTO-SAVE FUNCTION (defined early for use in response handlers)
  // ============================================================================

  // Use a ref for fetcher to avoid dependency changes causing infinite loops
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Safe submit helper that catches AbortError from Shopify admin interference
  // The AbortError can occur when Shopify admin's own requests interfere with ours,
  // but the submit usually still works, so we just log and ignore the error
  // IMPORTANT: Uses fetcherRef to avoid dependency on fetcher which changes frequently
  const safeSubmit = useCallback((data: Record<string, any>, options?: { method: string }) => {
    try {
      fetcherRef.current.submit(data, options || { method: "POST" });
    } catch (error) {
      // AbortError can be thrown when Shopify admin interferes, but data is usually saved
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('[SAFE-SUBMIT] AbortError caught (data likely saved):', error.message);
      } else {
        // Re-throw non-AbortError errors
        throw error;
      }
    }
  }, []); // Empty deps - stable reference using fetcherRef

  // Helper function to get which fields have changed compared to the original item
  const getChangedFields = useCallback((valuesToCheck: Record<string, string>): string[] => {
    const item = selectedItemRef.current;
    if (!item) return [];

    const changedFields: string[] = [];
    effectiveFieldDefinitions.forEach((field) => {
      const currentValue = valuesToCheck[field.key] || "";
      const originalValue = getItemFieldValue(item, field.key, primaryLocale, config);

      if (currentValue !== originalValue) {
        changedFields.push(field.key);
      }
    });

    return changedFields;
  }, [effectiveFieldDefinitions, primaryLocale, config]);

  // Helper function to get which alt-text indices have changed compared to the original item
  const getChangedAltTextIndices = useCallback((): number[] => {
    const item = selectedItemRef.current;
    if (!item || !item.images) return [];

    const changedIndices: number[] = [];
    for (const [indexStr, currentValue] of Object.entries(imageAltTextsRef.current)) {
      const index = parseInt(indexStr);
      const originalValue = item.images[index]?.altText || "";
      // Compare current value with original - if different, it's a change
      if (currentValue !== originalValue) {
        changedIndices.push(index);
      }
    }

    return changedIndices;
  }, []);

  // Internal save function that saves with specific values (for auto-save after AI acceptance/translation)
  const performAutoSave = useCallback((valuesToSave: Record<string, string>, locale: string) => {
    if (!selectedItemId) return;

    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: locale,
      primaryLocale,
    };

    // Add all field values from the provided values
    effectiveFieldDefinitions.forEach((field) => {
      formDataObj[field.key] = valuesToSave[field.key] || "";
    });

    // Add image alt-texts if there are any changes
    if (Object.keys(imageAltTexts).length > 0) {
      formDataObj.imageAltTexts = JSON.stringify(imageAltTexts);
      console.log('[AUTO-SAVE] 🖼️ imageAltTexts being sent:', JSON.stringify(imageAltTexts));
    }

    // If saving primary locale, include changed fields for translation deletion
    const item = selectedItemRef.current;
    if (locale === primaryLocale && item) {
      const changedFields = getChangedFields(valuesToSave);
      if (changedFields.length > 0) {
        formDataObj.changedFields = JSON.stringify(changedFields);

        // Track deleted translation keys for immediate UI update
        // This ensures that even if revalidation brings back old data, we show empty fields
        changedFields.forEach((fieldKey) => {
          const field = effectiveFieldDefinitions.find(f => f.key === fieldKey);
          if (field?.translationKey) {
            deletedTranslationKeysRef.current.add(field.translationKey);
          }
        });
      }

      // Include changed alt-text indices for translation deletion
      const changedAltTextIndices = getChangedAltTextIndices();
      if (changedAltTextIndices.length > 0) {
        formDataObj.changedAltTextIndices = JSON.stringify(changedAltTextIndices);
        console.log('[AUTO-SAVE] Changed alt-text indices (translations will be deleted):', changedAltTextIndices);
      }
    }

    console.log('[AUTO-SAVE] Saving with values:', valuesToSave, 'locale:', locale);
    savedLocaleRef.current = locale; // Track which locale we're saving
    safeSubmit(formDataObj, { method: "POST" });
    clearPendingNavigation();
  }, [selectedItemId, primaryLocale, effectiveFieldDefinitions, imageAltTexts, clearPendingNavigation, getChangedFields, getChangedAltTextIndices, safeSubmit]);

  // ============================================================================
  // FETCHER RESPONSE HANDLERS (based on products implementation)
  // ============================================================================

  // Handle AI generation response
  useEffect(() => {
    if (fetcher.data?.success && 'generatedContent' in fetcher.data) {
      const fieldType = (fetcher.data as any).fieldType;
      setAiSuggestions((prev) => ({
        ...prev,
        [fieldType]: (fetcher.data as any).generatedContent,
      }));
    }
  }, [fetcher.data]);

  // Ref to track pending translation AFTER save completes (for Accept & Translate flow)
  // This ensures: 1. Save primary text first, 2. Then translate
  const pendingTranslationAfterSaveRef = useRef<{
    fieldKey: string;
    sourceText: string;
    targetLocales: string[];
    contextTitle: string;
    itemId: string;
  } | null>(null);

  // Ref to track which fetcher responses have been processed (prevents duplicate processing)
  const processedResponseRef = useRef<string | null>(null);

  // Ref to track the last fetcher.data object (to detect actual data changes vs dependency re-runs)
  const lastFetcherDataRef = useRef<any>(null);

  // Ref to track the locale that was active when the save was initiated
  const savedLocaleRef = useRef<string | null>(null);

  // Ref to skip the next data load (prevents overwriting after save/clear operations)
  const skipNextDataLoadRef = useRef(false);

  // Ref to store current editableValues for use in effects without causing loops
  const editableValuesRef = useRef(editableValues);
  useEffect(() => {
    editableValuesRef.current = editableValues;
  }, [editableValues]);

  // Ref to track processed translateField responses (prevents duplicate processing/infinite loops)
  const processedTranslateFieldRef = useRef<string | null>(null);

  // Ref to track processed save responses (prevents duplicate InfoBox/revalidation on re-renders)
  const processedSaveResponseRef = useRef<any>(null);

  // Handle translated field response (single field translation)
  // Auto-save immediately after receiving translation
  useEffect(() => {
    if (fetcher.data?.success && 'translatedValue' in fetcher.data) {
      const { fieldType, translatedValue, targetLocale } = fetcher.data as any;

      // Create a unique key for this response to prevent duplicate processing
      const responseKey = `translateField-${fieldType}-${targetLocale}-${translatedValue?.substring(0, 20)}`;
      if (processedTranslateFieldRef.current === responseKey) {
        return; // Already processed this response
      }
      processedTranslateFieldRef.current = responseKey;

      // Clear deleted key for this field since we now have a new translation
      const field = effectiveFieldDefinitions.find(f => f.key === fieldType);
      if (field?.translationKey && deletedTranslationKeysRef.current.has(field.translationKey)) {
        deletedTranslationKeysRef.current.delete(field.translationKey);
      }

      // Build new values with the translation (using ref to avoid dependency)
      const newValues: Record<string, string> = {
        ...editableValuesRef.current,
        [fieldType]: translatedValue,
      };

      // Update UI
      setEditableValues(newValues);

      // Update item.translations directly so hasChanges becomes false after save
      const item = selectedItemRef.current;
      if (item && field?.translationKey) {
        // Remove existing translation for this key and locale
        item.translations = item.translations.filter(
          (t: any) => !(t.locale === targetLocale && t.key === field.translationKey)
        );
        // Add new translation
        item.translations.push({
          key: field.translationKey,
          value: translatedValue,
          locale: targetLocale,
        });
      }

      // Auto-save the translation immediately

      // Build form data directly here to avoid dependency issues
      if (selectedItemId) {
        const formDataObj: Record<string, string> = {
          action: "updateContent",
          itemId: selectedItemId,
          locale: targetLocale,
          primaryLocale,
        };
        effectiveFieldDefinitions.forEach((field) => {
          formDataObj[field.key] = newValues[field.key] || "";
        });

        // Track which locale we're saving so the response handler knows
        savedLocaleRef.current = targetLocale;
        safeSubmit(formDataObj, { method: "POST" });
      }

      // Mark as loading to reset change detection after the save completes
      setIsLoadingData(true);
    }
  }, [fetcher.data, selectedItemId, primaryLocale, effectiveFieldDefinitions, safeSubmit]);

  // Handle single alt-text generation (show as suggestion)
  useEffect(() => {
    if (fetcher.data?.success && 'altText' in fetcher.data && 'imageIndex' in fetcher.data) {
      const { altText, imageIndex } = fetcher.data as any;
      setAltTextSuggestions(prev => ({
        ...prev,
        [imageIndex]: altText
      }));
    }
  }, [fetcher.data]);

  // Handle bulk alt-text generation (auto-accept all and auto-save)
  useEffect(() => {
    if (fetcher.data?.success && 'generatedAltTexts' in fetcher.data) {
      const { generatedAltTexts } = fetcher.data as any;
      console.log('[ALT-TEXT] Auto-accepting bulk generated alt-texts:', generatedAltTexts);

      // Merge with existing alt-texts
      const newAltTexts = {
        ...imageAltTexts,
        ...generatedAltTexts
      };

      setImageAltTexts(newAltTexts);
      // Set original to match so hasChanges = false after save
      setOriginalAltTexts(newAltTexts);
      // Schedule auto-save
      pendingAltTextAutoSaveRef.current = newAltTexts;
    }
  }, [fetcher.data]); // Note: imageAltTexts intentionally not in deps to avoid loops

  // Handle translated alt-text response (auto-save)
  useEffect(() => {
    if (fetcher.data?.success && 'translatedAltText' in fetcher.data) {
      const { translatedAltText, imageIndex } = fetcher.data as any;
      console.log('[ALT-TEXT] Setting translated alt-text for image', imageIndex, ':', translatedAltText);

      // Merge with existing alt-texts
      const newAltTexts = {
        ...imageAltTexts,
        [imageIndex]: translatedAltText
      };

      setImageAltTexts(newAltTexts);
      // Set original to match so hasChanges = false after save
      setOriginalAltTexts(newAltTexts);
      // Schedule auto-save
      pendingAltTextAutoSaveRef.current = newAltTexts;
    }
  }, [fetcher.data]); // Note: imageAltTexts intentionally not in deps to avoid loops

  // Handle translated alt-text to all locales response (show success message + revalidate)
  useEffect(() => {
    if (fetcher.data?.success && 'translatedAltTexts' in fetcher.data) {
      const { targetLocales, imageIndex } = fetcher.data as any;
      console.log('[ALT-TEXT] Translations to all locales completed for image', imageIndex);
      showInfoBox(
        t.content?.altTextTranslatedToAllLocales || `Alt-text for image ${imageIndex + 1} translated to ${targetLocales.length} languages`,
        "success",
        t.common?.success || "Success"
      );

      // Revalidate to fetch fresh data with the new translations
      if (revalidator.state === 'idle') {
        try {
          console.log('[ALT-TEXT] Triggering revalidation after translate to all locales');
          revalidator.revalidate();
        } catch (error) {
          console.log('[ALT-TEXT] Revalidation error (ignored):', error);
        }
      }
    }
  }, [fetcher.data, revalidator]);

  // Execute pending alt-text auto-save
  useEffect(() => {
    const pendingAltTexts = pendingAltTextAutoSaveRef.current;
    if (!pendingAltTexts || !selectedItemId) return;

    // Clear the pending save ref immediately to prevent re-execution
    pendingAltTextAutoSaveRef.current = null;

    console.log('[ALT-TEXT] Executing auto-save for alt-texts:', pendingAltTexts);

    // Skip next data load to prevent revalidation from overwriting
    skipNextDataLoadRef.current = true;

    // Build form data for save
    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };

    // Add all field values
    effectiveFieldDefinitions.forEach((field) => {
      formDataObj[field.key] = editableValues[field.key] || "";
    });

    // Add the alt-texts
    formDataObj.imageAltTexts = JSON.stringify(pendingAltTexts);

    savedLocaleRef.current = currentLanguage;
    safeSubmit(formDataObj, { method: "POST" });
  }, [imageAltTexts, selectedItemId, currentLanguage, primaryLocale, effectiveFieldDefinitions, editableValues, safeSubmit]);

  // Handle "translateFieldToAllLocales" response (from Accept & Translate)
  useEffect(() => {
    if (
      fetcher.data?.success &&
      'translations' in fetcher.data &&
      'fieldType' in fetcher.data &&
      !('locale' in fetcher.data)
    ) {
      const { translations, fieldType } = fetcher.data as any;

      // Create a unique key for this response to prevent duplicate processing
      const responseKey = `translateFieldToAllLocales-${fieldType}-${Object.keys(translations).join(',')}`;

      if (processedResponseRef.current === responseKey) {
        return; // Already processed this response
      }
      processedResponseRef.current = responseKey;

      // translations is Record<string, string> where key is locale and value is translated text
      const field = effectiveFieldDefinitions.find(f => f.key === fieldType);
      if (!field) return;

      const shopifyKey = field.translationKey;
      const item = selectedItemRef.current;

      if (item && shopifyKey) {
        // IMPORTANT: Clear this translation key from deleted set since we now have new translations
        // This ensures the DATA-LOAD effect will load the new translation when switching languages
        if (deletedTranslationKeysRef.current.has(shopifyKey)) {
          deletedTranslationKeysRef.current.delete(shopifyKey);
        }

        // Update item translations for all locales
        for (const [locale, translatedValue] of Object.entries(translations as Record<string, string>)) {
          // Remove existing translation for this key and locale
          item.translations = item.translations.filter(
            (t: any) => !(t.locale === locale && t.key === shopifyKey)
          );

          // Add new translation
          item.translations.push({
            key: shopifyKey,
            value: translatedValue,
            locale
          });
        }

        // If the current language is one of the translated languages, update editableValues immediately
        // This ensures the UI shows the new translation without needing to switch languages
        if (translations[currentLanguage]) {
          setEditableValues(prev => ({
            ...prev,
            [fieldType]: translations[currentLanguage]
          }));
        }

        showInfoBox(
          t.common?.fieldTranslatedToLanguages
            ?.replace("{fieldType}", fieldType)
            .replace("{count}", String(Object.keys(translations).length))
            || `${fieldType} translated to ${Object.keys(translations).length} language(s)`,
          "success",
          t.common?.success || "Success"
        );

        // Reset the accept-and-translate flow flag after translations are complete
        setIsAcceptAndTranslateFlow(false);

        // Mark as loading to reset change detection
        // DON'T revalidate here - it would overwrite our local changes to selectedItem.translations
        // The translations are already saved server-side by the action
        setIsLoadingData(true);
      }
    }
  }, [fetcher.data, effectiveFieldDefinitions, showInfoBox, t, currentLanguage]); // Include currentLanguage to access current value

  // Handle "translateAll" response (translates to ALL enabled locales)
  useEffect(() => {
    if (
      fetcher.data?.success &&
      'translations' in fetcher.data &&
      !('locale' in fetcher.data) &&
      !('fieldType' in fetcher.data) &&
      !('targetLocale' in fetcher.data)
    ) {
      const translations = (fetcher.data as any).translations;
      const item = selectedItemRef.current;
      if (item) {
        // Clear all deleted keys since we're translating all fields
        if (deletedTranslationKeysRef.current.size > 0) {
          console.log('[TRANSLATE-ALL] Clearing all deleted translation keys:', Array.from(deletedTranslationKeysRef.current));
          deletedTranslationKeysRef.current.clear();
        }

        for (const [locale, fields] of Object.entries(translations as any)) {
          const newTranslations: any[] = [];

          // Map fields to translations
          effectiveFieldDefinitions.forEach((fieldDef) => {
            const value = (fields as any)[fieldDef.key];
            if (value) {
              newTranslations.push({
                key: fieldDef.translationKey,
                value,
                locale,
              });
            }
          });

          // Store directly in item translations
          item.translations = [
            ...item.translations.filter((t: any) => t.locale !== locale),
            ...newTranslations,
          ];

          // If we're currently viewing this locale, update the editable fields
          if (currentLanguage === locale) {
            const updatedValues = { ...editableValues };
            effectiveFieldDefinitions.forEach((fieldDef) => {
              const value = (fields as any)[fieldDef.key];
              if (value) {
                updatedValues[fieldDef.key] = value;
              }
            });
            setEditableValues(updatedValues);
          }
        }
      }
    }
  }, [fetcher.data, currentLanguage, effectiveFieldDefinitions]); // Use selectedItemRef instead of selectedItem

  // Handle "translateAllForLocale" response (translates to ONE specific locale)
  useEffect(() => {
    if (
      fetcher.data?.success &&
      'translations' in fetcher.data &&
      'targetLocale' in fetcher.data &&
      !('fieldType' in fetcher.data)
    ) {
      const { translations, targetLocale } = fetcher.data as any;
      const item = selectedItemRef.current;
      if (item) {
        // Clear all deleted keys since we're translating all fields for this locale
        if (deletedTranslationKeysRef.current.size > 0) {
          console.log('[TRANSLATE-ALL-FOR-LOCALE] Clearing all deleted translation keys:', Array.from(deletedTranslationKeysRef.current));
          deletedTranslationKeysRef.current.clear();
        }

        const newTranslations: any[] = [];

        // Map fields to translations for the specific locale
        effectiveFieldDefinitions.forEach((fieldDef) => {
          const value = translations[fieldDef.key];
          if (value) {
            newTranslations.push({
              key: fieldDef.translationKey,
              value,
              locale: targetLocale,
            });
          }
        });

        // Store directly in item translations (replace existing for this locale)
        item.translations = [
          ...item.translations.filter((t: any) => t.locale !== targetLocale),
          ...newTranslations,
        ];

        // If we're currently viewing this locale, update the editable fields
        if (currentLanguage === targetLocale) {
          const updatedValues = { ...editableValues };
          effectiveFieldDefinitions.forEach((fieldDef) => {
            const value = translations[fieldDef.key];
            if (value) {
              updatedValues[fieldDef.key] = value;
            }
          });
          setEditableValues(updatedValues);
        }

        showInfoBox(
          t.common?.translatedSuccessfully || `Successfully translated to ${targetLocale}`,
          "success",
          t.common?.success || "Success"
        );
      }
    }
  }, [fetcher.data, currentLanguage, effectiveFieldDefinitions, showInfoBox, t]); // Use selectedItemRef instead of selectedItem

  // Update item object after saving (both primary locale and translations)
  // IMPORTANT: We track which fetcher.data we've processed to prevent re-running on language change
  useEffect(() => {
    const item = selectedItemRef.current;
    if (
      fetcher.data?.success &&
      !('translations' in fetcher.data) &&
      !('generatedContent' in fetcher.data) &&
      !('translatedValue' in fetcher.data) &&
      item
    ) {
      // Only process if fetcher.data has actually changed (not just a dependency re-run)
      if (fetcher.data === lastFetcherDataRef.current) {
        console.log('[SAVE-RESPONSE] Skipping - fetcher.data unchanged, only dependencies changed');
        return;
      }
      lastFetcherDataRef.current = fetcher.data;

      // Use the locale that was saved (tracked by savedLocaleRef), not the current language
      const savedLocale = savedLocaleRef.current;
      if (!savedLocale) {
        console.log('[SAVE-RESPONSE] No savedLocale tracked, skipping update');
        return;
      }

      console.log('[SAVE-RESPONSE] Processing save response for locale:', savedLocale);

      if (savedLocale === primaryLocale) {
        // This was a successful update action for primary locale
        // Update the item object directly with new values
        console.log('[SAVE-RESPONSE] Updating primary locale item values');
        effectiveFieldDefinitions.forEach((fieldDef) => {
          const value = editableValues[fieldDef.key];

          // Update based on field mapping
          if (fieldDef.key === 'title') {
            item.title = value || '';
          } else if (fieldDef.key === 'description') {
            item.descriptionHtml = value || '';
          } else if (fieldDef.key === 'body') {
            item.body = value || '';
          } else if (fieldDef.key === 'handle') {
            item.handle = value || '';
          } else if (fieldDef.key === 'seoTitle') {
            if (!item.seo) item.seo = {};
            item.seo.title = value || '';
          } else if (fieldDef.key === 'metaDescription') {
            if (!item.seo) item.seo = {};
            item.seo.description = value || '';
          }
        });

        // Update image alt-texts for primary locale
        if (item.images && Object.keys(imageAltTextsRef.current).length > 0) {
          for (const [indexStr, altText] of Object.entries(imageAltTextsRef.current)) {
            const index = parseInt(indexStr);
            if (item.images[index]) {
              item.images[index].altText = altText;
              console.log('[SAVE-RESPONSE] Updated primary alt-text for image', index);
            }
          }
        }
      } else {
        // This was a successful update action for a translation
        // Use the saved locale, not the current viewing language
        console.log('[SAVE-RESPONSE] Updating translation for saved locale:', savedLocale);
        const existingTranslations = item.translations.filter(
          (t: any) => t.locale !== savedLocale
        );

        // Add new translations for the saved locale
        effectiveFieldDefinitions.forEach((fieldDef) => {
          const value = editableValues[fieldDef.key];
          if (value) {
            existingTranslations.push({
              key: fieldDef.translationKey,
              value,
              locale: savedLocale,
            });
          }
        });

        item.translations = existingTranslations;

        // Update image alt-text translations for foreign locale
        if (item.images && Object.keys(imageAltTextsRef.current).length > 0) {
          for (const [indexStr, altText] of Object.entries(imageAltTextsRef.current)) {
            const index = parseInt(indexStr);
            if (item.images[index]) {
              // Initialize altTextTranslations array if it doesn't exist
              if (!item.images[index].altTextTranslations) {
                item.images[index].altTextTranslations = [];
              }
              // Remove existing translation for this locale
              item.images[index].altTextTranslations = item.images[index].altTextTranslations.filter(
                (t: any) => t.locale !== savedLocale
              );
              // Add new translation
              item.images[index].altTextTranslations.push({
                locale: savedLocale,
                altText: altText,
              });
              console.log('[SAVE-RESPONSE] Updated alt-text translation for image', index, 'locale:', savedLocale);
            }
          }
        }
      }

      // Update originalAltTexts immediately after saving to reset change detection
      // This is critical to make hasAltTextChanges = false after save
      setOriginalAltTexts({ ...imageAltTextsRef.current });
      console.log('[SAVE-RESPONSE] Updated originalAltTexts:', { ...imageAltTextsRef.current });

      // Clear the saved locale ref after processing
      savedLocaleRef.current = null;

      // Reset change detection after successful save
      // This ensures hasChanges becomes false after we've updated selectedItem
      setIsLoadingData(true);
    }
  }, [fetcher.data, primaryLocale, editableValues, effectiveFieldDefinitions]); // Removed selectedItem - use ref instead

  // Show global InfoBox for success/error messages and revalidate after save
  useEffect(() => {
    // Skip if this response was already processed (prevents duplicate processing on re-renders)
    if (fetcher.data === processedSaveResponseRef.current) {
      return;
    }

    if (
      fetcher.data?.success &&
      !(fetcher.data as any).generatedContent &&
      !(fetcher.data as any).translatedValue &&
      !(fetcher.data as any).translations // Skip revalidate for bulk operations, they handle it differently
    ) {
      // Mark this response as processed
      processedSaveResponseRef.current = fetcher.data;

      // Check if there's a pending translation to start after this save
      if (pendingTranslationAfterSaveRef.current) {
        const { fieldKey, sourceText, targetLocales, contextTitle, itemId } = pendingTranslationAfterSaveRef.current;
        pendingTranslationAfterSaveRef.current = null;

        console.log('[ACCEPT-AND-TRANSLATE] Save completed, now starting translation');

        // Start the translation (don't show "saved" message yet - will show after translation)
        safeSubmit({
          action: "translateFieldToAllLocales",
          itemId: itemId,
          fieldType: fieldKey,
          sourceText: sourceText,
          targetLocales: JSON.stringify(targetLocales),
          contextTitle: contextTitle
        }, { method: "POST" });

        // Don't revalidate yet - wait for translation to complete
        return;
      }

      showInfoBox(
        t.common?.changesSaved || "Changes saved successfully!",
        "success",
        t.common?.success || "Success"
      );

      // Update original alt-texts to match current values (so hasChanges becomes false)
      setOriginalAltTexts({ ...imageAltTextsRef.current });

      // Revalidate to fetch fresh data from the database after successful save
      // This ensures translations and all changes are reflected in the UI
      // Only revalidate if not already revalidating to prevent AbortError
      if (revalidator.state === 'idle') {
        try {
          revalidator.revalidate();
        } catch (error) {
          // Ignore AbortError from Shopify admin interference
          console.log('[REVALIDATE] Error during revalidation (ignored):', error);
        }
      }
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data) {
      // Also mark error responses as processed
      processedSaveResponseRef.current = fetcher.data;
      showInfoBox(fetcher.data.error as string, "critical", t.common?.error || "Error");
    }
  }, [fetcher.data, showInfoBox, t, revalidator, safeSubmit]);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  // Wrapper for performAutoSave with default locale
  const performSaveWithValues = (valuesToSave: Record<string, string>, locale: string = currentLanguage) => {
    performAutoSave(valuesToSave, locale);
  };

  const handleSave = () => {
    if (!selectedItemId || !hasChanges) return;

    // If we're saving in the primary locale, clear all translations for changed fields
    if (currentLanguage === primaryLocale && selectedItem) {
      effectiveFieldDefinitions.forEach((field) => {
        const currentValue = editableValues[field.key] || "";
        const originalValue = getItemFieldValue(selectedItem, field.key, primaryLocale, config);

        // Only clear translations if the value actually changed
        if (currentValue !== originalValue && field.translationKey) {
          const translationKey = field.translationKey;

          // Remove all translations for this field across all locales
          if (selectedItem.translations) {
            const beforeCount = selectedItem.translations.length;
            selectedItem.translations = selectedItem.translations.filter(
              (t: any) => t.key !== translationKey
            );
            const afterCount = selectedItem.translations.length;

            if (beforeCount !== afterCount) {
              console.log(`[TRANSLATION-CLEAR] Cleared translations for field "${field.key}" (key: ${translationKey})`);
            }
          }
        }
      });
    }

    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };

    // Add all field values
    effectiveFieldDefinitions.forEach((field) => {
      formDataObj[field.key] = editableValues[field.key] || "";
    });

    // Add image alt-texts if there are any changes
    if (Object.keys(imageAltTexts).length > 0) {
      formDataObj.imageAltTexts = JSON.stringify(imageAltTexts);
      console.log('[SAVE] 🖼️ imageAltTexts being sent:', JSON.stringify(imageAltTexts));
    }

    // If saving primary locale, include changed fields for server-side translation deletion
    if (currentLanguage === primaryLocale) {
      const changedFields = getChangedFields(editableValues);
      if (changedFields.length > 0) {
        formDataObj.changedFields = JSON.stringify(changedFields);
        console.log('[SAVE] Changed fields (translations will be deleted on server):', changedFields);
      }

      // Include changed alt-text indices for translation deletion
      const changedAltTextIndices = getChangedAltTextIndices();
      if (changedAltTextIndices.length > 0) {
        formDataObj.changedAltTextIndices = JSON.stringify(changedAltTextIndices);
        console.log('[SAVE] Changed alt-text indices (translations will be deleted):', changedAltTextIndices);
      }
    }

    // Skip next data load to prevent revalidation from overwriting user changes
    skipNextDataLoadRef.current = true;

    savedLocaleRef.current = currentLanguage; // Track which locale we're saving
    safeSubmit(formDataObj, { method: "POST" });
    clearPendingNavigation();
  };

  const handleDiscard = () => {
    if (!selectedItem) return;

    const newValues: Record<string, string> = {};

    if (currentLanguage === primaryLocale) {
      // Reset to primary locale values
      effectiveFieldDefinitions.forEach((field) => {
        newValues[field.key] = getItemFieldValue(selectedItem, field.key, primaryLocale, config);
      });
    } else {
      // Reset to translated values
      effectiveFieldDefinitions.forEach((field) => {
        const translatedValue = getTranslatedValue(
          selectedItem,
          field.translationKey,
          currentLanguage,
          "",
          primaryLocale
        );
        newValues[field.key] = translatedValue;
      });
    }

    setEditableValues(newValues);
    clearPendingNavigation();
  };

  const handleGenerateAI = (fieldKey: string) => {
    if (!selectedItemId) return;

    const currentValue = editableValues[fieldKey] || "";
    const contextTitle = editableValues.title || "";
    const contextDescription = editableValues.description || editableValues.body || "";
    const mainLanguage = shopLocales.find((l: any) => l.locale === primaryLocale)?.name || primaryLocale;

    safeSubmit(
      {
        action: "generateAIText",
        itemId: selectedItemId,
        fieldType: fieldKey,
        currentValue,
        contextTitle,
        contextDescription,
        mainLanguage,
      },
      { method: "POST" }
    );
  };

  const handleFormatAI = (fieldKey: string) => {
    if (!selectedItemId) return;

    const currentValue = editableValues[fieldKey] || "";
    if (!currentValue) {
      showInfoBox(
        t.common?.noContentToFormat || "No content available to format",
        "warning",
        t.common?.warning || "Warning"
      );
      return;
    }

    const contextTitle = editableValues.title || "";
    const contextDescription = editableValues.description || editableValues.body || "";
    const mainLanguage = shopLocales.find((l: any) => l.locale === primaryLocale)?.name || primaryLocale;

    safeSubmit(
      {
        action: "formatAIText",
        itemId: selectedItemId,
        fieldType: fieldKey,
        currentValue,
        contextTitle,
        contextDescription,
        mainLanguage,
      },
      { method: "POST" }
    );
  };

  const handleTranslateField = (fieldKey: string) => {
    if (!selectedItemId || !selectedItem) return;

    const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
    if (!field) return;

    const sourceText = getItemFieldValue(selectedItem, fieldKey, primaryLocale, config);
    if (!sourceText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    safeSubmit(
      {
        action: "translateField",
        itemId: selectedItemId,
        fieldType: fieldKey,
        sourceText,
        targetLocale: currentLanguage,
      },
      { method: "POST" }
    );
  };

  const handleTranslateFieldToAllLocales = (fieldKey: string) => {
    if (!selectedItemId || !selectedItem) return;

    // Filter out primary locale and disabled languages
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning",
        t.common?.warning || "Warning"
      );
      return;
    }

    const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
    if (!field) return;

    const sourceText = getItemFieldValue(selectedItem, fieldKey, primaryLocale, config);
    if (!sourceText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    const contextTitle = getItemFieldValue(selectedItem, 'title', primaryLocale, config) || selectedItem.id || "";

    safeSubmit(
      {
        action: "translateFieldToAllLocales",
        itemId: selectedItemId,
        fieldType: fieldKey,
        sourceText,
        targetLocales: JSON.stringify(targetLocales),
        contextTitle,
      },
      { method: "POST" }
    );
  };

  const handleTranslateAll = () => {
    if (!selectedItemId || !selectedItem) return;

    // Filter out primary locale and disabled languages
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning",
        t.common?.warning || "Warning"
      );
      return;
    }

    const formDataObj: Record<string, string> = {
      action: "translateAll",
      itemId: selectedItemId,
      targetLocales: JSON.stringify(targetLocales),
    };

    // Add all field values from primary locale
    effectiveFieldDefinitions.forEach((field) => {
      const value = getItemFieldValue(selectedItem, field.key, primaryLocale, config);
      if (value) {
        formDataObj[field.key] = value;
      }
    });

    safeSubmit(formDataObj, { method: "POST" });
  };

  const handleAcceptSuggestion = (fieldKey: string) => {
    const suggestion = aiSuggestions[fieldKey];
    if (!suggestion) return;

    // Force isLoadingData to false to ensure change detection works
    setIsLoadingData(false);

    // Create the new values with the accepted suggestion
    const newValues = {
      ...editableValues,
      [fieldKey]: suggestion,
    };

    // Update the UI state
    setEditableValues(newValues);

    setAiSuggestions((prev) => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldKey];
      return newSuggestions;
    });

    // Skip next data load to prevent revalidation from overwriting user changes
    skipNextDataLoadRef.current = true;

    // Auto-save immediately after accepting AI suggestion
    // IMPORTANT: Always save to primary locale since AI suggestions are generated for primary content
    performSaveWithValues(newValues, primaryLocale);
  };

  const handleAcceptAndTranslate = (fieldKey: string) => {
    const suggestion = aiSuggestions[fieldKey];
    if (!suggestion || !selectedItemId) return;

    // Reset processed response ref for new operation
    processedResponseRef.current = null;

    // Set flag to prevent translation deletion during this flow
    setIsAcceptAndTranslateFlow(true);

    // Create the new values with the accepted suggestion
    const newValues = {
      ...editableValues,
      [fieldKey]: suggestion,
    };

    // Accept the suggestion in the primary locale
    setEditableValues(newValues);

    setAiSuggestions((prev) => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldKey];
      return newSuggestions;
    });

    // Check target locales first
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesEnabled || "No target languages enabled",
        "warning",
        t.common?.warning || "Warning"
      );
      setIsAcceptAndTranslateFlow(false);
      // No translations needed, just save the primary text directly
      performSaveWithValues(newValues, primaryLocale);
      return;
    }

    // Get context title for translation
    const contextTitle = getItemFieldValue(selectedItem!, 'title', primaryLocale, config) || selectedItem!.id || "";

    // Step 1: Set up pending translation (will be triggered AFTER save completes)
    pendingTranslationAfterSaveRef.current = {
      fieldKey,
      sourceText: suggestion,
      targetLocales,
      contextTitle,
      itemId: selectedItemId
    };

    // Skip next data load to prevent revalidation from overwriting user changes
    skipNextDataLoadRef.current = true;

    // Step 2: Save the primary text first
    // After save completes, the useEffect will trigger the translation
    console.log('[ACCEPT-AND-TRANSLATE] Saving primary text first, then will translate');
    performSaveWithValues(newValues, primaryLocale);
  };

  const handleRejectSuggestion = (fieldKey: string) => {
    setAiSuggestions((prev) => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldKey];
      return newSuggestions;
    });
  };

  const handleLanguageChange = (locale: string) => {
    handleNavigationAttempt(() => setCurrentLanguage(locale), hasChanges);
  };

  const handleToggleLanguage = (locale: string) => {
    // Don't allow disabling the primary locale
    if (locale === primaryLocale) return;

    setEnabledLanguages((prev) => {
      if (prev.includes(locale)) {
        // Disable this language
        return prev.filter((l) => l !== locale);
      } else {
        // Enable this language
        return [...prev, locale];
      }
    });
  };

  const handleItemSelect = (itemId: string) => {
    handleNavigationAttempt(() => setSelectedItemId(itemId), hasChanges);
  };

  const handleValueChange = (fieldKey: string, value: string) => {
    // Force isLoadingData to false to ensure change detection works for manual changes
    setIsLoadingData(false);

    // Update the state immediately without any side effects
    // This ensures the input field responds instantly to user typing
    setEditableValues((prev) => ({
      ...prev,
      [fieldKey]: value,
    }));
  };

  const handleToggleHtmlMode = (fieldKey: string) => {
    setHtmlModes((prev) => ({
      ...prev,
      [fieldKey]: prev[fieldKey] === "html" ? "rendered" : "html",
    }));
  };

  const handleClearField = (fieldKey: string) => {
    // Force isLoadingData to false to ensure change detection works
    setIsLoadingData(false);

    // Clear the field value
    setEditableValues((prev) => ({
      ...prev,
      [fieldKey]: "",
    }));
  };

  const handleClearAllClick = () => {
    setIsClearAllModalOpen(true);
  };

  const handleClearAllConfirm = () => {
    // Force isLoadingData to false to ensure change detection works
    setIsLoadingData(false);

    // Clear all field values except title (title should never be empty in primary locale)
    const clearedValues: Record<string, string> = {};
    effectiveFieldDefinitions.forEach((field) => {
      if (field.key === "title") {
        // Keep the current title value
        clearedValues[field.key] = editableValues[field.key] || "";
      } else {
        // Clear all other fields
        clearedValues[field.key] = "";
      }
    });
    setEditableValues(clearedValues);

    // Close modal
    setIsClearAllModalOpen(false);
  };

  const handleClearAllCancel = () => {
    setIsClearAllModalOpen(false);
  };

  const handleClearAllForLocaleClick = () => {
    setIsClearAllModalOpen(true);
  };

  const handleClearAllForLocaleConfirm = () => {
    // Force isLoadingData to false to ensure change detection works
    setIsLoadingData(false);

    // Clear all field values for the current foreign language
    const clearedValues: Record<string, string> = {};
    effectiveFieldDefinitions.forEach((field) => {
      clearedValues[field.key] = "";
    });
    setEditableValues(clearedValues);

    // Close modal
    setIsClearAllModalOpen(false);
  };

  const handleTranslateAllForLocale = () => {
    if (!selectedItemId || !selectedItem || currentLanguage === primaryLocale) return;

    const formDataObj: Record<string, string> = {
      action: "translateAllForLocale",
      itemId: selectedItemId,
      targetLocale: currentLanguage,
    };

    // Add all field values from primary locale
    effectiveFieldDefinitions.forEach((field) => {
      const value = getItemFieldValue(selectedItem, field.key, primaryLocale, config);
      if (value) {
        formDataObj[field.key] = value;
      }
    });

    safeSubmit(formDataObj, { method: "POST" });
  };

  // ============================================================================
  // ALT-TEXT HANDLERS
  // ============================================================================

  const handleAltTextChange = (imageIndex: number, value: string) => {
    setImageAltTexts(prev => ({
      ...prev,
      [imageIndex]: value
    }));
  };

  const handleGenerateAltText = (imageIndex: number) => {
    if (!selectedItem || !selectedItem.images || !selectedItem.images[imageIndex]) return;

    const image = selectedItem.images[imageIndex];
    const productTitle = getItemFieldValue(selectedItem, 'title', primaryLocale, config);
    const mainLanguage = shopLocales.find((l: any) => l.locale === primaryLocale)?.name || primaryLocale;

    safeSubmit({
      action: "generateAltText",
      productId: selectedItem.id,
      imageIndex: String(imageIndex),
      imageUrl: image.url,
      productTitle,
      mainLanguage
    }, { method: "POST" });
  };

  const handleGenerateAllAltTexts = () => {
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

    const productTitle = getItemFieldValue(selectedItem, 'title', primaryLocale, config);
    const mainLanguage = shopLocales.find((l: any) => l.locale === primaryLocale)?.name || primaryLocale;
    const imagesData = selectedItem.images.map((img: any) => ({ url: img.url }));

    safeSubmit({
      action: "generateAllAltTexts",
      productId: selectedItem.id,
      productTitle,
      mainLanguage,
      imagesData: JSON.stringify(imagesData)
    }, { method: "POST" });
  };

  const handleTranslateAltText = (imageIndex: number) => {
    if (!selectedItem || !selectedItem.images || !selectedItem.images[imageIndex]) return;

    const image = selectedItem.images[imageIndex];
    const sourceAltText = image.altText || "";

    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    safeSubmit({
      action: "translateAltText",
      productId: selectedItem.id,
      imageIndex: String(imageIndex),
      sourceAltText,
      targetLocale: currentLanguage
    }, { method: "POST" });
  };

  const handleTranslateAltTextToAllLocales = (imageIndex: number) => {
    if (!selectedItem || !selectedItem.images || !selectedItem.images[imageIndex]) return;

    // Filter out primary locale and disabled languages
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning",
        t.common?.warning || "Warning"
      );
      return;
    }

    const image = selectedItem.images[imageIndex];
    const sourceAltText = imageAltTexts[imageIndex] || image.altText || "";

    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    safeSubmit({
      action: "translateAltTextToAllLocales",
      productId: selectedItem.id,
      imageIndex: String(imageIndex),
      sourceAltText,
      targetLocales: JSON.stringify(targetLocales)
    }, { method: "POST" });
  };

  const handleAcceptAltTextSuggestion = (imageIndex: number) => {
    const suggestion = altTextSuggestions[imageIndex];
    if (!suggestion || !selectedItemId) return;

    // Create the new alt-texts with the accepted suggestion
    const newAltTexts = {
      ...imageAltTexts,
      [imageIndex]: suggestion
    };

    // Update the UI state
    setImageAltTexts(newAltTexts);

    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });

    // Skip next data load to prevent revalidation from overwriting user changes
    skipNextDataLoadRef.current = true;

    // Auto-save immediately after accepting AI suggestion
    console.log('[ACCEPT-ALT-TEXT] Accepting AI suggestion for image:', imageIndex, 'auto-saving...');

    // Build form data for save
    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };

    // Add all field values
    effectiveFieldDefinitions.forEach((field) => {
      formDataObj[field.key] = editableValues[field.key] || "";
    });

    // Add the new image alt-texts
    formDataObj.imageAltTexts = JSON.stringify(newAltTexts);

    savedLocaleRef.current = currentLanguage;
    safeSubmit(formDataObj, { method: "POST" });

    // Update original alt-texts so hasChanges becomes false after save completes
    setOriginalAltTexts(newAltTexts);
  };

  const handleAcceptAndTranslateAltText = (imageIndex: number) => {
    const suggestion = altTextSuggestions[imageIndex];
    if (!suggestion || !selectedItemId) return;

    const item = selectedItemRef.current;
    if (!item) return;

    // Create the new alt-texts with the accepted suggestion
    const newAltTexts = {
      ...imageAltTexts,
      [imageIndex]: suggestion
    };

    // Update the UI state
    setImageAltTexts(newAltTexts);

    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });

    // Check target locales first
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesEnabled || "No target languages enabled",
        "warning",
        t.common?.warning || "Warning"
      );
      // No translations needed, just save the primary text directly
      const formDataObj: Record<string, string> = {
        action: "updateContent",
        itemId: selectedItemId,
        locale: primaryLocale,
        primaryLocale,
      };
      effectiveFieldDefinitions.forEach((field) => {
        formDataObj[field.key] = editableValues[field.key] || "";
      });
      formDataObj.imageAltTexts = JSON.stringify(newAltTexts);
      savedLocaleRef.current = primaryLocale;
      safeSubmit(formDataObj, { method: "POST" });
      setOriginalAltTexts(newAltTexts);
      return;
    }

    // Skip next data load to prevent revalidation from overwriting user changes
    skipNextDataLoadRef.current = true;

    console.log('[ACCEPT-AND-TRANSLATE-ALT-TEXT] Saving primary alt-text first, then will translate to all locales');

    // Step 1: Save the primary alt-text first
    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: primaryLocale,
      primaryLocale,
    };
    effectiveFieldDefinitions.forEach((field) => {
      formDataObj[field.key] = editableValues[field.key] || "";
    });
    formDataObj.imageAltTexts = JSON.stringify(newAltTexts);
    savedLocaleRef.current = primaryLocale;
    safeSubmit(formDataObj, { method: "POST" });
    setOriginalAltTexts(newAltTexts);

    // Step 2: Translate to all locales
    safeSubmit({
      action: "translateAltTextToAllLocales",
      productId: item.id,
      imageIndex: String(imageIndex),
      sourceAltText: suggestion,
      targetLocales: JSON.stringify(targetLocales)
    }, { method: "POST" });
  };

  const handleRejectAltTextSuggestion = (imageIndex: number) => {
    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });
  };

  // Reset alt-text state when product changes
  useEffect(() => {
    setImageAltTexts({});
    setAltTextSuggestions({});
    setOriginalAltTexts({});
  }, [selectedItemId]);

  // Load translated alt-texts when language changes
  useEffect(() => {
    const item = selectedItemRef.current;
    if (!item || !item.images) return;

    if (currentLanguage === primaryLocale) {
      // Reset to primary locale alt-texts
      setImageAltTexts({});
      setOriginalAltTexts({});
    } else {
      // Load translated alt-texts from DB
      const translatedAltTexts: Record<number, string> = {};
      item.images.forEach((img: any, index: number) => {
        const translation = img.altTextTranslations?.find(
          (t: any) => t.locale === currentLanguage
        );
        if (translation) {
          translatedAltTexts[index] = translation.altText;
        }
      });
      setImageAltTexts(translatedAltTexts);
      setOriginalAltTexts({ ...translatedAltTexts });
    }
  }, [currentLanguage, selectedItemId, primaryLocale]);

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  const getFieldBackgroundColor = (fieldKey: string): string => {
    const hasTranslation = selectedItem?.translations?.some(
      (t: any) => t.key === effectiveFieldDefinitions.find(f => f.key === fieldKey)?.translationKey && t.locale === currentLanguage
    );

    if (currentLanguage === primaryLocale) {
      return "transparent";
    }

    return hasTranslation ? "#f0f9ff" : "transparent";
  };

  const isFieldTranslated = (fieldKey: string): boolean => {
    if (!selectedItem) return false;
    const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
    if (!field) return false;

    return selectedItem.translations?.some(
      (t: any) => t.key === field.translationKey && t.locale === currentLanguage
    );
  };

  const getEditableValue = (fieldKey: string): string => {
    return editableValues[fieldKey] || "";
  };

  const setEditableValue = (fieldKey: string, value: string) => {
    handleValueChange(fieldKey, value);
  };

  // ============================================================================
  // RETURN
  // ============================================================================

  const state: EditorState = {
    selectedItemId,
    currentLanguage,
    editableValues,
    aiSuggestions,
    htmlModes,
    hasChanges,
    enabledLanguages,
    imageAltTexts,
    altTextSuggestions,
    isClearAllModalOpen,
    isInitialDataReady,
  };

  const handlers: EditorHandlers = {
    handleSave,
    handleDiscard,
    handleGenerateAI,
    handleFormatAI,
    handleTranslateField,
    handleTranslateFieldToAllLocales,
    handleTranslateAll,
    handleAcceptSuggestion,
    handleAcceptAndTranslate,
    handleRejectSuggestion,
    handleLanguageChange,
    handleToggleLanguage,
    handleItemSelect,
    handleValueChange,
    handleToggleHtmlMode,
    handleClearField,
    handleClearAllClick,
    handleClearAllConfirm,
    handleClearAllCancel,
    handleClearAllForLocaleClick,
    handleClearAllForLocaleConfirm,
    handleTranslateAllForLocale,
    handleAltTextChange,
    handleGenerateAltText,
    handleGenerateAllAltTexts,
    handleTranslateAltText,
    handleTranslateAltTextToAllLocales,
    handleAcceptAltTextSuggestion,
    handleAcceptAndTranslateAltText,
    handleRejectAltTextSuggestion,
  };

  return {
    state,
    handlers,
    selectedItem: selectedItem || null,
    navigationGuard: {
      pendingNavigation,
      highlightSaveButton,
      saveButtonRef,
      handleNavigationAttempt,
      clearPendingNavigation,
    },
    helpers: {
      getFieldBackgroundColor,
      isFieldTranslated,
      getEditableValue,
      setEditableValue,
    },
    // Dynamic field definitions (for templates and other dynamic content types)
    effectiveFieldDefinitions,
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get field value from item based on field key and primary locale
 * Supports both standard content types and templates with dynamic fields
 */
function getItemFieldValue(item: any, fieldKey: string, primaryLocale: string, config?: any): string {
  // Templates: Use custom getter if available or check translatableContent
  if (config?.getFieldValue) {
    return config.getFieldValue(item, fieldKey);
  }

  // Templates: Check translatableContent array
  if (item?.translatableContent && Array.isArray(item.translatableContent)) {
    const content = item.translatableContent.find((c: any) => c.key === fieldKey);
    return content?.value || "";
  }

  // Standard content types: Common field mappings
  const fieldMappings: Record<string, string> = {
    title: item.title || "",
    description: item.descriptionHtml || item.body || "",
    handle: item.handle || "",
    seoTitle: item.seo?.title || "",
    metaDescription: item.seo?.description || "",
    body: item.body || "",
  };

  return fieldMappings[fieldKey] || "";
}
