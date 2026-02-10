/**
 * Unified Content Editor Hook
 *
 * Based on the products page implementation with all bug fixes.
 * Provides a complete state management and handler system for content editing.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRevalidator, useFetcher } from "@remix-run/react";
import { useNavigationGuard, useChangeTracking, getTranslatedValue } from "../utils/contentEditor.utils";
import { useItemFocus } from "./useFocusManagement";
import type {
  UseContentEditorProps,
  UseContentEditorReturn,
  EditorState,
  EditorHandlers,
  Translation,
  AltTextTranslation,
  ShopLocale,
  ContentImage,
  TranslatableContentItem,
  ContentEditorConfig,
} from "../types/content-editor.types";
import { debugLog } from "../utils/debug";

/**
 * Translates server error messages to localized strings
 * Maps technical error messages from server to i18n translation keys
 */
function translateErrorMessage(errorMessage: string, t: any): string {
  if (!errorMessage) return t.errors?.unknownError || "Unknown error";

  const lowerError = errorMessage.toLowerCase();

  // Map common error patterns to translation keys
  if (lowerError.includes("invalid field type")) {
    return t.errors?.invalidFieldType || errorMessage;
  }
  if (lowerError.includes("no fields to translate")) {
    return t.errors?.noFieldsToTranslate || errorMessage;
  }
  if (lowerError.includes("no source text")) {
    return t.errors?.noSourceText || errorMessage;
  }
  if (lowerError.includes("unknown action")) {
    return t.errors?.unknownAction || errorMessage;
  }
  if (lowerError.includes("invalid url slug") || lowerError.includes("invalid handle") || lowerError.includes("alphanumeric character")) {
    return t.errors?.invalidUrlSlug || errorMessage;
  }
  if (lowerError.includes("network") || lowerError.includes("fetch")) {
    return t.errors?.networkError || errorMessage;
  }
  if (lowerError.includes("quota") || lowerError.includes("limit exceeded")) {
    return t.errors?.quotaExceeded || errorMessage;
  }
  if (lowerError.includes("rate limit") || lowerError.includes("too many requests")) {
    return t.errors?.rateLimitExceeded || errorMessage;
  }
  if (lowerError.includes("translation") && lowerError.includes("failed")) {
    return t.errors?.translationFailed || errorMessage;
  }
  if (lowerError.includes("generation") && lowerError.includes("failed")) {
    return t.errors?.generationFailed || errorMessage;
  }
  if (lowerError.includes("save") && lowerError.includes("failed")) {
    return t.errors?.saveFailed || errorMessage;
  }
  if (lowerError.includes("load") && lowerError.includes("failed")) {
    return t.errors?.loadFailed || errorMessage;
  }

  // If no specific translation found, return the original error message
  // (it might be a descriptive message that's already helpful)
  return errorMessage;
}

export function useUnifiedContentEditor(props: UseContentEditorProps): UseContentEditorReturn {
  const { config, items, shopLocales, primaryLocale, fetcher, showInfoBox, t, onTranslateToAllLocalesComplete } = props;
  const revalidator = useRevalidator();

  // DEBUG: Log hook execution on every render
  console.log('🎯 [HOOK] useUnifiedContentEditor render - fetcher.state:', fetcher.state, 'has data:', !!fetcher.data);

  // ============================================================================
  // FOCUS MANAGEMENT (Accessibility)
  // ============================================================================

  const { firstFieldRef, setItemFocus } = useItemFocus(null);

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [editableValues, setEditableValues] = useState<Record<string, string>>({});
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [htmlModes, setHtmlModes] = useState<Record<string, 'html' | 'rendered'>>({});
  const [enabledLanguages, setEnabledLanguages] = useState<string[]>(
    shopLocales.map((l) => l.locale)
  );
  // Track if we're in the middle of an accept-and-translate flow to prevent immediate deletion
  const [isAcceptAndTranslateFlow, setIsAcceptAndTranslateFlow] = useState(false);
  // Ref to access isAcceptAndTranslateFlow in memoized callbacks without adding as dependency
  const isAcceptAndTranslateFlowRef = useRef(false);
  isAcceptAndTranslateFlowRef.current = isAcceptAndTranslateFlow;
  // Track if we're currently loading data to prevent false change detection
  // Initialize to true if an item is selected to prevent race condition
  const [isLoadingData, setIsLoadingData] = useState(!!selectedItemId);
  // Track when initial data is ready (used to prevent field flash on load)
  const [isInitialDataReady, setIsInitialDataReady] = useState(false);
  // Track if clear all confirmation modal is open
  const [isClearAllModalOpen, setIsClearAllModalOpen] = useState(false);

  // On-demand images loading (for products - images are loaded from Shopify API)
  const [onDemandImages, setOnDemandImages] = useState<ContentImage[]>([]);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const imageFetcher = useFetcher<{ success: boolean; images: any[]; error?: string }>();
  const loadedImagesForProductRef = useRef<string | null>(null);

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

  // Track locally added translations from Accept & Translate flow
  // This is needed because item.translations mutations can be lost when items array is recreated
  // Format: Record<translationKey, Record<locale, value>>
  const localTranslationsRef = useRef<Record<string, Record<string, string>>>({});

  // Track original template values for change detection (templates use dynamic fields)
  const originalTemplateValuesRef = useRef<Record<string, string>>({});

  // Track which fields are showing fallback values (e.g., handle field showing primary locale value)
  // This happens when Shopify doesn't return a translation because it's identical to the primary value
  const [fallbackFields, setFallbackFields] = useState<Set<string>>(new Set());

  // Ref for fallbackFields to avoid stale closures in callbacks/effects
  const fallbackFieldsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    fallbackFieldsRef.current = fallbackFields;
  }, [fallbackFields]);

  // Track original loaded values for foreign locale change detection during save.
  // Problem: Previously ALL non-fallback fields were sent on every save, even unchanged ones.
  // If a handle translation existed (e.g. from translateAll), it was re-sent on every subsequent
  // save of any field, causing Shopify to reject with "handle already taken".
  // Solution: Store the values as loaded from the server, then only send fields where the
  // current value differs from the original. This way unchanged fields like handle are never re-sent.
  const originalLoadedValuesRef = useRef<Record<string, string>>({});

  // Track which fields have AI actions currently running (for per-field loading states)
  // This allows multiple AI actions to run in parallel on different fields
  const [loadingFieldKeys, setLoadingFieldKeys] = useState<Set<string>>(new Set());

  // Track if initial data load was successful - disables retry mechanism after successful load
  // Reset when item or language changes, allowing retry during new load cycles
  const initialLoadSuccessfulRef = useRef(false);

  // Cache of saved primary-locale values per item ID.
  // After a save, revalidation replaces the items array with new objects, losing any
  // in-memory mutations. This ref preserves the saved values so the data load effect
  // can use them instead of potentially stale item data from the server.
  // Cleared on manual reload (dataRefreshTrigger) or when server data matches.
  const savedPrimaryValuesRef = useRef<Record<string, Record<string, string>>>({});

  // Trigger for forcing data refresh (used by ReloadButton after revalidation)
  // When this counter increments, the data loading effect will re-run
  const [dataRefreshTrigger, setDataRefreshTrigger] = useState(0);

  // ============================================================================
  // AUTO-SELECT FIRST ITEM ON MOUNT
  // Automatically select the first item when the page loads
  // ============================================================================

  useEffect(() => {
    const firstItem = items[0];
    if (items.length > 0 && !selectedItemId && firstItem) {
      setSelectedItemId(firstItem.id);
    }
  }, [items, selectedItemId]);

  // ============================================================================
  // FOCUS MANAGEMENT - Set focus when item changes
  // ============================================================================

  useEffect(() => {
    if (selectedItemId && !isLoadingData) {
      // Set focus to first field when item is selected and data is ready
      setItemFocus();
    }
  }, [selectedItemId, isLoadingData, setItemFocus]);

  // IMPORTANT: Memoize selectedItem to prevent infinite re-renders
  // Without this, items.find() returns a new object reference on every revalidation,
  // which triggers useChangeTracking and other effects, causing an infinite loop
  const baseSelectedItem = useMemo(() => {
    const found = items.find((item) => item.id === selectedItemId);
    return found;
  }, [items, selectedItemId]);

  // Hybrid image loading:
  // - If images exist in DB -> use them directly (instant)
  // - If no images in DB -> load on-demand from Shopify API (fallback)
  const selectedItem = useMemo(() => {
    if (!baseSelectedItem) return undefined;

    // Check if DB has images for this product
    const hasDbImages = baseSelectedItem.images && baseSelectedItem.images.length > 0;

    // If DB has images, use them directly (instant loading)
    if (hasDbImages) {
      return baseSelectedItem;
    }

    // If no DB images but we have on-demand images loaded, use those
    if (onDemandImages.length > 0 && loadedImagesForProductRef.current === selectedItemId) {
      return {
        ...baseSelectedItem,
        images: onDemandImages,
      };
    }

    // No images available yet - return base item (on-demand loading will trigger)
    return baseSelectedItem;
  }, [baseSelectedItem, onDemandImages, selectedItemId]);

  // ============================================================================
  // ON-DEMAND IMAGE LOADING (hybrid fallback)
  // Only loads from Shopify API if no images in DB
  // ============================================================================

  // Track previous product ID to detect changes
  const prevSelectedItemIdRef = useRef<string | null>(null);

  // Trigger on-demand image loading only if DB has no images
  useEffect(() => {
    // Only for products content type
    if (config.contentType !== 'products') return;

    // Detect product change - clear on-demand state
    if (prevSelectedItemIdRef.current !== selectedItemId) {
      setOnDemandImages([]);
      loadedImagesForProductRef.current = null;
      prevSelectedItemIdRef.current = selectedItemId;
    }

    // Skip if no product selected
    if (!selectedItemId || !baseSelectedItem) {
      return;
    }

    // Skip if DB already has images (no need for on-demand loading)
    const hasDbImages = baseSelectedItem.images && baseSelectedItem.images.length > 0;
    if (hasDbImages) {
      return;
    }

    // Skip if already loaded for this product
    if (loadedImagesForProductRef.current === selectedItemId) {
      return;
    }

    // No DB images - load from Shopify API as fallback
    setIsLoadingImages(true);
    imageFetcher.load(`/api/product-images?productId=${encodeURIComponent(selectedItemId)}`);
  }, [selectedItemId, baseSelectedItem, config.contentType]);

  // Handle on-demand image fetcher response
  useEffect(() => {
    if (imageFetcher.state === "idle" && imageFetcher.data && selectedItemId) {
      setIsLoadingImages(false);

      // Only apply if still on the same product
      if (prevSelectedItemIdRef.current !== selectedItemId) {
        return;
      }

      if (imageFetcher.data.success && imageFetcher.data.images) {
        const images: ContentImage[] = imageFetcher.data.images.map((img: any) => ({
          url: img.url,
          altText: img.altText,
          altTextTranslations: [],
        }));

        setOnDemandImages(images);
        loadedImagesForProductRef.current = selectedItemId;
      } else if (imageFetcher.data.error) {
        loadedImagesForProductRef.current = selectedItemId;
      }
    }
  }, [imageFetcher.state, imageFetcher.data, selectedItemId]);

  // Compute effective field definitions (supports dynamic fields for templates)
  const effectiveFieldDefinitions = useMemo(() => {
    if (config.dynamicFields && config.getFieldDefinitions && selectedItem) {
      return config.getFieldDefinitions(selectedItem);
    }
    return config.fieldDefinitions;
  }, [config.dynamicFields, config.getFieldDefinitions, config.fieldDefinitions, selectedItem]);

  // Ref to store field definitions to avoid triggering data load effect
  const effectiveFieldDefinitionsRef = useRef(effectiveFieldDefinitions);
  effectiveFieldDefinitionsRef.current = effectiveFieldDefinitions;

  // Navigation guard
  const {
    pendingNavigation,
    highlightSaveButton,
    saveButtonRef,
    handleNavigationAttempt,
    clearPendingNavigation,
  } = useNavigationGuard();

  // Change tracking - only track changes if we're not currently loading data
  // For templates, use custom dynamic field comparison
  const standardHasFieldChanges = useChangeTracking(
    isLoadingData ? null : (config.contentType !== 'templates' ? (selectedItem || null) : null), // Skip for templates
    currentLanguage,
    primaryLocale,
    editableValues as any,
    config.contentType,
    fallbackFields
  );

  // Template-specific change detection: compare editableValues with originalTemplateValuesRef
  const templateHasFieldChanges = useMemo(() => {
    if (config.contentType !== 'templates' || isLoadingData || !selectedItem) {
      return false;
    }

    const originalValues = originalTemplateValuesRef.current;
    if (Object.keys(originalValues).length === 0) {
      return false; // No original values yet
    }

    // Compare each editable value with the original
    for (const [key, value] of Object.entries(editableValues)) {
      const originalValue = originalValues[key] || "";
      if (value !== originalValue) {
        return true;
      }
    }
    return false;
  }, [config.contentType, isLoadingData, selectedItem, editableValues]);

  // Combined field changes: use template logic for templates, standard for others
  const hasFieldChanges = config.contentType === 'templates' ? templateHasFieldChanges : standardHasFieldChanges;

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

  // Track previous language to detect language changes
  const prevCurrentLanguageRef = useRef<string>(currentLanguage);

  // Track previous item ID for data loading (separate from image loading ref to avoid race condition)
  const prevItemIdForDataLoadRef = useRef<string | null>(null);

  // Track previous dataRefreshTrigger to detect manual refreshes
  const prevDataRefreshTriggerRef = useRef<number>(0);

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
    // 3. Data refresh was triggered (e.g., by ReloadButton after revalidation)
    // NOTE: Use separate ref from image loading to avoid race condition
    const itemIdChanged = prevItemIdForDataLoadRef.current !== selectedItemId;
    const languageChanged = prevCurrentLanguageRef.current !== currentLanguage;
    const refreshTriggered = prevDataRefreshTriggerRef.current !== dataRefreshTrigger;

    if (!itemIdChanged && !languageChanged && !refreshTriggered) {
      // Don't log on skip to reduce console spam
      return;
    }

    // Skip data load if flagged (e.g., after save/clear to prevent overwriting user changes)
    // BUT: Never skip when the language changed - a language switch always needs fresh data
    // loaded into editableValues for the new language. Without this, switching from a foreign
    // language to primary after saving leaves stale foreign-language values in editableValues
    // which mismatch the primary-language originals, causing a false-positive hasChanges.
    if (skipNextDataLoadRef.current) {
      skipNextDataLoadRef.current = false;
      if (!languageChanged) {
        debugLog.dataLoad(' Skipping data load (skipNextDataLoadRef was set)');
        // Still update refs so the next real change is detected
        prevItemIdForDataLoadRef.current = selectedItemId;
        prevCurrentLanguageRef.current = currentLanguage;
        prevDataRefreshTriggerRef.current = dataRefreshTrigger;
        return;
      }
      debugLog.dataLoad(' skipNextDataLoadRef was set but language changed - proceeding with data load');
    }

    // Update refs
    prevItemIdForDataLoadRef.current = selectedItemId;
    prevCurrentLanguageRef.current = currentLanguage;
    prevDataRefreshTriggerRef.current = dataRefreshTrigger;

    if (refreshTriggered) {
      debugLog.dataLoad(' Data refresh triggered by ReloadButton');

      // Clear saved values cache on manual reload - user expects fresh server data
      if (selectedItemId && savedPrimaryValuesRef.current[selectedItemId]) {
        delete savedPrimaryValuesRef.current[selectedItemId];
      }
    }

    // Mark as loading immediately
    setIsLoadingData(true);

    // Reset accept-and-translate flag when changing items or languages
    setIsAcceptAndTranslateFlow(false);

    // Reset retry mechanism flags when changing items or languages (allow fresh retries)
    initialLoadSuccessfulRef.current = false;
    retryCountRef.current = 0;

    // Clear deleted translation keys and processed response refs when switching to a different item
    if (itemIdChanged) {
      deletedTranslationKeysRef.current.clear();
      localTranslationsRef.current = {};
      processedSaveResponseRef.current = null;
      isSavePendingRef.current = false;
      processedTranslateFieldRef.current = null;
      acceptedPrimaryValueRef.current = null;
      setIsInitialDataReady(false); // Reset data ready flag for new item
      debugLog.dataLoad(' Cleared refs for new item');
    }

    const newValues: Record<string, string> = {};
    const fieldDefs = effectiveFieldDefinitionsRef.current;

    if (currentLanguage === primaryLocale) {
      // Load primary locale values
      const newFallbackFields = new Set<string>();

      // Check if we have saved values from a recent save that should override
      // potentially stale item data (revalidation replaces item objects, losing mutations)
      const savedOverride = selectedItemId ? savedPrimaryValuesRef.current[selectedItemId] : undefined;

      if (savedOverride) {
        debugLog.dataLoad(' Using saved primary values override for item:', selectedItemId);
        fieldDefs.forEach((field) => {
          newValues[field.key] = savedOverride[field.key] ?? "";
        });

        // Check if the server data has caught up (matches saved values)
        const serverCaughtUp = fieldDefs.every((field) => {
          const serverValue = getItemFieldValue(item, field.key, primaryLocale, config);
          const savedValue = savedOverride[field.key] ?? "";
          // For seoTitle, getItemFieldValue falls back to title - compare with that in mind
          if (field.key === 'seoTitle' && savedValue === "" && serverValue === (item.title || "")) {
            return true; // Server returns title as fallback, saved is empty - that's expected
          }
          return serverValue === savedValue;
        });

        if (serverCaughtUp) {
          debugLog.dataLoad(' Server data caught up, clearing saved values override');
          delete savedPrimaryValuesRef.current[selectedItemId!];
        }
      } else {
        // Normal data load from item
        fieldDefs.forEach((field) => {
          newValues[field.key] = getItemFieldValue(item, field.key, primaryLocale, config);

          // Mark seoTitle as fallback if it's using the title as fallback
          if (field.key === 'seoTitle') {
            const actualSeoTitle = item.seo?.title;
            const isUsingFallback = !actualSeoTitle && item.title;
            if (isUsingFallback) {
              debugLog.dataLoad(' SEO Title field: using fallback to main title:', item.title);
              newFallbackFields.add(field.key);
            }
          }
        });
      }

      setFallbackFields(newFallbackFields);
    } else if (config.contentType === 'templates') {
      // TEMPLATES: Don't load translations here - they are managed by app.templates.tsx
      // via loadedTranslations cache. Just initialize with empty strings.
      // The app.templates.tsx effect will set the correct values from cache.
      debugLog.dataLoad(' Templates foreign locale - skipping, will be set by app.templates.tsx');
      fieldDefs.forEach((field) => {
        // Keep existing value if available, otherwise empty
        newValues[field.key] = editableValues[field.key] || "";
      });
      // Don't call setEditableValues here for templates foreign locales
      // The app.templates.tsx effect handles this
      setIsLoadingData(false);
      return;
    } else {
      // Load translated values for non-template content types
      const newFallbackFields = new Set<string>();

      fieldDefs.forEach((field) => {
        // Check if this translation key was deleted - if so, show empty field
        if (deletedTranslationKeysRef.current.has(field.translationKey)) {
          debugLog.dataLoad(' Skipping deleted translation key:', field.translationKey);
          newValues[field.key] = "";
          return;
        }

        // First check local translations ref (from Accept & Translate flow)
        // This is needed because item.translations mutations can be lost when items array is recreated
        const localValue = localTranslationsRef.current[field.translationKey]?.[currentLanguage];
        if (localValue) {
          debugLog.dataLoad(' Using local translation for', field.translationKey, ':', currentLanguage);
          newValues[field.key] = localValue;
          return;
        }

        const translatedValue = getTranslatedValue(
          item,
          field.translationKey,
          currentLanguage,
          "",
          primaryLocale
        );

        // Special handling for handle field: fallback to primary locale value if no translation
        // Shopify doesn't return a translation if it's identical to the primary value
        if (field.key === 'handle' && !translatedValue && item.handle) {
          debugLog.dataLoad(' Handle field: using fallback to primary locale value:', item.handle);
          newValues[field.key] = item.handle;
          newFallbackFields.add(field.key);
        } else if (field.key === 'seoTitle' && !translatedValue) {
          // Special handling for seoTitle field: fallback to translated title (or primary if no translation)
          const translatedTitle = getTranslatedValue(
            item,
            "title", // Translation key for title
            currentLanguage,
            "",
            primaryLocale
          );
          const fallbackTitle = translatedTitle || item.title || "";
          debugLog.dataLoad(' SEO Title field: using fallback to title:', fallbackTitle);
          newValues[field.key] = fallbackTitle;
          newFallbackFields.add(field.key);
        } else {
          newValues[field.key] = translatedValue;
        }
      });

      setFallbackFields(newFallbackFields);
    }

    // Snapshot the loaded values so buildFieldsForSave() can later compare against them.
    // Without this, every save in a foreign locale would re-send ALL fields to Shopify,
    // including unchanged ones like handle, which causes "handle already taken" errors.
    originalLoadedValuesRef.current = { ...newValues };

    setEditableValues(newValues);

    // For templates: Store original values for change detection
    if (config.contentType === 'templates') {
      debugLog.dataLoad(' Setting originalTemplateValuesRef:', newValues);
      originalTemplateValuesRef.current = { ...newValues };
    }
    // IMPORTANT: Only depend on selectedItemId, currentLanguage and dataRefreshTrigger to prevent unnecessary re-runs
  }, [selectedItemId, currentLanguage, primaryLocale, config, dataRefreshTrigger]);

  // Mark loading as complete after editableValues have been updated
  // This is in a separate useEffect to ensure the state update has completed
  useEffect(() => {
    if (selectedItemId && isLoadingData) {
      // Use longer timeout to ensure React render cycle is complete
      // This prevents the yellow "untranslated" flash on initial load
      const timer = setTimeout(() => {
        setIsLoadingData(false);
        setIsInitialDataReady(true);
      }, 10);
      return () => clearTimeout(timer);
    }
    // Use selectedItemId instead of selectedItem to prevent re-runs on reference changes
  }, [editableValues, selectedItemId, isLoadingData]);

  // Retry mechanism: If all fields are empty but item has data, retry loading
  // NOTE: Disabled for templates because users can intentionally clear all fields
  useEffect(() => {
    // Skip retry mechanism if initial load was already successful
    // This prevents reloading old values when user intentionally clears fields
    if (initialLoadSuccessfulRef.current) return;

    const item = selectedItemRef.current;
    if (!item || !selectedItemId || isLoadingData) return;

    // Check if we have field definitions
    if (effectiveFieldDefinitions.length === 0) return;

    // Check if ALL editable values are empty
    const allValuesEmpty = Object.values(editableValues).every(v => !v || v === "");
    if (!allValuesEmpty) {
      // Values loaded successfully - mark as successful and disable further retries
      initialLoadSuccessfulRef.current = true;
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
      debugLog.retry(`Fields empty but item has data. Retry ${retryCountRef.current}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms`);

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

        debugLog.retry('Reloaded values:', Object.keys(newValues).length, 'fields');
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
  // The AbortError can be thrown when Shopify admin's own requests interfere with ours,
  // but the submit usually still works, so we just log and ignore the error
  // IMPORTANT: Uses fetcherRef to avoid dependency on fetcher which changes frequently
  const safeSubmit = useCallback((data: Record<string, any>, options?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }) => {
    console.log('📤 [safeSubmit] About to submit:', {
      hasFetcher: !!fetcherRef.current,
      fetcherExists: fetcherRef.current !== undefined,
      fetcherState: fetcherRef.current?.state,
      hasSubmitFn: typeof fetcherRef.current?.submit === 'function',
      dataKeys: Object.keys(data),
      options,
    });

    debugLog.submit(' Submitting data:', data);
    debugLog.submit(' Options:', options);

    // Convert data object to FormData for proper Shopify embedded app compatibility
    // Using plain objects doesn't trigger fetcher state changes in embedded context
    const formData = new FormData();
    Object.entries(data).forEach(([key, value]) => {
      formData.append(key, String(value));
    });

    try {
      console.log('🔄 [safeSubmit] Calling fetcher.submit() with FormData...');
      fetcherRef.current.submit(formData, options || { method: "POST" });
      console.log('✅ [safeSubmit] fetcher.submit() returned, new state:', fetcherRef.current.state);
    } catch (error) {
      console.error('❌ [safeSubmit] Error caught:', error);
      // AbortError can be thrown when Shopify admin interferes, but data is usually saved
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('⚠️ [safeSubmit] AbortError - ignoring:', error.message);
        debugLog.submit(' AbortError caught (data likely saved):', error.message);
      } else {
        console.error('🔴 [safeSubmit] Non-AbortError - re-throwing:', error);
        // Re-throw non-AbortError errors
        throw error;
      }
    }
  }, []); // Empty deps - stable reference using fetcherRef

  // Submit AI action using fetch API directly to allow parallel requests
  // This enables multiple AI actions to run simultaneously on different fields
  const submitAIAction = useCallback(async (
    data: Record<string, any>,
    fieldKey: string,
    onSuccess?: (result: any) => void,
    onError?: (error: string) => void
  ) => {
    // Add field to loading state
    setLoadingFieldKeys(prev => new Set(prev).add(fieldKey));

    try {
      const formData = new FormData();
      // Add contentType for task tracking
      formData.append('contentType', config.contentType);
      Object.entries(data).forEach(([key, value]) => {
        formData.append(key, String(value));
      });

      // Use dedicated AI API route for all AI requests
      // This avoids page routes returning HTML instead of JSON and enables parallel requests
      const response = await fetch('/api/ai', {
        method: 'POST',
        body: formData,
        headers: {
          'Accept': 'application/json',
        },
      });

      // Check if response is JSON before parsing
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        throw new Error(`Server returned ${response.status}: Expected JSON but got ${contentType || 'unknown content type'}`);
      }

      const result = await response.json();

      if (result.success) {
        onSuccess?.(result);
      } else if (result.error) {
        onError?.(result.error);
        const translatedError = translateErrorMessage(result.error, t);
        showInfoBox(translatedError, "critical", t.common?.error || "Error");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      onError?.(errorMessage);
      const translatedError = translateErrorMessage(errorMessage, t);
      showInfoBox(translatedError, "critical", t.common?.error || "Error");
    } finally {
      // Remove field from loading state
      setLoadingFieldKeys(prev => {
        const newSet = new Set(prev);
        newSet.delete(fieldKey);
        return newSet;
      });
    }
  }, [showInfoBox, t]);

  // Helper function to get which fields have changed compared to the original item
  const getChangedFields = useCallback((valuesToCheck: Record<string, string>): string[] => {
    const item = selectedItemRef.current;
    if (!item) {
      debugLog.fields(' No item selected');
      return [];
    }

    const changedFields: string[] = [];
    debugLog.fields(' contentType:', config.contentType);
    debugLog.fields(' originalTemplateValuesRef:', originalTemplateValuesRef.current);
    debugLog.fields(' valuesToCheck:', valuesToCheck);

    effectiveFieldDefinitions.forEach((field) => {
      const currentValue = valuesToCheck[field.key] || "";

      // For templates: Use originalTemplateValuesRef which stores the true original values
      // This is necessary because item.translatableContent may be updated after loading
      let originalValue: string;
      if (config.contentType === 'templates') {
        originalValue = originalTemplateValuesRef.current[field.key] || "";
      } else {
        originalValue = getItemFieldValue(item, field.key, primaryLocale, config);
      }

      if (currentValue !== originalValue) {
        debugLog.fields(`Field "${field.key}" changed: "${originalValue}" -> "${currentValue}"`);
        changedFields.push(field.key);
      }
    });

    debugLog.fields(' Result:', changedFields);
    return changedFields;
  }, [effectiveFieldDefinitions, primaryLocale, config]);

  // Builds the field key-value pairs to include in a save request.
  //
  // For PRIMARY locale: all fields are included (Shopify productUpdate/collectionUpdate needs them).
  // For FOREIGN locales: only fields that the user actually modified are included.
  //
  // Why this matters: Shopify's translationsRegister re-validates every field sent, even
  // unchanged ones. If a handle translation exists and is re-sent, Shopify may reject the
  // entire save with "handle already taken". The old code sent ALL non-fallback fields on
  // every save. Now we compare against originalLoadedValuesRef to detect actual changes.
  //
  // Two layers of filtering for foreign locales:
  // 1. fallbackFields — fields showing primary locale values (no translation exists at all)
  // 2. originalLoadedValuesRef — fields that have a translation but weren't edited by the user
  const buildFieldsForSave = useCallback((
    values: Record<string, string>,
    locale: string
  ): Record<string, string> => {
    const result: Record<string, string> = {};
    effectiveFieldDefinitions.forEach((field) => {
      // Layer 1: Skip fallback fields (fields with no translation, showing primary value)
      if (locale !== primaryLocale && fallbackFieldsRef.current.has(field.key)) {
        return;
      }
      const value = values[field.key] || "";
      // Layer 2: Skip fields that haven't changed from what was loaded from the server
      if (locale !== primaryLocale) {
        const originalValue = originalLoadedValuesRef.current[field.key] || "";
        if (value === originalValue) {
          return;
        }
      }
      result[field.key] = value;
    });
    return result;
  }, [effectiveFieldDefinitions, primaryLocale]);

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

    // Add field values - for foreign locales, only send fields that actually changed
    Object.assign(formDataObj, buildFieldsForSave(valuesToSave, locale));

    // Add image alt-texts if there are any changes
    if (Object.keys(imageAltTexts).length > 0) {
      formDataObj.imageAltTexts = JSON.stringify(imageAltTexts);
      debugLog.autoSave(' 🖼️ imageAltTexts being sent:', JSON.stringify(imageAltTexts));
    }

    // If saving primary locale, include changed fields for translation deletion
    // BUT: Skip this if we're in an accept-and-translate flow - new translations will be created immediately
    const item = selectedItemRef.current;
    if (locale === primaryLocale && item && !isAcceptAndTranslateFlowRef.current) {
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
        debugLog.autoSave(' Changed alt-text indices (translations will be deleted):', changedAltTextIndices);
      }
    }

    // Cache saved primary values so they survive revalidation (mirrors handleSave behavior).
    // Without this, switching away and back to the primary locale after an auto-save
    // (e.g. Accept & Translate) would show stale item data because revalidation hasn't
    // reflected the new values yet.
    if (locale === primaryLocale) {
      savedPrimaryValuesRef.current[selectedItemId] = { ...valuesToSave };
    }

    debugLog.autoSave(' Saving with values:', valuesToSave, 'locale:', locale);
    savedLocaleRef.current = locale; // Track which locale we're saving
    isSavePendingRef.current = true; // Track that a save was initiated
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

  // Ref to store the accepted primary locale value during Accept & Translate flow
  // This is needed because pendingTranslationAfterSaveRef is cleared after the save response,
  // but we need the value when the translation response arrives to restore editableValues
  const acceptedPrimaryValueRef = useRef<{
    fieldKey: string;
    value: string;
  } | null>(null);

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

  // Ref to track whether a save operation is actually pending (prevents false "saved" messages on revalidation)
  const isSavePendingRef = useRef(false);

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

      // Clear fallback styling for this field since it now has a real translation
      if (fallbackFieldsRef.current.has(fieldType)) {
        setFallbackFields((prev) => {
          const newSet = new Set(prev);
          newSet.delete(fieldType);
          return newSet;
        });
        fallbackFieldsRef.current.delete(fieldType);
      }

      // Update item.translations directly so hasChanges becomes false after save
      const item = selectedItemRef.current;
      if (item && field?.translationKey) {
        // Remove existing translation for this key and locale
        item.translations = item.translations.filter(
          (t: Translation) => !(t.locale === targetLocale && t.key === field.translationKey)
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
        Object.assign(formDataObj, buildFieldsForSave(newValues, targetLocale));

        // Track which locale we're saving so the response handler knows
        savedLocaleRef.current = targetLocale;
        isSavePendingRef.current = true;
        safeSubmit(formDataObj, { method: "POST" });

        // Reset the baseline so the just-saved translated field isn't re-sent on the next save.
        // Without this, the translated field would still differ from the old originalLoadedValues
        // and would be included again in every subsequent save.
        originalLoadedValuesRef.current = { ...newValues };
      }

      // Mark as loading to reset change detection after the save completes
      setIsLoadingData(true);
    }
  }, [fetcher.data, selectedItemId, primaryLocale, effectiveFieldDefinitions, safeSubmit, buildFieldsForSave]);

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

  // Handle translated alt-text response (auto-save)
  useEffect(() => {
    if (fetcher.data?.success && 'translatedAltText' in fetcher.data) {
      const { translatedAltText, imageIndex } = fetcher.data as any;
      debugLog.altText(' Setting translated alt-text for image', imageIndex, ':', translatedAltText);

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
      debugLog.altText(' Translations to all locales completed for image', imageIndex);
      showInfoBox(
        t.content?.altTextTranslatedToAllLocales || `Alt-text for image ${imageIndex + 1} translated to ${targetLocales.length} languages`,
        "success",
        t.common?.success || "Success"
      );

      // Revalidate to fetch fresh data with the new translations
      if (revalidator.state === 'idle') {
        try {
          debugLog.altText(' Triggering revalidation after translate to all locales');
          revalidator.revalidate();
        } catch (error) {
          debugLog.altText(' Revalidation error (ignored):', error);
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

    debugLog.altText(' Executing auto-save for alt-texts:', pendingAltTexts);

    // Skip next data load to prevent revalidation from overwriting
    skipNextDataLoadRef.current = true;

    // Build form data for save
    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };

    // Add all field values (skip fallback fields to prevent registering primary values as translations)
    effectiveFieldDefinitions.forEach((field) => {
      if (currentLanguage !== primaryLocale && fallbackFieldsRef.current.has(field.key)) {
        return;
      }
      formDataObj[field.key] = editableValues[field.key] || "";
    });

    // Add the alt-texts
    formDataObj.imageAltTexts = JSON.stringify(pendingAltTexts);

    // Include changedFields so the backend knows which text fields actually changed
    // This prevents productType from being accidentally cleared when only alt-texts changed
    if (currentLanguage === primaryLocale) {
      const changedFields = getChangedFields(editableValues);
      if (changedFields.length > 0) {
        formDataObj.changedFields = JSON.stringify(changedFields);
      }
    }

    savedLocaleRef.current = currentLanguage;
    isSavePendingRef.current = true;
    safeSubmit(formDataObj, { method: "POST" });
  }, [imageAltTexts, selectedItemId, currentLanguage, primaryLocale, effectiveFieldDefinitions, editableValues, safeSubmit, getChangedFields]);

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
          debugLog.translateAll(' Clearing all deleted translation keys:', Array.from(deletedTranslationKeysRef.current));
          deletedTranslationKeysRef.current.clear();
        }

        for (const [locale, fields] of Object.entries(translations as any)) {
          const newTranslations: Translation[] = [];

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
            ...item.translations.filter((t: Translation) => t.locale !== locale),
            ...newTranslations,
          ];

          // If we're currently viewing this locale, update the editable fields
          if (currentLanguage === locale) {
            const updatedValues = { ...editableValues };
            const translatedKeys: string[] = [];
            effectiveFieldDefinitions.forEach((fieldDef) => {
              const value = (fields as any)[fieldDef.key];
              if (value) {
                updatedValues[fieldDef.key] = value;
                translatedKeys.push(fieldDef.key);
              }
            });
            setEditableValues(updatedValues);

            // Reset the baseline to the post-translation values. translateAll/translateAllForLocale
            // already saved these translations on the server, so they are now the "original" state.
            // Without this, a subsequent manual save would re-send all translated fields because
            // they'd still differ from the pre-translation originalLoadedValues.
            originalLoadedValuesRef.current = { ...updatedValues };

            // Clear fallback styling for fields that now have real translations
            if (translatedKeys.length > 0) {
              setFallbackFields((prev) => {
                const newSet = new Set(prev);
                translatedKeys.forEach((key) => newSet.delete(key));
                return newSet;
              });
              fallbackFieldsRef.current = new Set(
                [...fallbackFieldsRef.current].filter((key) => !translatedKeys.includes(key))
              );
            }

            // For templates: Update original values so hasChanges becomes false after translation
            // This prevents the save button from showing false changes after translateAll
            if (config.contentType === 'templates') {
              originalTemplateValuesRef.current = { ...updatedValues };
            }
          }
        }

        // Mark as loading to reset change detection after bulk translation
        // This ensures hasChanges becomes false after we've updated the translations
        setIsLoadingData(true);
      }
    }
  }, [fetcher.data, currentLanguage, effectiveFieldDefinitions, config.contentType]); // Use selectedItemRef instead of selectedItem

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
          debugLog.translateAllForLocale(' Clearing all deleted translation keys:', Array.from(deletedTranslationKeysRef.current));
          deletedTranslationKeysRef.current.clear();
        }

        const newTranslations: Translation[] = [];

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
          ...item.translations.filter((t: Translation) => t.locale !== targetLocale),
          ...newTranslations,
        ];

        // If we're currently viewing this locale, update the editable fields
        if (currentLanguage === targetLocale) {
          const updatedValues = { ...editableValues };
          const translatedKeys: string[] = [];
          effectiveFieldDefinitions.forEach((fieldDef) => {
            const value = translations[fieldDef.key];
            if (value) {
              updatedValues[fieldDef.key] = value;
              translatedKeys.push(fieldDef.key);
            }
          });
          setEditableValues(updatedValues);

          // Update original loaded values since translations were saved on the server
          originalLoadedValuesRef.current = { ...updatedValues };

          // Clear fallback styling for fields that now have real translations
          if (translatedKeys.length > 0) {
            setFallbackFields((prev) => {
              const newSet = new Set(prev);
              translatedKeys.forEach((key) => newSet.delete(key));
              return newSet;
            });
            fallbackFieldsRef.current = new Set(
              [...fallbackFieldsRef.current].filter((key) => !translatedKeys.includes(key))
            );
          }

          // For templates: Update original values so hasChanges becomes false after translation
          // This prevents the save button from showing false changes after translateAllForLocale
          if (config.contentType === 'templates') {
            originalTemplateValuesRef.current = { ...updatedValues };
          }
        }

        // Mark as loading to reset change detection after bulk translation
        // This ensures hasChanges becomes false after we've updated the translations
        setIsLoadingData(true);

        showInfoBox(
          t.common?.translatedSuccessfully || `Successfully translated to ${targetLocale}`,
          "success",
          t.common?.success || "Success"
        );
      }
    }
  }, [fetcher.data, currentLanguage, effectiveFieldDefinitions, showInfoBox, t, config.contentType]); // Use selectedItemRef instead of selectedItem

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
        debugLog.response(' Skipping - fetcher.data unchanged, only dependencies changed');
        return;
      }
      lastFetcherDataRef.current = fetcher.data;

      // Use the locale that was saved (tracked by savedLocaleRef), not the current language
      const savedLocale = savedLocaleRef.current;
      if (!savedLocale) {
        debugLog.response(' No savedLocale tracked, skipping update');
        return;
      }

      debugLog.response(' Processing save response for locale:', savedLocale);

      if (savedLocale === primaryLocale) {
        // This was a successful update action for primary locale
        // Update the item object directly with new values
        debugLog.response(' Updating primary locale item values');
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
              debugLog.response(' Updated primary alt-text for image', index);
            }
          }
        }
      } else {
        // This was a successful update action for a translation
        // Use the saved locale, not the current viewing language
        debugLog.response(' Updating translation for saved locale:', savedLocale);
        const existingTranslations = item.translations.filter(
          (t: Translation) => t.locale !== savedLocale
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

            // Also store in localTranslationsRef to persist after revalidation
            // This is especially important for handle field where Shopify may not
            // return the translation if it's identical to the primary locale
            if (!localTranslationsRef.current[fieldDef.translationKey]) {
              localTranslationsRef.current[fieldDef.translationKey] = {};
            }
            localTranslationsRef.current[fieldDef.translationKey][savedLocale] = value;
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
                (t: AltTextTranslation) => t.locale !== savedLocale
              );
              // Add new translation
              item.images[index].altTextTranslations.push({
                locale: savedLocale,
                altText: altText,
              });
              debugLog.response(' Updated alt-text translation for image', index, 'locale:', savedLocale);
            }
          }
        }
      }

      // Update originalAltTexts immediately after saving to reset change detection
      // This is critical to make hasAltTextChanges = false after save
      setOriginalAltTexts({ ...imageAltTextsRef.current });
      debugLog.response(' Updated originalAltTexts:', { ...imageAltTextsRef.current });

      // Clear the saved locale ref after processing
      savedLocaleRef.current = null;

      // Reset change detection after successful save
      // This ensures hasChanges becomes false after we've updated selectedItem
      setIsLoadingData(true);
    }
  }, [fetcher.data, primaryLocale, editableValues, effectiveFieldDefinitions]); // Removed selectedItem - use ref instead

  // DEBUG: Log fetcher state on every render to see if it changes
  console.log('🔍 [FETCHER] Current state on render:', {
    state: fetcher.state,
    hasData: !!fetcher.data,
    data: fetcher.data,
  });

  // Show global InfoBox for success/error messages and revalidate after save
  useEffect(() => {
    console.log('💾 [SAVE-RESPONSE] useEffect triggered:', {
      hasFetcherData: !!fetcher.data,
      fetcherData: fetcher.data,
      fetcherState: fetcher.state,
      alreadyProcessed: fetcher.data === processedSaveResponseRef.current,
    });

    // Skip if this response was already processed (prevents duplicate processing on re-renders)
    if (fetcher.data === processedSaveResponseRef.current) {
      console.log('⏭️ [SAVE-RESPONSE] Already processed, skipping');
      return;
    }

    // Skip if no save was actually initiated (prevents false "saved" messages during reload/revalidation)
    if (!isSavePendingRef.current) {
      return;
    }

    if (
      fetcher.data?.success &&
      !(fetcher.data as any).generatedContent &&
      !(fetcher.data as any).translatedValue &&
      !(fetcher.data as any).translations // Skip revalidate for bulk operations, they handle it differently
    ) {
      // Mark this response as processed and clear save pending flag
      processedSaveResponseRef.current = fetcher.data;
      isSavePendingRef.current = false;

      // Check if there's a pending translation to start after this save
      if (pendingTranslationAfterSaveRef.current) {
        const { fieldKey, sourceText, targetLocales, contextTitle, itemId } = pendingTranslationAfterSaveRef.current;
        pendingTranslationAfterSaveRef.current = null;

        debugLog.acceptAndTranslate(' Save completed, now starting translation');

        // Start the translation using submitAIAction for parallel requests
        submitAIAction(
          {
            action: "translateFieldToAllLocales",
            itemId: itemId,
            fieldType: fieldKey,
            sourceText: sourceText,
            targetLocales: JSON.stringify(targetLocales),
            contextTitle: contextTitle,
            primaryLocale,
          },
          fieldKey,
          (result) => {
            // Handle success - update translations
            const translations = result.translations;
            const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
            const shopifyKey = field?.translationKey;
            const item = selectedItemRef.current;

            if (item && shopifyKey) {
              // Clear this translation key from deleted set since we now have new translations
              if (deletedTranslationKeysRef.current.has(shopifyKey)) {
                deletedTranslationKeysRef.current.delete(shopifyKey);
              }

              // Update item translations for all locales
              for (const [locale, translatedValue] of Object.entries(translations as Record<string, string>)) {
                item.translations = item.translations.filter(
                  (t: Translation) => !(t.locale === locale && t.key === shopifyKey)
                );
                item.translations.push({
                  key: shopifyKey,
                  value: translatedValue,
                  locale
                });
              }

              // Store translations locally as backup (item.translations mutations can be lost on revalidation)
              if (!localTranslationsRef.current[shopifyKey]) {
                localTranslationsRef.current[shopifyKey] = {};
              }
              for (const [locale, translatedValue] of Object.entries(translations as Record<string, string>)) {
                localTranslationsRef.current[shopifyKey][locale] = translatedValue;
              }
              debugLog.acceptAndTranslate(' Stored local translations for', shopifyKey, ':', Object.keys(translations));

              // If the current language is one of the translated languages, update editableValues
              if (translations[currentLanguage]) {
                setEditableValues(prev => ({
                  ...prev,
                  [fieldKey]: translations[currentLanguage]
                }));
              } else if (currentLanguage === primaryLocale && acceptedPrimaryValueRef.current?.fieldKey === fieldKey) {
                // Restore the accepted primary value (translation response only contains foreign languages)
                setEditableValues(prev => ({
                  ...prev,
                  [fieldKey]: acceptedPrimaryValueRef.current!.value
                }));
              }

              // Clear the accepted primary value ref after processing
              acceptedPrimaryValueRef.current = null;
            }

            showInfoBox(
              t.common?.fieldTranslatedToLanguages
                ?.replace("{fieldType}", fieldKey)
                .replace("{count}", String(Object.keys(translations).length))
                || `${fieldKey} translated to ${Object.keys(translations).length} language(s)`,
              "success",
              t.common?.success || "Success"
            );

            // Reset the accept-and-translate flow flag after translations are complete
            setIsAcceptAndTranslateFlow(false);

            // For templates: Update original value so hasChanges becomes false after translation
            if (config.contentType === 'templates' && translations[currentLanguage]) {
              originalTemplateValuesRef.current = {
                ...originalTemplateValuesRef.current,
                [fieldKey]: translations[currentLanguage]
              };
            }

            setIsLoadingData(true);
          }
        );

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

      // For templates: Update original values to match current values (so hasChanges becomes false)
      if (config.contentType === 'templates') {
        originalTemplateValuesRef.current = { ...editableValues };
      }

      // Revalidate to fetch fresh data from the database after successful save
      // This ensures translations and all changes are reflected in the UI
      // Only revalidate if not already revalidating to prevent AbortError
      if (revalidator.state === 'idle') {
        try {
          revalidator.revalidate();
        } catch (error) {
          // Ignore AbortError from Shopify admin interference
          debugLog.revalidate(' Error during revalidation (ignored):', error);
        }
      }
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data && isSavePendingRef.current) {
      // Also mark error responses as processed
      processedSaveResponseRef.current = fetcher.data;
      isSavePendingRef.current = false;
      const translatedError = translateErrorMessage(fetcher.data.error as string, t);
      showInfoBox(translatedError, "critical", t.common?.error || "Error");
    } else if (fetcher.data) {
      console.log('⚠️ [SAVE-RESPONSE] Response does not match save conditions:', {
        success: fetcher.data.success,
        hasGeneratedContent: !!(fetcher.data as any).generatedContent,
        hasTranslatedValue: !!(fetcher.data as any).translatedValue,
        hasTranslations: !!(fetcher.data as any).translations,
      });
    }
  }, [fetcher.data, showInfoBox, t, revalidator, safeSubmit, submitAIAction, effectiveFieldDefinitions, currentLanguage, primaryLocale]);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  // Wrapper for performAutoSave with default locale
  const performSaveWithValues = (valuesToSave: Record<string, string>, locale: string = currentLanguage) => {
    performAutoSave(valuesToSave, locale);
  };

  const handleSave = () => {
    console.log('💾 [SAVE] handleSave called:', {
      selectedItemId,
      hasChanges,
      currentLanguage,
      editableValues,
    });

    if (!selectedItemId || !hasChanges) {
      console.log('⏭️ [SAVE] Skipping save - no item selected or no changes');
      return;
    }

    // Compute changed fields BEFORE updateItemInMemory mutates the item,
    // otherwise getChangedFields compares against already-cleared values and misses changes.
    let changedFields: string[] = [];
    let changedAltTextIndices: number[] = [];
    if (currentLanguage === primaryLocale) {
      changedFields = getChangedFields(editableValues);
      changedAltTextIndices = getChangedAltTextIndices();
    }

    // If we're saving in the primary locale, clear all translations for changed fields
    // and update in-memory item values so navigation back shows correct data
    if (currentLanguage === primaryLocale && selectedItem) {
      effectiveFieldDefinitions.forEach((field) => {
        const currentValue = editableValues[field.key] || "";
        const originalValue = getItemFieldValue(selectedItem, field.key, primaryLocale, config);

        // Only clear translations if the value actually changed
        if (currentValue !== originalValue && field.translationKey) {
          const translationKey = field.translationKey;

          // Track deleted translation keys for immediate UI update
          // This ensures that even if revalidation brings back old data, we show empty fields
          deletedTranslationKeysRef.current.add(translationKey);

          // Remove all translations for this field across all locales
          if (selectedItem.translations) {
            const beforeCount = selectedItem.translations.length;
            selectedItem.translations = selectedItem.translations.filter(
              (t: Translation) => t.key !== translationKey
            );
            const afterCount = selectedItem.translations.length;

            if (beforeCount !== afterCount) {
              debugLog.translationClear(`Cleared translations for field "${field.key}" (key: ${translationKey})`);
            }
          }
        }
      });

      // Update in-memory item field values to match what's being saved.
      updateItemInMemory(selectedItem, editableValues, config);

      // Also cache the saved values in a ref that survives revalidation.
      // Revalidation replaces the items array with new objects, losing the mutations above.
      // The data load effect checks this cache and uses it instead of stale server data.
      savedPrimaryValuesRef.current[selectedItemId] = { ...editableValues };
    }

    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };

    // 🧪 DEBUG MODE: Check for skipShopifySync URL parameter
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('skipShopifySync') === 'true') {
        formDataObj.skipShopifySync = 'true';
      }
    }

    // Add field values - for foreign locales, only send fields that actually changed
    Object.assign(formDataObj, buildFieldsForSave(editableValues, currentLanguage));

    // Add image alt-texts if there are any changes
    if (Object.keys(imageAltTexts).length > 0) {
      formDataObj.imageAltTexts = JSON.stringify(imageAltTexts);
      debugLog.save(' 🖼️ imageAltTexts being sent:', JSON.stringify(imageAltTexts));
    }

    // If saving primary locale, include pre-computed changed fields for server-side translation deletion
    if (currentLanguage === primaryLocale) {
      if (changedFields.length > 0) {
        formDataObj.changedFields = JSON.stringify(changedFields);
        debugLog.save(' Changed fields (translations will be deleted on server):', changedFields);
      }

      if (changedAltTextIndices.length > 0) {
        formDataObj.changedAltTextIndices = JSON.stringify(changedAltTextIndices);
        debugLog.save(' Changed alt-text indices (translations will be deleted):', changedAltTextIndices);
      }
    }

    // Skip next data load to prevent revalidation from overwriting cleared/saved values.
    // The in-memory item is also updated above (updateItemInMemory) so that subsequent
    // data loads after navigation read the correct saved values instead of stale data.
    skipNextDataLoadRef.current = true;

    console.log('📤 [SAVE] Submitting form data:', formDataObj);
    savedLocaleRef.current = currentLanguage; // Track which locale we're saving
    isSavePendingRef.current = true; // Track that a save was initiated
    safeSubmit(formDataObj, { method: "POST" });
    clearPendingNavigation();
    console.log('✅ [SAVE] Form submitted successfully');
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
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;

    // Determine which image to send based on content type and sendImageToAI state
    let imageUrl: string | undefined;
    if (sendImageToAI) {
      if (config.contentType === "products") {
        // For products: use currently selected image or fallback to featured image
        imageUrl = images[selectedImageIndex]?.url || featuredImage?.url;
      } else if (config.contentType === "collections" || config.contentType === "blogs") {
        // For collections/blogs: use featured image only
        imageUrl = featuredImage?.url;
      }
    }

    submitAIAction(
      {
        action: "generateAIText",
        itemId: selectedItemId,
        fieldType: fieldKey,
        currentValue,
        contextTitle,
        contextDescription,
        mainLanguage,
        sendImageToAI: sendImageToAI.toString(),
        ...(imageUrl && { imageUrl }),
      },
      fieldKey,
      (result) => {
        // Handle success - set AI suggestion for this field
        setAiSuggestions((prev) => ({
          ...prev,
          [fieldKey]: result.generatedContent,
        }));
      }
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
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;

    // Determine which image to send based on content type and sendImageToAI state
    let imageUrl: string | undefined;
    if (sendImageToAI) {
      if (config.contentType === "products") {
        // For products: use currently selected image or fallback to featured image
        imageUrl = images[selectedImageIndex]?.url || featuredImage?.url;
      } else if (config.contentType === "collections" || config.contentType === "blogs") {
        // For collections/blogs: use featured image only
        imageUrl = featuredImage?.url;
      }
    }

    submitAIAction(
      {
        action: "formatAIText",
        itemId: selectedItemId,
        fieldType: fieldKey,
        currentValue,
        contextTitle,
        contextDescription,
        mainLanguage,
        sendImageToAI: sendImageToAI.toString(),
        ...(imageUrl && { imageUrl }),
      },
      fieldKey,
      (result) => {
        // Handle success - set AI suggestion for this field
        setAiSuggestions((prev) => ({
          ...prev,
          [fieldKey]: result.generatedContent,
        }));
      }
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

    const targetLocale = currentLanguage;

    submitAIAction(
      {
        action: "translateField",
        itemId: selectedItemId,
        fieldType: fieldKey,
        sourceText,
        targetLocale,
        primaryLocale,
      },
      fieldKey,
      (result) => {
        // Handle success - update the field with translated value
        const translatedValue = result.translatedValue;

        // Clear deleted key for this field since we now have a new translation
        if (field.translationKey && deletedTranslationKeysRef.current.has(field.translationKey)) {
          deletedTranslationKeysRef.current.delete(field.translationKey);
        }

        // Update UI
        setEditableValues(prev => ({
          ...prev,
          [fieldKey]: translatedValue,
        }));

        // Update item.translations directly so hasChanges becomes false after save
        const item = selectedItemRef.current;
        if (item && field.translationKey) {
          // Remove existing translation for this key and locale
          item.translations = item.translations.filter(
            (t: Translation) => !(t.locale === targetLocale && t.key === field.translationKey)
          );
          // Add new translation
          item.translations.push({
            key: field.translationKey,
            value: translatedValue,
            locale: targetLocale,
          });
        }

        // Auto-save the translation immediately
        if (selectedItemId) {
          const newValues = {
            ...editableValuesRef.current,
            [fieldKey]: translatedValue,
          };

          const formDataObj: Record<string, string> = {
            action: "updateContent",
            itemId: selectedItemId,
            locale: targetLocale,
            primaryLocale,
          };
          Object.assign(formDataObj, buildFieldsForSave(newValues, targetLocale));

          savedLocaleRef.current = targetLocale;
          isSavePendingRef.current = true;
          safeSubmit(formDataObj, { method: "POST" });

          // Reset the baseline so the just-saved translated field isn't re-sent on the next save.
          originalLoadedValuesRef.current = { ...newValues };
        }

        // Mark as loading to reset change detection after the save completes
        setIsLoadingData(true);
      }
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

    submitAIAction(
      {
        action: "translateFieldToAllLocales",
        itemId: selectedItemId,
        fieldType: fieldKey,
        sourceText,
        targetLocales: JSON.stringify(targetLocales),
        contextTitle,
        primaryLocale,
      },
      fieldKey,
      (result) => {
        // Handle success - translations is Record<locale, translatedText>
        const translations = result.translations;
        const shopifyKey = field.translationKey;
        const item = selectedItemRef.current;

        if (item && shopifyKey) {
          // Clear this translation key from deleted set since we now have new translations
          if (deletedTranslationKeysRef.current.has(shopifyKey)) {
            deletedTranslationKeysRef.current.delete(shopifyKey);
          }

          // Update item translations for all locales
          for (const [locale, translatedValue] of Object.entries(translations as Record<string, string>)) {
            // Remove existing translation for this key and locale
            item.translations = item.translations.filter(
              (t: Translation) => !(t.locale === locale && t.key === shopifyKey)
            );

            // Add new translation
            item.translations.push({
              key: shopifyKey,
              value: translatedValue,
              locale
            });
          }

          // Store translations locally as backup
          if (!localTranslationsRef.current[shopifyKey]) {
            localTranslationsRef.current[shopifyKey] = {};
          }
          for (const [locale, translatedValue] of Object.entries(translations as Record<string, string>)) {
            localTranslationsRef.current[shopifyKey][locale] = translatedValue;
          }

          // If the current language is one of the translated languages, update editableValues immediately
          if (translations[currentLanguage]) {
            setEditableValues(prev => ({
              ...prev,
              [fieldKey]: translations[currentLanguage]
            }));
          }

          showInfoBox(
            t.common?.fieldTranslatedToLanguages
              ?.replace("{fieldType}", fieldKey)
              .replace("{count}", String(Object.keys(translations).length))
              || `${fieldKey} translated to ${Object.keys(translations).length} language(s)`,
            "success",
            t.common?.success || "Success"
          );

          // For templates: Update original value so hasChanges becomes false after translation
          if (config.contentType === 'templates' && translations[currentLanguage]) {
            originalTemplateValuesRef.current = {
              ...originalTemplateValuesRef.current,
              [fieldKey]: translations[currentLanguage]
            };
          }

          // Call callback to update cache if provided
          if (onTranslateToAllLocalesComplete) {
            onTranslateToAllLocalesComplete(fieldKey, translations as Record<string, string>);
          }

          // Revalidate to fetch fresh data with the new translations
          if (revalidator.state === 'idle') {
            revalidator.revalidate();
          }
        }
      }
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

    // Also translate all image alt-texts to all locales in parallel (via fetch API)
    if (selectedItem?.images && selectedItem.images.length > 0) {
      const altTextsData: Record<number, string> = {};
      let hasAnyAltText = false;
      selectedItem.images.forEach((img: ContentImage, index: number) => {
        const altText = imageAltTexts[index] || img.altText || "";
        if (altText) {
          altTextsData[index] = altText;
          hasAnyAltText = true;
        }
      });

      if (hasAnyAltText) {
        submitAIAction(
          {
            action: "translateAllAltTextsToAllLocales",
            itemId: selectedItem.id,
            productId: selectedItem.id,
            altTextsData: JSON.stringify(altTextsData),
            targetLocales: JSON.stringify(targetLocales),
            primaryLocale
          },
          "allAltTextsTranslate",
          (result) => {
            const translatedCount = result.translatedCount || 0;
            const imageCount = result.imageCount || 0;
            showInfoBox(
              `Alt-Texte für ${imageCount} Bild(er) in ${translatedCount} Sprache(n) übersetzt`,
              "success",
              t.common?.success || "Success"
            );
            if (revalidator.state === 'idle') {
              try { revalidator.revalidate(); } catch {}
            }
          }
        );
      }
    }
  };

  const handleAcceptSuggestion = (fieldKey: string) => {
    const suggestion = aiSuggestions[fieldKey];
    if (!suggestion) return;

    // Force isLoadingData to false to ensure change detection works
    setIsLoadingData(false);

    // If this field was a fallback, remove it since user accepted an AI value
    if (fallbackFields.has(fieldKey)) {
      setFallbackFields((prev) => {
        const newSet = new Set(prev);
        newSet.delete(fieldKey);
        return newSet;
      });
    }

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

    // Set flag to prevent translation deletion during this flow
    setIsAcceptAndTranslateFlow(true);

    // If this field was a fallback, remove it since user accepted an AI value
    if (fallbackFields.has(fieldKey)) {
      setFallbackFields((prev) => {
        const newSet = new Set(prev);
        newSet.delete(fieldKey);
        return newSet;
      });
    }

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

    // Store the accepted value so we can restore it after translation completes
    // (pendingTranslationAfterSaveRef is cleared after save, but we need the value for the translation response)
    acceptedPrimaryValueRef.current = {
      fieldKey,
      value: suggestion
    };

    // Skip next data load to prevent revalidation from overwriting user changes
    skipNextDataLoadRef.current = true;

    // Step 2: Save the primary text first
    // After save completes, the useEffect will trigger the translation
    debugLog.acceptAndTranslate(' Saving primary text first, then will translate');
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

    // If this field was a fallback, remove it from fallback fields since user is editing
    if (fallbackFields.has(fieldKey)) {
      setFallbackFields((prev) => {
        const newSet = new Set(prev);
        newSet.delete(fieldKey);
        return newSet;
      });
    }

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

    // If this field was a fallback, remove it from fallback fields
    if (fallbackFields.has(fieldKey)) {
      setFallbackFields((prev) => {
        const newSet = new Set(prev);
        newSet.delete(fieldKey);
        return newSet;
      });
    }

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

    // Prevent retry mechanism from restoring old values after intentional clear
    initialLoadSuccessfulRef.current = true;
    retryCountRef.current = 0;

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

    // Clear image alt texts - set each to "" explicitly so the UI doesn't fall back to original image.altText
    if (selectedItem?.images && selectedItem.images.length > 0) {
      const clearedAltTexts: Record<number, string> = {};
      selectedItem.images.forEach((_: ContentImage, index: number) => {
        clearedAltTexts[index] = "";
      });
      setImageAltTexts(clearedAltTexts);
      setOriginalAltTexts({});
    }
    setAltTextSuggestions({});

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

    // Prevent retry mechanism from restoring old values after intentional clear
    initialLoadSuccessfulRef.current = true;
    retryCountRef.current = 0;

    // Clear all field values for the current foreign language
    const clearedValues: Record<string, string> = {};
    effectiveFieldDefinitions.forEach((field) => {
      clearedValues[field.key] = "";
    });
    setEditableValues(clearedValues);

    // Clear image alt texts - set each to "" explicitly so the UI doesn't fall back to original image.altText
    if (selectedItem?.images && selectedItem.images.length > 0) {
      const clearedAltTexts: Record<number, string> = {};
      selectedItem.images.forEach((_: ContentImage, index: number) => {
        clearedAltTexts[index] = "";
      });
      setImageAltTexts(clearedAltTexts);
      setOriginalAltTexts({});
    }
    setAltTextSuggestions({});

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

    // Also translate all image alt-texts for this locale in parallel (via fetch API)
    if (selectedItem?.images && selectedItem.images.length > 0) {
      const altTextsData: Record<number, string> = {};
      let hasAnyAltText = false;
      selectedItem.images.forEach((img: ContentImage, index: number) => {
        const altText = img.altText || "";
        if (altText) {
          altTextsData[index] = altText;
          hasAnyAltText = true;
        }
      });

      if (hasAnyAltText) {
        submitAIAction(
          {
            action: "translateAllAltTextsForLocale",
            itemId: selectedItem.id,
            productId: selectedItem.id,
            altTextsData: JSON.stringify(altTextsData),
            targetLocale: currentLanguage,
            primaryLocale
          },
          "allAltTextsTranslate",
          (result) => {
            // Directly accept translations and auto-save (no suggestion banner)
            if (result.translatedAltTexts) {
              const translated: Record<number, string> = {};
              Object.entries(result.translatedAltTexts).forEach(([indexStr, text]) => {
                translated[parseInt(indexStr)] = text as string;
              });
              const newAltTexts = { ...imageAltTexts, ...translated };
              setImageAltTexts(newAltTexts);
              setOriginalAltTexts(newAltTexts);
              pendingAltTextAutoSaveRef.current = newAltTexts;
            }
          }
        );
      }
    }
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
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;

    submitAIAction(
      {
        action: "generateAltText",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        imageIndex: String(imageIndex),
        imageUrl: image.url,
        productTitle,
        mainLanguage,
        sendImageToAI: sendImageToAI.toString(),
      },
      `altText_${imageIndex}`,
      (result) => {
        // Handle success - set AI suggestion for this alt-text
        if (result.altText) {
          setAltTextSuggestions((prev) => ({
            ...prev,
            [imageIndex]: result.altText,
          }));
        }
      }
    );
  };

  const handleGenerateAllAltTexts = () => {
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

    const productTitle = getItemFieldValue(selectedItem, 'title', primaryLocale, config);
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;
    const imagesData = selectedItem.images.map((img: ContentImage) => ({ url: img.url }));

    submitAIAction(
      {
        action: "generateAllAltTexts",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle,
        mainLanguage,
        imagesData: JSON.stringify(imagesData),
        sendImageToAI: sendImageToAI.toString(),
      },
      "allAltTextsGenerate",
      (result) => {
        if (result.generatedAltTexts) {
          const newAltTexts = {
            ...imageAltTexts,
            ...result.generatedAltTexts
          };
          setImageAltTexts(newAltTexts);
          setOriginalAltTexts(newAltTexts);
          pendingAltTextAutoSaveRef.current = newAltTexts;
        }
      }
    );
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

    submitAIAction(
      {
        action: "translateAltText",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        imageIndex: String(imageIndex),
        sourceAltText,
        targetLocale: currentLanguage,
        primaryLocale
      },
      `altText_${imageIndex}`,
      (result) => {
        // Handle success - set AI suggestion for this alt-text translation
        if (result.translatedAltText) {
          setAltTextSuggestions((prev) => ({
            ...prev,
            [imageIndex]: result.translatedAltText,
          }));
        }
      }
    );
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

    submitAIAction(
      {
        action: "translateAltTextToAllLocales",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        imageIndex: String(imageIndex),
        sourceAltText,
        targetLocales: JSON.stringify(targetLocales),
        primaryLocale
      },
      `altText_${imageIndex}`,
      (result) => {
        // Handle success - translations have been saved to Shopify and DB
        const translatedCount = result.translatedAltTexts ? Object.keys(result.translatedAltTexts).length : targetLocales.length;

        showInfoBox(
          (t.content?.altTextTranslatedToLanguages as string | undefined)
            ?.replace("{count}", String(translatedCount))
            || `Alt-text translated to ${translatedCount} language(s)`,
          "success",
          t.common?.success || "Success"
        );

        // Revalidate to fetch fresh data from the database
        if (revalidator.state === 'idle') {
          try {
            revalidator.revalidate();
          } catch (error) {
            debugLog.revalidate(' Error during revalidation (ignored):', error);
          }
        }
      }
    );
  };

  // Translate ALL image alt-texts to ALL foreign languages (primary locale button)
  const handleTranslateAllAltTexts = () => {
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning",
        t.common?.warning || "Warning"
      );
      return;
    }

    // Collect all source alt texts
    const altTextsData: Record<number, string> = {};
    let hasAnyAltText = false;
    selectedItem.images.forEach((img: ContentImage, index: number) => {
      const altText = imageAltTexts[index] || img.altText || "";
      if (altText) {
        altTextsData[index] = altText;
        hasAnyAltText = true;
      }
    });

    if (!hasAnyAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    submitAIAction(
      {
        action: "translateAllAltTextsToAllLocales",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        altTextsData: JSON.stringify(altTextsData),
        targetLocales: JSON.stringify(targetLocales),
        primaryLocale
      },
      "allAltTextsTranslate",
      (result) => {
        const translatedCount = result.translatedCount || 0;
        const imageCount = result.imageCount || 0;
        showInfoBox(
          `Alt-Texte für ${imageCount} Bild(er) in ${translatedCount} Sprache(n) übersetzt`,
          "success",
          t.common?.success || "Success"
        );

        if (revalidator.state === 'idle') {
          try {
            revalidator.revalidate();
          } catch (error) {
            debugLog.revalidate(' Error during revalidation (ignored):', error);
          }
        }
      }
    );
  };

  // Translate ALL image alt-texts into ONE foreign language (foreign locale button)
  const handleTranslateAllAltTextsForLocale = () => {
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

    // Collect all source alt texts from primary locale
    const altTextsData: Record<number, string> = {};
    let hasAnyAltText = false;
    selectedItem.images.forEach((img: ContentImage, index: number) => {
      const altText = img.altText || "";
      if (altText) {
        altTextsData[index] = altText;
        hasAnyAltText = true;
      }
    });

    if (!hasAnyAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    submitAIAction(
      {
        action: "translateAllAltTextsForLocale",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        altTextsData: JSON.stringify(altTextsData),
        targetLocale: currentLanguage,
        primaryLocale
      },
      "allAltTextsTranslate",
      (result) => {
        // Directly accept translations and auto-save (no suggestion banner)
        if (result.translatedAltTexts) {
          const translated: Record<number, string> = {};
          Object.entries(result.translatedAltTexts).forEach(([indexStr, text]) => {
            translated[parseInt(indexStr)] = text as string;
          });

          const newAltTexts = { ...imageAltTexts, ...translated };
          setImageAltTexts(newAltTexts);
          setOriginalAltTexts(newAltTexts);
          // Schedule auto-save
          pendingAltTextAutoSaveRef.current = newAltTexts;
        }
      }
    );
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
    debugLog.altText('Accepting AI suggestion for image:', imageIndex, 'auto-saving...');

    // Build form data for save
    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };

    // Add field values - for foreign locales, only send fields that actually changed
    Object.assign(formDataObj, buildFieldsForSave(editableValues, currentLanguage));

    // Add the new image alt-texts
    formDataObj.imageAltTexts = JSON.stringify(newAltTexts);

    savedLocaleRef.current = currentLanguage;
    isSavePendingRef.current = true;
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
      isSavePendingRef.current = true;
      safeSubmit(formDataObj, { method: "POST" });
      setOriginalAltTexts(newAltTexts);
      return;
    }

    // Skip next data load to prevent revalidation from overwriting user changes
    skipNextDataLoadRef.current = true;

    debugLog.altText('Saving primary alt-text first, then will translate to all locales');

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
    isSavePendingRef.current = true;
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
      item.images.forEach((img: ContentImage, index: number) => {
        const translation = img.altTextTranslations?.find(
          (t: { locale: string }) => t.locale === currentLanguage
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
      (t: Translation) => t.key === effectiveFieldDefinitions.find(f => f.key === fieldKey)?.translationKey && t.locale === currentLanguage
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

    // First check localTranslationsRef (from translateFieldToAllLocales)
    // This ensures immediate UI feedback before revalidation completes
    const localValue = localTranslationsRef.current[field.translationKey]?.[currentLanguage];
    if (localValue) {
      return true;
    }

    return selectedItem.translations?.some(
      (t: Translation) => t.key === field.translationKey && t.locale === currentLanguage
    );
  };

  const getEditableValue = (fieldKey: string): string => {
    return editableValues[fieldKey] || "";
  };

  const setEditableValue = (fieldKey: string, value: string) => {
    handleValueChange(fieldKey, value);
  };

  // Helper to update original template values (used after loading translations)
  const setOriginalTemplateValues = (values: Record<string, string>) => {
    if (config.contentType === 'templates') {
      originalTemplateValuesRef.current = { ...values };
    }
  };

  // Trigger data refresh (called by ReloadButton after revalidation to reload editableValues)
  const triggerDataRefresh = useCallback(() => {
    debugLog.dataLoad(' triggerDataRefresh called - will reload editableValues from fresh data');
    setDataRefreshTrigger(prev => prev + 1);
  }, []);

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
    isLoadingData,
    isLoadingImages,
    fallbackFields,
    loadingFieldKeys,
    sendImageToAI,
    selectedImageIndex,
    images: selectedItem?.images || [],
    featuredImage: selectedItem?.featuredImage || null,
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
    handleTranslateAllAltTexts,
    handleTranslateAllAltTextsForLocale,
    handleAcceptAltTextSuggestion,
    handleAcceptAndTranslateAltText,
    handleRejectAltTextSuggestion,
    handleToggleSendImageToAI,
    setSelectedImageIndex,
  };

  // Helper function to check if a specific field is currently loading
  const isFieldLoading = useCallback((fieldKey: string, action?: string) => {
    // Check if this exact field key is in the loading set
    return loadingFieldKeys.has(fieldKey);
  }, [loadingFieldKeys]);

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
      setOriginalTemplateValues,
      triggerDataRefresh,
      isFieldLoading,
    },
    // Dynamic field definitions (for templates and other dynamic content types)
    effectiveFieldDefinitions,
    // Focus management for accessibility
    focusManagement: {
      firstFieldRef,
      setItemFocus,
    },
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get field value from item based on field key and primary locale
 * Supports both standard content types and templates with dynamic fields
 */
function getItemFieldValue(item: TranslatableContentItem, fieldKey: string, primaryLocale: string, config?: ContentEditorConfig): string {
  // Templates: Use custom getter if available or check translatableContent
  if (config?.getFieldValue) {
    return config.getFieldValue(item, fieldKey);
  }

  // Templates: Check translatableContent array
  if (item?.translatableContent && Array.isArray(item.translatableContent)) {
    // Filter out null/undefined items to prevent "Cannot read properties of null" errors
    const content = item.translatableContent.find((c: { key: string; value: string }) => c != null && c.key === fieldKey);
    return content?.value || "";
  }

  // Standard content types: Common field mappings
  const fieldMappings: Record<string, string> = {
    title: item.title || "",
    description: item.descriptionHtml || item.body || "",
    handle: item.handle || "",
    seoTitle: item.seo?.title || item.title || "", // Fallback to main title if seoTitle is empty
    metaDescription: item.seo?.description || "",
    body: item.body || "",
    summary: item.summary || "",
    productType: item.productType || "",
  };

  return fieldMappings[fieldKey] || "";
}

/**
 * Updates an in-memory item's field values to match the saved editable values.
 * This is a direct mutation of the item object (which lives in the items array from route data).
 * It ensures that when the data load effect reads from the item (e.g., after navigation),
 * it gets the correct saved values instead of stale pre-save data.
 */
function updateItemInMemory(item: TranslatableContentItem, values: Record<string, string>, config: ContentEditorConfig): void {
  // Templates: update translatableContent array
  if (config.contentType === 'templates' && item.translatableContent) {
    item.translatableContent.forEach((content: { key: string; value: string }) => {
      if (content && values[content.key] !== undefined) {
        content.value = values[content.key];
      }
    });
    return;
  }

  // Standard content types: update item properties
  if (values.title !== undefined) item.title = values.title;
  if (values.description !== undefined) {
    item.descriptionHtml = values.description;
  }
  if (values.body !== undefined) item.body = values.body;
  if (values.handle !== undefined) item.handle = values.handle;
  if (values.productType !== undefined) item.productType = values.productType;
  if (values.summary !== undefined) item.summary = values.summary;
  if (values.seoTitle !== undefined || values.metaDescription !== undefined) {
    item.seo = {
      ...item.seo,
      ...(values.seoTitle !== undefined ? { title: values.seoTitle } : {}),
      ...(values.metaDescription !== undefined ? { description: values.metaDescription } : {}),
    };
  }
}
