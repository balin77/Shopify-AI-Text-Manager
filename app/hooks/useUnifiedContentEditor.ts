/**
 * Unified Content Editor Hook
 *
 * Based on the products page implementation with all bug fixes.
 * Provides a complete state management and handler system for content editing.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRevalidator, useFetcher } from "@remix-run/react";
import { useNavigationGuard, useChangeTracking, getTranslatedValue } from "../utils/contentEditor.utils";
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

  // Track which fields have AI actions currently running (for per-field loading states)
  // This allows multiple AI actions to run in parallel on different fields
  const [loadingFieldKeys, setLoadingFieldKeys] = useState<Set<string>>(new Set());

  // Track if initial data load was successful - disables retry mechanism after successful load
  // Reset when item or language changes, allowing retry during new load cycles
  const initialLoadSuccessfulRef = useRef(false);

  // IMPORTANT: Memoize selectedItem to prevent infinite re-renders
  // Without this, items.find() returns a new object reference on every revalidation,
  // which triggers useChangeTracking and other effects, causing an infinite loop
  const baseSelectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId),
    [items, selectedItemId]
  );

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
    console.log(`🖼️ [OnDemandImages] No DB images, loading from Shopify for ${selectedItemId}`);
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
        console.log(`🖼️ [OnDemandImages] Loaded ${imageFetcher.data.images.length} images from Shopify`);

        const images: ContentImage[] = imageFetcher.data.images.map((img: any) => ({
          url: img.url,
          altText: img.altText,
          altTextTranslations: [],
        }));

        setOnDemandImages(images);
        loadedImagesForProductRef.current = selectedItemId;
      } else if (imageFetcher.data.error) {
        console.error(`🖼️ [OnDemandImages] Error:`, imageFetcher.data.error);
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
    config.contentType
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
    // NOTE: Use separate ref from image loading to avoid race condition
    const itemIdChanged = prevItemIdForDataLoadRef.current !== selectedItemId;
    const languageChanged = prevCurrentLanguageRef.current !== currentLanguage;

    if (!itemIdChanged && !languageChanged) {
      // Don't log on skip to reduce console spam
      return;
    }

    // Update refs
    prevItemIdForDataLoadRef.current = selectedItemId;
    prevCurrentLanguageRef.current = currentLanguage;

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
      processedResponseRef.current = null;
      processedTranslateFieldRef.current = null;
      acceptedPrimaryValueRef.current = null;
      setIsInitialDataReady(false); // Reset data ready flag for new item
      debugLog.dataLoad(' Cleared refs for new item');
    }

    const newValues: Record<string, string> = {};
    const fieldDefs = effectiveFieldDefinitionsRef.current;

    if (currentLanguage === primaryLocale) {
      // Load primary locale values
      fieldDefs.forEach((field) => {
        newValues[field.key] = getItemFieldValue(item, field.key, primaryLocale, config);
      });
      // Clear fallback fields when viewing primary locale
      setFallbackFields(new Set());
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
        } else {
          newValues[field.key] = translatedValue;
        }
      });

      setFallbackFields(newFallbackFields);
    }

    setEditableValues(newValues);

    // For templates: Store original values for change detection
    if (config.contentType === 'templates') {
      debugLog.dataLoad(' Setting originalTemplateValuesRef:', newValues);
      originalTemplateValuesRef.current = { ...newValues };
    }
    // IMPORTANT: Only depend on selectedItemId and currentLanguage to prevent unnecessary re-runs
  }, [selectedItemId, currentLanguage, primaryLocale, config]);

  // Mark loading as complete after editableValues have been updated
  // This is in a separate useEffect to ensure the state update has completed
  useEffect(() => {
    if (selectedItemId && isLoadingData) {
      // Use longer timeout to ensure React render cycle is complete
      // This prevents the yellow "untranslated" flash on initial load
      const timer = setTimeout(() => {
        setIsLoadingData(false);
        setIsInitialDataReady(true);
      }, 2000);
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
  // The AbortError can occur when Shopify admin's own requests interfere with ours,
  // but the submit usually still works, so we just log and ignore the error
  // IMPORTANT: Uses fetcherRef to avoid dependency on fetcher which changes frequently
  const safeSubmit = useCallback((data: Record<string, any>, options?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }) => {
    debugLog.submit(' Submitting data:', data);
    debugLog.submit(' Options:', options);
    try {
      fetcherRef.current.submit(data, options || { method: "POST" });
    } catch (error) {
      // AbortError can be thrown when Shopify admin interferes, but data is usually saved
      if (error instanceof Error && error.name === 'AbortError') {
        debugLog.submit(' AbortError caught (data likely saved):', error.message);
      } else {
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
        console.error('Non-JSON response received:', text.substring(0, 500));
        throw new Error(`Server returned ${response.status}: Expected JSON but got ${contentType || 'unknown content type'}`);
      }

      const result = await response.json();

      if (result.success) {
        onSuccess?.(result);
      } else if (result.error) {
        onError?.(result.error);
        showInfoBox(result.error, "critical", t.common?.error || "Error");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      onError?.(errorMessage);
      showInfoBox(errorMessage, "critical", t.common?.error || "Error");
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

    debugLog.autoSave(' Saving with values:', valuesToSave, 'locale:', locale);
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

  // Ref to store the accepted primary locale value during Accept & Translate flow
  // This is needed because pendingTranslationAfterSaveRef is cleared after the save response,
  // but we need the value when the translation response arrives to restore editableValues
  const acceptedPrimaryValueRef = useRef<{
    fieldKey: string;
    value: string;
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
      debugLog.altText(' Auto-accepting bulk generated alt-texts:', generatedAltTexts);

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
            (t: Translation) => !(t.locale === locale && t.key === shopifyKey)
          );

          // Add new translation
          item.translations.push({
            key: shopifyKey,
            value: translatedValue,
            locale
          });
        }

        // Store translations locally as backup (item.translations mutations can be lost on re-render)
        if (!localTranslationsRef.current[shopifyKey]) {
          localTranslationsRef.current[shopifyKey] = {};
        }
        for (const [locale, translatedValue] of Object.entries(translations as Record<string, string>)) {
          localTranslationsRef.current[shopifyKey][locale] = translatedValue;
        }
        debugLog.acceptAndTranslate(' Stored local translations for', shopifyKey, ':', Object.keys(translations));

        // If the current language is one of the translated languages, update editableValues immediately
        // This ensures the UI shows the new translation without needing to switch languages
        if (translations[currentLanguage]) {
          setEditableValues(prev => ({
            ...prev,
            [fieldType]: translations[currentLanguage]
          }));
        } else if (currentLanguage === primaryLocale && acceptedPrimaryValueRef.current?.fieldKey === fieldType) {
          // If we're on the primary locale, restore the accepted value from Accept & Translate flow
          // This is needed because the translation response only contains foreign languages,
          // and the editableValues for primary locale might have been lost during re-renders
          debugLog.acceptAndTranslate(' Restoring accepted primary value for', fieldType, ':', acceptedPrimaryValueRef.current!.value.substring(0, 50) + '...');
          setEditableValues(prev => ({
            ...prev,
            [fieldType]: acceptedPrimaryValueRef.current!.value
          }));
        }

        // Clear the accepted primary value ref after processing
        acceptedPrimaryValueRef.current = null;

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
            effectiveFieldDefinitions.forEach((fieldDef) => {
              const value = (fields as any)[fieldDef.key];
              if (value) {
                updatedValues[fieldDef.key] = value;
              }
            });
            setEditableValues(updatedValues);
          }
        }

        // Mark as loading to reset change detection after bulk translation
        // This ensures hasChanges becomes false after we've updated the translations
        setIsLoadingData(true);
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
          effectiveFieldDefinitions.forEach((fieldDef) => {
            const value = translations[fieldDef.key];
            if (value) {
              updatedValues[fieldDef.key] = value;
            }
          });
          setEditableValues(updatedValues);
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

              // If the current language is one of the translated languages, update editableValues
              if (translations[currentLanguage]) {
                setEditableValues(prev => ({
                  ...prev,
                  [fieldKey]: translations[currentLanguage]
                }));
              }
            }

            showInfoBox(
              t.common?.fieldTranslatedToLanguages
                ?.replace("{fieldType}", fieldKey)
                .replace("{count}", String(Object.keys(translations).length))
                || `${fieldKey} translated to ${Object.keys(translations).length} language(s)`,
              "success",
              t.common?.success || "Success"
            );

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
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data) {
      // Also mark error responses as processed
      processedSaveResponseRef.current = fetcher.data;
      showInfoBox(fetcher.data.error as string, "critical", t.common?.error || "Error");
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
              (t: Translation) => t.key !== translationKey
            );
            const afterCount = selectedItem.translations.length;

            if (beforeCount !== afterCount) {
              debugLog.translationClear(`Cleared translations for field "${field.key}" (key: ${translationKey})`);
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
      debugLog.save(' 🖼️ imageAltTexts being sent:', JSON.stringify(imageAltTexts));
    }

    // If saving primary locale, include changed fields for server-side translation deletion
    if (currentLanguage === primaryLocale) {
      const changedFields = getChangedFields(editableValues);
      if (changedFields.length > 0) {
        formDataObj.changedFields = JSON.stringify(changedFields);
        debugLog.save(' Changed fields (translations will be deleted on server):', changedFields);
      }

      // Include changed alt-text indices for translation deletion
      const changedAltTextIndices = getChangedAltTextIndices();
      if (changedAltTextIndices.length > 0) {
        formDataObj.changedAltTextIndices = JSON.stringify(changedAltTextIndices);
        debugLog.save(' Changed alt-text indices (translations will be deleted):', changedAltTextIndices);
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
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;

    submitAIAction(
      {
        action: "generateAIText",
        itemId: selectedItemId,
        fieldType: fieldKey,
        currentValue,
        contextTitle,
        contextDescription,
        mainLanguage,
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

    submitAIAction(
      {
        action: "formatAIText",
        itemId: selectedItemId,
        fieldType: fieldKey,
        currentValue,
        contextTitle,
        contextDescription,
        mainLanguage,
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
          effectiveFieldDefinitions.forEach((f) => {
            formDataObj[f.key] = newValues[f.key] || "";
          });

          savedLocaleRef.current = targetLocale;
          safeSubmit(formDataObj, { method: "POST" });
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

          // Mark as loading to reset change detection
          setIsLoadingData(true);
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
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;

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
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;
    const imagesData = selectedItem.images.map((img: ContentImage) => ({ url: img.url }));

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
    debugLog.altText('Accepting AI suggestion for image:', imageIndex, 'auto-saving...');

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
    isLoadingImages,
    fallbackFields,
    loadingFieldKeys,
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
      setOriginalTemplateValues,
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
    seoTitle: item.seo?.title || "",
    metaDescription: item.seo?.description || "",
    body: item.body || "",
  };

  return fieldMappings[fieldKey] || "";
}
