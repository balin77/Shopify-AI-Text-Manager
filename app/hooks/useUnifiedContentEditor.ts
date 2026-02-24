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
import { useLatestRef } from "./useLatestRef";
import { useUiDataLoader, getItemFieldValue } from "./useUiDataLoader";
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
  TranslationStrings,
  FetcherData,
  GeneratedContentResponse,
  TranslatedValueResponse,
  TranslationsResponse,
  AltTextResponse,
  TranslatedAltTextResponse,
  TranslatedAltTextsResponse,
} from "../types/content-editor.types";
import { debugLog } from "../utils/debug";
import { markRecentlySaved } from "../utils/translation-timing";
import { extractReadableName } from "../utils/templates-field-factory";
import { useTaskCount } from "../contexts/TaskCountContext";

/**
 * Translates server error messages to localized strings
 * Maps technical error messages from server to i18n translation keys
 */
function translateErrorMessage(errorMessage: string, t: TranslationStrings): string {
  const errors = t.errors as Record<string, string> | undefined;
  if (!errorMessage) return errors?.unknownError || "Unknown error";

  const lowerError = errorMessage.toLowerCase();

  // Map common error patterns to translation keys
  if (lowerError.includes("graphql error")) {
    return errors?.graphqlError || errorMessage;
  }
  if (lowerError.includes("invalid field type")) {
    return errors?.invalidFieldType || errorMessage;
  }
  if (lowerError.includes("no fields to translate")) {
    return errors?.noFieldsToTranslate || errorMessage;
  }
  if (lowerError.includes("no source text") && !lowerError.includes("alt")) {
    return errors?.noSourceText || errorMessage;
  }
  if (lowerError.includes("no source alt-text") || lowerError.includes("no source alt text")) {
    return errors?.noSourceAltText || errorMessage;
  }
  if (lowerError.includes("no target locale") && lowerError.includes("image")) {
    return errors?.noTargetLocalesOrImages || errorMessage;
  }
  if (lowerError.includes("no target locale")) {
    return errors?.noTargetLocales || errorMessage;
  }
  if (lowerError.includes("no images data") || lowerError.includes("no image data")) {
    return errors?.noImagesData || errorMessage;
  }
  if (lowerError.includes("no images to process")) {
    return errors?.noImagesToProcess || errorMessage;
  }
  if (lowerError.includes("no alt-text data") || lowerError.includes("no alt text data")) {
    return errors?.noAltTextData || errorMessage;
  }
  if (lowerError.includes("unknown action")) {
    return errors?.unknownAction || errorMessage;
  }
  if (lowerError.includes("invalid url slug") || lowerError.includes("invalid handle") || lowerError.includes("alphanumeric character")) {
    return errors?.invalidUrlSlug || errorMessage;
  }
  if (lowerError.includes("network") || lowerError.includes("fetch")) {
    return errors?.networkError || errorMessage;
  }
  if (lowerError.includes("quota") || lowerError.includes("limit exceeded")) {
    return errors?.quotaExceeded || errorMessage;
  }
  if (lowerError.includes("rate limit") || lowerError.includes("too many requests")) {
    return errors?.rateLimitExceeded || errorMessage;
  }
  if (lowerError.includes("translation") && lowerError.includes("failed")) {
    return errors?.translationFailed || errorMessage;
  }
  if (lowerError.includes("generation") && lowerError.includes("failed")) {
    return errors?.generationFailed || errorMessage;
  }
  if (lowerError.includes("save") && lowerError.includes("failed")) {
    return errors?.saveFailed || errorMessage;
  }
  if (lowerError.includes("load") && lowerError.includes("failed")) {
    return errors?.loadFailed || errorMessage;
  }

  // If no specific translation found, return the original error message
  // (it might be a descriptive message that's already helpful)
  return errorMessage;
}

export function useUnifiedContentEditor(props: UseContentEditorProps): UseContentEditorReturn {
  const { config, items, shopLocales, primaryLocale, fetcher, showInfoBox, t, onTranslateToAllLocalesComplete } = props;
  const { refresh: refreshTaskCount } = useTaskCount();
  const revalidator = useRevalidator();
  // IMPORTANT: useRevalidator() returns an unstable reference that changes on
  // every React Router state change (including Shopify Admin SDK analytics).
  // Using the object directly in effect deps causes infinite re-renders.
  // Always use this ref inside effects instead.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

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
  const isAcceptAndTranslateFlowRef = useLatestRef(isAcceptAndTranslateFlow);
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
  const imageFetcher = useFetcher<{ success: boolean; images: Array<{ url: string; altText?: string }>; error?: string }>();
  const loadedImagesForProductRef = useRef<string | null>(null);

  // Alt-text state for images (indexed by image position)
  const [imageAltTexts, setImageAltTexts] = useState<Record<number, string>>({});
  const [altTextSuggestions, setAltTextSuggestions] = useState<Record<number, string>>({});
  // Track original alt-texts to detect changes (using state to trigger re-renders)
  const [originalAltTexts, setOriginalAltTexts] = useState<Record<number, string>>({});
  const imageAltTextsRef = useLatestRef(imageAltTexts);
  const originalAltTextsRef = useLatestRef(originalAltTexts);

  // Track pending auto-save for alt-texts (set by bulk generation and translation effects)
  const pendingAltTextAutoSaveRef = useRef<Record<number, string> | null>(null);

  // Send Image to AI feature state
  const [sendImageToAI, setSendImageToAI] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  // Retry mechanism for empty fields
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 300;

  // ============================================================================
  // UI DATA LOADER — Centralized data resolution and cache management
  // Refs and resolve() logic live in useUiDataLoader. Destructured here for
  // backward compatibility so existing code doesn't need to change ref names.
  // ============================================================================
  const dataLoader = useUiDataLoader({ config, primaryLocale });
  const {
    refs: {
      deletedTranslationKeysRef,
      localTranslationsRef,
      savedPrimaryValuesRef,
      originalLoadedValuesRef,
      originalTemplateValuesRef,
    },
    templateValuesVersion,
    setTemplateValuesVersion,
  } = dataLoader;

  // Track which fields are showing fallback values (e.g., handle field showing primary locale value)
  // This happens when Shopify doesn't return a translation because it's identical to the primary value
  const [fallbackFields, setFallbackFields] = useState<Set<string>>(new Set());

  const fallbackFieldsRef = useLatestRef(fallbackFields);

  // NOTE: originalLoadedValuesRef now lives in useUiDataLoader (destructured above)

  // Track which fields have AI actions currently running (for per-field loading states)
  // This allows multiple AI actions to run in parallel on different fields
  const [loadingFieldKeys, setLoadingFieldKeys] = useState<Set<string>>(new Set());

  // Track if initial data load was successful - disables retry mechanism after successful load
  // Reset when item or language changes, allowing retry during new load cycles
  const initialLoadSuccessfulRef = useRef(false);

  // NOTE: savedPrimaryValuesRef now lives in useUiDataLoader (destructured above)

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

  // Hybrid image loading + image cloning:
  // - If images exist in DB -> clone for alt-text mutations
  // - If no images in DB -> merge on-demand images from Shopify API
  //
  // Items are now READ-ONLY (Phase 4) — translations, seo, translatableContent are never
  // mutated. Only image alt-texts are still mutated in-place, so only images need cloning.
  const selectedItem = useMemo(() => {
    if (!baseSelectedItem) return undefined;

    const hasDbImages = baseSelectedItem.images && baseSelectedItem.images.length > 0;

    // Only create a shallow copy when images need cloning or merging
    if (hasDbImages) {
      return {
        ...baseSelectedItem,
        images: baseSelectedItem.images!.map((img: ContentImage) => ({
          ...img,
          altTextTranslations: img.altTextTranslations
            ? img.altTextTranslations.map((t: AltTextTranslation) => ({ ...t }))
            : [],
        })),
      };
    }

    if (
      onDemandImages.length > 0 &&
      loadedImagesForProductRef.current === selectedItemId
    ) {
      return { ...baseSelectedItem, images: onDemandImages };
    }

    // No image handling needed — use item directly
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
        const images: ContentImage[] = imageFetcher.data.images.map((img) => ({
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

  const effectiveFieldDefinitionsRef = useLatestRef(effectiveFieldDefinitions);

  // Resolve a raw field key to a human-readable label (for info box messages)
  const resolveFieldLabel = useCallback((fieldKey: string): string => {
    // Look up in effective field definitions first
    const fieldDef = effectiveFieldDefinitions.find(f => f.key === fieldKey);
    if (fieldDef?.label) return fieldDef.label;
    // For template-style keys (contain dots or colons), use extractReadableName
    if (fieldKey.includes('.') || fieldKey.includes(':')) {
      return extractReadableName(fieldKey);
    }
    return fieldKey;
  }, [effectiveFieldDefinitions]);

  // Navigation guard
  const {
    pendingNavigation,
    highlightSaveButton,
    saveButtonRef,
    handleNavigationAttempt,
    clearPendingNavigation,
  } = useNavigationGuard();

  // Change tracking - only track changes if we're not currently loading data
  // For templates and metaobjects, use custom dynamic field comparison
  const standardHasFieldChanges = useChangeTracking(
    isLoadingData ? null : (config.contentType !== 'templates' && config.contentType !== 'metaobjects' ? (selectedItem || null) : null), // Skip for templates & metaobjects
    currentLanguage,
    primaryLocale,
    editableValues,
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

    // Compare only the current page's fields (originalValues keys) with editable values.
    // editableValues may contain stale keys from previous pages, so we must iterate
    // over originalValues to avoid false positives after pagination changes.
    const diffs: Array<{ key: string; original: string; current: string }> = [];
    for (const [key, originalValue] of Object.entries(originalValues)) {
      const currentValue = editableValues[key] ?? "";
      if (currentValue !== originalValue) {
        diffs.push({ key, original: originalValue.slice(0, 60), current: currentValue.slice(0, 60) });
      }
    }
    if (diffs.length > 0) {
      return true;
    }
    return false;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- templateValuesVersion forces recalc when ref updates
  }, [config.contentType, isLoadingData, selectedItem, editableValues, templateValuesVersion]);

  // Metaobjects-specific change detection: compare editableValues with originalLoadedValuesRef
  // Metaobject field keys are dynamic IDs (e.g. "gid://shopify/Metaobject/123") that
  // useChangeTracking doesn't know about, so we compare against the loaded baseline directly.
  const metaobjectsHasFieldChanges = useMemo(() => {
    if (config.contentType !== 'metaobjects' || isLoadingData || !selectedItem) {
      return false;
    }

    const originalValues = originalLoadedValuesRef.current;
    if (!originalValues || Object.keys(originalValues).length === 0) {
      return false;
    }

    for (const [key, originalValue] of Object.entries(originalValues)) {
      const currentValue = editableValues[key] ?? "";
      if (currentValue !== originalValue) {
        return true;
      }
    }
    return false;
  }, [config.contentType, isLoadingData, selectedItem, editableValues]);

  // Combined field changes: use type-specific logic for templates/metaobjects, standard for others
  const hasFieldChanges = config.contentType === 'templates'
    ? templateHasFieldChanges
    : config.contentType === 'metaobjects'
      ? metaobjectsHasFieldChanges
      : standardHasFieldChanges;

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

  // Track previous translation signal to detect lazy-loaded translations
  const prevTranslationSignalRef = useRef<number>(0);

  const selectedItemRef = useLatestRef(selectedItem);

  // Stable signal that changes when translations arrive for the selected item.
  // When the loader delivers fresh data after lazy-load / revalidation, the
  // translation count jumps from 0 → N.  The data-loading effect depends on
  // this so it re-resolves field values automatically.
  const selectedItemTranslationSignal = useMemo(() => {
    if (!selectedItemId) return 0;
    const item = items.find(i => i.id === selectedItemId);
    return item?.translations?.length ?? 0;
  }, [items, selectedItemId]);

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
    // 4. Translations arrived for the selected item (lazy-load / revalidation)
    // NOTE: Use separate ref from image loading to avoid race condition
    const itemIdChanged = prevItemIdForDataLoadRef.current !== selectedItemId;
    const languageChanged = prevCurrentLanguageRef.current !== currentLanguage;
    const refreshTriggered = prevDataRefreshTriggerRef.current !== dataRefreshTrigger;
    const translationsArrived = prevTranslationSignalRef.current !== selectedItemTranslationSignal;

    if (!itemIdChanged && !languageChanged && !refreshTriggered && !translationsArrived) {
      // Don't log on skip to reduce console spam
      return;
    }


    if (translationsArrived && !refreshTriggered && !languageChanged && !itemIdChanged) {
      debugLog.dataLoad(` Translations arrived for item (${prevTranslationSignalRef.current} → ${selectedItemTranslationSignal}) — re-resolving fields`);
    }

    // Update refs
    prevItemIdForDataLoadRef.current = selectedItemId;
    prevCurrentLanguageRef.current = currentLanguage;
    prevDataRefreshTriggerRef.current = dataRefreshTrigger;
    prevTranslationSignalRef.current = selectedItemTranslationSignal;

    if (refreshTriggered) {
      debugLog.dataLoad(' Data refresh triggered by ReloadButton');
      dataLoader.onRefresh(selectedItemId);

      // For templates, skip loading from stale item data after a reload.
      // The page-level reload effect (app.templates.tsx) fetches fresh data from the API
      // and updates editable values directly. Reading from item.translatableContent here
      // would use stale cached data and cause a race condition (stale values overwriting fresh).
      if (config.contentType === 'templates') {
        debugLog.dataLoad(' Templates refresh - skip stale data load, page-level effect handles update');
        return;
      }
    }

    // Mark as loading immediately
    setIsLoadingData(true);

    // Reset accept-and-translate flag when changing items or languages
    setIsAcceptAndTranslateFlow(false);

    // Reset retry mechanism flags when changing items or languages (allow fresh retries)
    initialLoadSuccessfulRef.current = false;
    retryCountRef.current = 0;

    // Clear data caches and processed response refs when switching to a different item
    if (itemIdChanged) {
      dataLoader.onItemSwitch();
      processedSaveResponseRef.current = null;
      isSavePendingRef.current = false;
      processedTranslateFieldRef.current = null;
      processedTranslateAltTextAllRef.current = null;
      processedTranslateAllRef.current = null;
      processedTranslateAllForLocaleRef.current = null;
      acceptedPrimaryValueRef.current = null;
      setIsInitialDataReady(false); // Reset data ready flag for new item
      debugLog.dataLoad(' Cleared refs for new item');
    }

    // Resolve all field values via the centralized UiDataLoader
    const fieldDefs = effectiveFieldDefinitionsRef.current;
    const { values: newValues, fallbackFields: newFallbackFields } = dataLoader.resolveAll(
      item,
      currentLanguage,
      fieldDefs
    );

    setFallbackFields(newFallbackFields);

    // Snapshot the loaded values so buildFieldsForSave() can later compare against them.
    // Without this, every save in a foreign locale would re-send ALL fields to Shopify,
    // including unchanged ones like handle, which causes "handle already taken" errors.
    originalLoadedValuesRef.current = { ...newValues };

    setEditableValues(newValues);

    // For templates: Store original values for change detection
    if (config.contentType === 'templates') {
      debugLog.dataLoad(' Setting originalTemplateValuesRef:', newValues);
      originalTemplateValuesRef.current = { ...newValues };
      setTemplateValuesVersion(v => v + 1);
    }
    // IMPORTANT: Deps are kept minimal to prevent unnecessary re-runs.
    // selectedItemTranslationSignal is stable (only changes when translation count changes)
    // so it won't cause extra re-runs during normal editing.
  }, [selectedItemId, currentLanguage, primaryLocale, config, dataRefreshTrigger, selectedItemTranslationSignal]);

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

  // Guard against synchronous double-submit: Remix doesn't update fetcher.state
  // synchronously after submit(), so two safeSubmit calls in the same tick would
  // both see state === 'idle' and the second submit would abort the first.
  const justSubmittedRef = useRef(false);

  // Safe submit helper that catches AbortError from Shopify admin interference
  // The AbortError can be thrown when Shopify admin's own requests interfere with ours,
  // but the submit usually still works, so we just log and ignore the error
  // IMPORTANT: Uses fetcherRef to avoid dependency on fetcher which changes frequently
  const safeSubmit = useCallback((data: Record<string, any>, options?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }) => {
    debugLog.submit(' Submitting data:', data);
    debugLog.submit(' Options:', options);

    // Convert data object to FormData for proper Shopify embedded app compatibility
    // Using plain objects doesn't trigger fetcher state changes in embedded context
    const formData = new FormData();
    Object.entries(data).forEach(([key, value]) => {
      formData.append(key, String(value));
    });

    // If the fetcher is already in-flight OR we just submitted synchronously,
    // queue this save instead of aborting the current one.
    // Remix aborts the previous request when submit() is called concurrently, which loses saves.
    if (fetcherRef.current.state !== 'idle' || justSubmittedRef.current) {
      debugLog.submit(' Fetcher busy (state:', fetcherRef.current.state, ', justSubmitted:', justSubmittedRef.current, '), queuing save for locale:', savedLocaleRef.current);
      saveQueueRef.current.push({
        formData,
        options: options || { method: "POST" },
        savedLocale: savedLocaleRef.current,
      });
      return;
    }

    try {
      // Mark as just-submitted so any synchronous safeSubmit calls after this
      // one will queue instead of aborting this request
      justSubmittedRef.current = true;
      fetcherRef.current.submit(formData, options || { method: "POST" });
    } catch (error) {
      console.error('❌ [safeSubmit] Error caught:', error);
      justSubmittedRef.current = false;
      // AbortError can be thrown when Shopify admin interferes, but data is usually saved
      if (error instanceof Error && error.name === 'AbortError') {
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
    data: Record<string, string>,
    fieldKey: string,
    onSuccess?: (result: Record<string, unknown>) => void,
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
        // Immediately refresh the running task count via context
        refreshTaskCount();
        onSuccess?.(result);
      } else {
        // Always show error feedback — even if the server omitted the error field
        const errorMsg = result.error || "Unknown error";
        onError?.(errorMsg);
        const translatedError = translateErrorMessage(errorMsg, t);
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
      const index = parseInt(indexStr, 10);
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

    // Pass policyType for ShopPolicy primary locale updates (required by Shopify API)
    if (config.resourceType === "ShopPolicy" && selectedItem?.type) {
      formDataObj.policyType = selectedItem.type;
    }

    // Add field values - for foreign locales, only send fields that actually changed
    Object.assign(formDataObj, buildFieldsForSave(valuesToSave, locale));

    // Add image alt-texts ONLY if they actually changed (avoid sending unchanged alt-texts
    // which would trigger unnecessary Shopify API calls that fail when primary alt-text has no digest)
    if (Object.keys(imageAltTexts).length > 0) {
      const origAltTexts = originalAltTextsRef.current;
      const changedAltTexts: Record<number, string> = {};
      for (const [key, value] of Object.entries(imageAltTexts)) {
        const numKey = Number(key);
        if (origAltTexts[numKey] !== value) {
          changedAltTexts[numKey] = value;
        }
      }
      if (Object.keys(changedAltTexts).length > 0) {
        formDataObj.imageAltTexts = JSON.stringify(changedAltTexts);
        debugLog.autoSave(' 🖼️ imageAltTexts being sent (changed only):', JSON.stringify(changedAltTexts));
      }
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
    if (fetcher.data?.success && (fetcher.data.actionType === "generateAIText" || fetcher.data.actionType === "formatAIText")) {
      const { fieldType, generatedContent } = fetcher.data as GeneratedContentResponse;
      setAiSuggestions((prev) => ({
        ...prev,
        [fieldType]: generatedContent,
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
  const lastFetcherDataRef = useRef<FetcherData | null>(null);

  // Ref to track the locale that was active when the save was initiated
  const savedLocaleRef = useRef<string | null>(null);

  // FIFO queue for saves when the fetcher is already in-flight.
  // Without this, calling fetcher.submit() while a request is pending causes Remix to
  // ABORT the in-flight request, losing the first save and corrupting savedLocaleRef.
  const saveQueueRef = useRef<Array<{
    formData: FormData;
    options: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" };
    savedLocale: string | null;
  }>>([]);

  // NOTE: skipNextDataLoadRef was removed in Phase 4 (read-only items).
  // resolve() now computes correct values purely from ref overlays, so
  // the data-load effect always produces the right result without skipping.

  const editableValuesRef = useLatestRef(editableValues);

  // Ref to track processed translateField responses (prevents duplicate processing/infinite loops)
  const processedTranslateFieldRef = useRef<string | null>(null);

  // Ref to track processed save responses (prevents duplicate InfoBox/revalidation on re-renders)
  const processedSaveResponseRef = useRef<FetcherData | null>(null);

  // Ref to track processed translateAltTextToAllLocales responses (prevents infinite revalidation loop)
  const processedTranslateAltTextAllRef = useRef<FetcherData | null>(null);
  const processedTranslateAllRef = useRef<FetcherData | null>(null);
  const processedTranslateAllForLocaleRef = useRef<FetcherData | null>(null);

  // Ref to track whether a save operation is actually pending (prevents false "saved" messages on revalidation)
  const isSavePendingRef = useRef(false);
  // Ref to suppress the generic "Changes saved" toast when the save was triggered by a translate action
  // (the translate callback already shows its own specific toast)
  const isSaveFromTranslateRef = useRef(false);

  // Handle translated field response (single field translation)
  // Auto-save immediately after receiving translation
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.actionType === "translateField") {
      const { fieldType, translatedValue, targetLocale } = fetcher.data as TranslatedValueResponse;

      // Create a unique key for this response to prevent duplicate processing
      const responseKey = `translateField-${fieldType}-${targetLocale}-${translatedValue?.substring(0, 20)}`;
      if (processedTranslateFieldRef.current === responseKey) {
        return; // Already processed this response
      }
      processedTranslateFieldRef.current = responseKey;

      const field = effectiveFieldDefinitions.find(f => f.key === fieldType);

      if (field?.translationKey) {
        // Delegate ref mutations to transition method
        const result = dataLoader.onTranslateFieldComplete(
          fieldType,
          field.translationKey,
          translatedValue,
          targetLocale,
          editableValuesRef.current
        );

        // Apply UI updates from transition result
        if (result.updatedValues) {
          setEditableValues(result.updatedValues);
        }

        // Clear fallback styling
        if (result.clearedFallbackKeys.length > 0) {
          setFallbackFields((prev) => {
            const newSet = new Set(prev);
            result.clearedFallbackKeys.forEach((key) => newSet.delete(key));
            return newSet;
          });
          result.clearedFallbackKeys.forEach((key) =>
            fallbackFieldsRef.current.delete(key)
          );
        }

        if (result.shouldMarkLoading) {
          setIsLoadingData(true);
        }
      }

      // Auto-save the translation immediately
      if (selectedItemId && field) {
        const newValues = { ...editableValuesRef.current, [fieldType]: translatedValue };
        const formDataObj: Record<string, string> = {
          action: "updateContent",
          itemId: selectedItemId,
          locale: targetLocale,
          primaryLocale,
        };
        Object.assign(formDataObj, buildFieldsForSave(newValues, targetLocale));

        // Ensure the translated field is always included in the save
        if (translatedValue && translatedValue.trim()) {
          formDataObj[fieldType] = translatedValue;
        }

        savedLocaleRef.current = targetLocale;
        isSavePendingRef.current = true;
        safeSubmit(formDataObj, { method: "POST" });
      }
    }
  }, [fetcher.data, selectedItemId, primaryLocale, effectiveFieldDefinitions, safeSubmit, buildFieldsForSave]);

  // Handle single alt-text generation (show as suggestion)
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.actionType === "generateAltText") {
      const { altText, imageIndex } = fetcher.data as AltTextResponse;
      setAltTextSuggestions(prev => ({
        ...prev,
        [imageIndex]: altText
      }));
    }
  }, [fetcher.data]);

  // Handle translated alt-text response (auto-save)
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.actionType === "translateAltText") {
      const { translatedAltText, imageIndex } = fetcher.data as TranslatedAltTextResponse;
      debugLog.altText(' Setting translated alt-text for image', imageIndex, ':', translatedAltText);

      // Merge with existing alt-texts using functional form to avoid stale closure
      setImageAltTexts(prev => {
        const updated = { ...prev, [imageIndex]: translatedAltText };
        // Set original to match so hasChanges = false after save
        setOriginalAltTexts(updated);
        // Schedule auto-save
        pendingAltTextAutoSaveRef.current = updated;
        return updated;
      });
    }
  }, [fetcher.data]); // Note: imageAltTexts intentionally not in deps to avoid loops

  // Handle translated alt-text to all locales response (show success message + revalidate)
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.actionType === "translateAltTextToAllLocales") {
      // Skip if already processed (prevents infinite loop: revalidator dep change re-triggers this effect)
      if (fetcher.data === processedTranslateAltTextAllRef.current) {
        return;
      }
      processedTranslateAltTextAllRef.current = fetcher.data;

      const { targetLocales, imageIndex, failedLocales } = fetcher.data as TranslatedAltTextsResponse;
      const failed = failedLocales || [];
      debugLog.altText(' Translations to all locales completed for image', imageIndex);

      // Clean up refs left over from the queued safeSubmit (translateAltTextToAllLocales
      // is not an updateContent action, so the normal save response handler never resets these)
      isSavePendingRef.current = false;
      savedLocaleRef.current = null;

      if (failed.length > 0) {
        const failedList = failed.join(", ");
        showInfoBox(
          String(t.content?.altTextPartialLocales || "Alt-text for image {imageNumber} partially translated. Language(s) {failedLocales} could not be saved to Shopify. Please sync the product again.")
            .replace("{imageNumber}", String((imageIndex || 0) + 1))
            .replace("{failedLocales}", failedList),
          "warning",
          t.common?.warning || "Warning"
        );
      } else {
        showInfoBox(
          String(t.content?.altTextTranslatedToAllLocales || "Alt-text for image {imageNumber} translated to {count} language(s)")
            .replace("{imageNumber}", String((imageIndex || 0) + 1))
            .replace("{count}", String(targetLocales.length)),
          "success",
          t.common?.success || "Success"
        );
      }

      // Revalidate to fetch fresh data with the new translations
      if (revalidatorRef.current.state === 'idle') {
        try {
          debugLog.altText(' Triggering revalidation after translate to all locales');
          revalidatorRef.current.revalidate();
        } catch (error) {
          debugLog.altText(' Revalidation error (ignored):', error);
        }
      }
    }
  }, [fetcher.data]);

  // Execute pending alt-text auto-save
  useEffect(() => {
    const pendingAltTexts = pendingAltTextAutoSaveRef.current;
    if (!pendingAltTexts || !selectedItemId) return;

    // Clear the pending save ref immediately to prevent re-execution
    pendingAltTextAutoSaveRef.current = null;

    debugLog.altText(' Executing auto-save for alt-texts:', pendingAltTexts);

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
    if (fetcher.data?.success && fetcher.data.actionType === "translateAll") {
      // Prevent re-processing when effectiveFieldDefinitions change (e.g. after Remix revalidation)
      if (fetcher.data === processedTranslateAllRef.current) return;
      processedTranslateAllRef.current = fetcher.data;

      const { translations, failedLocales } = fetcher.data as TranslationsResponse;
      {
        // Delegate ref mutations to transition method
        const translationsMap = translations as Record<string, Record<string, string>>;
        const result = dataLoader.onTranslateAllComplete(
          translationsMap,
          effectiveFieldDefinitions,
          currentLanguage,
          editableValues
        );

        // Apply UI updates from transition result
        if (result.updatedValues) {
          setEditableValues(result.updatedValues);
        }

        if (result.clearedFallbackKeys.length > 0) {
          setFallbackFields((prev) => {
            const newSet = new Set(prev);
            result.clearedFallbackKeys.forEach((key) => newSet.delete(key));
            return newSet;
          });
          fallbackFieldsRef.current = new Set(
            [...fallbackFieldsRef.current].filter(
              (key) => !result.clearedFallbackKeys.includes(key)
            )
          );
        }

        if (result.shouldMarkLoading) {
          setIsLoadingData(true);
        }

        // Show warning if some locales failed or fields were rejected/skipped, success if all succeeded
        const failed = failedLocales || [];
        const rejected = (fetcher.data as TranslationsResponse).rejectedFields || {};
        const rejectedLocales = Object.keys(rejected);
        const skipped = (fetcher.data as TranslationsResponse).skippedFields || {};
        const skippedLocales = Object.keys(skipped);

        if (failed.length > 0 || rejectedLocales.length > 0 || skippedLocales.length > 0) {
          const messages: string[] = [];

          if (failed.length > 0) {
            const failedList = failed.join(", ");
            const totalLocales = Object.keys(translations).length + failed.length;
            const successCount = Object.keys(translations).filter(
              (l: string) => Object.keys((translations as Record<string, Record<string, string>>)[l] || {}).length > 0
            ).length;
            messages.push(
              String(t.content?.translatePartialLocales || "Translation partially completed: {successCount}/{totalCount} language(s) succeeded. Language(s) {failedLocales} failed.")
                .replace("{successCount}", String(successCount))
                .replace("{totalCount}", String(totalLocales))
                .replace("{failedLocales}", failedList)
            );
          }

          if (rejectedLocales.length > 0) {
            const details = rejectedLocales
              .map(locale => `${locale}: ${rejected[locale].map(k => resolveFieldLabel(k)).join(", ")}`)
              .join("; ");
            messages.push(
              String(t.content?.translateRejectedFields || "Some fields could not be saved to Shopify: {details}. The translated content was generated but Shopify rejected it.")
                .replace("{details}", details)
            );
          }

          if (skippedLocales.length > 0) {
            const details = skippedLocales
              .map(locale => `${locale}: ${skipped[locale].map(k => resolveFieldLabel(k)).join(", ")}`)
              .join("; ");
            messages.push(
              String(t.content?.translateSkippedFields || "Some fields were skipped because the translated value is identical to the primary locale: {details}.")
                .replace("{details}", details)
            );
          }

          showInfoBox(
            messages.join(" "),
            "warning",
            t.common?.warning || "Warning"
          );
        } else {
          const localeCount = Object.keys(translations).length;
          showInfoBox(
            String(t.content?.translateAllSuccess || "Successfully translated to {count} language(s).")
              .replace("{count}", String(localeCount)),
            "success",
            t.common?.success || "Success"
          );
        }
      }
    }
  }, [fetcher.data, currentLanguage, effectiveFieldDefinitions, config.contentType, showInfoBox, t]); // Use selectedItemRef instead of selectedItem

  // Handle "translateAllForLocale" response (translates to ONE specific locale)
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.actionType === "translateAllForLocale") {
      // Prevent re-processing when effectiveFieldDefinitions change (e.g. after Remix revalidation)
      if (fetcher.data === processedTranslateAllForLocaleRef.current) return;
      processedTranslateAllForLocaleRef.current = fetcher.data;

      const { targetLocale, failedLocales } = fetcher.data as TranslationsResponse & { targetLocale: string };
      const translations = (fetcher.data as TranslationsResponse).translations as Record<string, string>;
      {
        // Delegate ref mutations to transition method
        const result = dataLoader.onTranslateAllForLocaleComplete(
          translations,
          effectiveFieldDefinitions,
          targetLocale,
          currentLanguage,
          editableValues
        );

        // Apply UI updates from transition result
        if (result.updatedValues) {
          setEditableValues(result.updatedValues);
        }

        if (result.clearedFallbackKeys.length > 0) {
          setFallbackFields((prev) => {
            const newSet = new Set(prev);
            result.clearedFallbackKeys.forEach((key) => newSet.delete(key));
            return newSet;
          });
          fallbackFieldsRef.current = new Set(
            [...fallbackFieldsRef.current].filter(
              (key) => !result.clearedFallbackKeys.includes(key)
            )
          );
        }

        if (result.shouldMarkLoading) {
          setIsLoadingData(true);
        }

        // Show warning if the locale failed or fields were rejected/skipped, success otherwise
        const failed = failedLocales || [];
        const rejected = (fetcher.data as TranslationsResponse).rejectedFields || {};
        const rejectedForLocale = rejected[targetLocale];
        const skipped = (fetcher.data as TranslationsResponse).skippedFields || {};
        const skippedForLocale = skipped[targetLocale];

        if (failed.length > 0 && failed.includes(targetLocale)) {
          showInfoBox(
            String(t.content?.translateLocaleError || "Translation to {locale} failed. Please try again.")
              .replace("{locale}", targetLocale),
            "warning",
            t.common?.warning || "Warning"
          );
        } else if ((rejectedForLocale && rejectedForLocale.length > 0) || (skippedForLocale && skippedForLocale.length > 0)) {
          const messages: string[] = [];
          if (rejectedForLocale && rejectedForLocale.length > 0) {
            messages.push(
              String(t.content?.translateLocaleRejectedFields || "Translation to {locale} partially completed. Field(s) {fields} could not be saved to Shopify.")
                .replace("{locale}", targetLocale)
                .replace("{fields}", rejectedForLocale.join(", "))
            );
          }
          if (skippedForLocale && skippedForLocale.length > 0) {
            messages.push(
              String(t.content?.translateSkippedFields || "Some fields were skipped because the translated value is identical to the primary locale: {details}.")
                .replace("{details}", `${targetLocale}: ${skippedForLocale.join(", ")}`)
            );
          }
          showInfoBox(
            messages.join(" "),
            "warning",
            t.common?.warning || "Warning"
          );
        } else {
          showInfoBox(
            t.common?.translatedSuccessfully || `Successfully translated to ${targetLocale}`,
            "success",
            t.common?.success || "Success"
          );
        }
      }
    }
  }, [fetcher.data, currentLanguage, effectiveFieldDefinitions, showInfoBox, t, config.contentType]); // Use selectedItemRef instead of selectedItem

  // Update item object after saving (both primary locale and translations)
  // IMPORTANT: We track which fetcher.data we've processed to prevent re-running on language change
  useEffect(() => {
    const item = selectedItemRef.current;
    if (fetcher.data?.success && fetcher.data.actionType === "updateContent" && item) {
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

      // Delegate ref mutations to transition method
      const result = dataLoader.onSaveComplete(
        savedLocale,
        editableValues,
        effectiveFieldDefinitions
      );

      // Image alt-text updates (not managed by dataLoader — separate concern)
      if (savedLocale === primaryLocale) {
        if (item.images && Object.keys(imageAltTextsRef.current).length > 0) {
          for (const [indexStr, altText] of Object.entries(imageAltTextsRef.current)) {
            const index = parseInt(indexStr, 10);
            if (item.images[index]) {
              item.images[index].altText = altText;
              debugLog.response(' Updated primary alt-text for image', index);
            }
          }
        }
      } else {
        if (item.images && Object.keys(imageAltTextsRef.current).length > 0) {
          for (const [indexStr, altText] of Object.entries(imageAltTextsRef.current)) {
            const index = parseInt(indexStr, 10);
            if (item.images[index]) {
              if (!item.images[index].altTextTranslations) {
                item.images[index].altTextTranslations = [];
              }
              item.images[index].altTextTranslations = item.images[index].altTextTranslations.filter(
                (t: AltTextTranslation) => t.locale !== savedLocale
              );
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
      setOriginalAltTexts({ ...imageAltTextsRef.current });
      debugLog.response(' Updated originalAltTexts:', { ...imageAltTextsRef.current });

      // Clear the saved locale ref after processing
      savedLocaleRef.current = null;

      if (result.shouldMarkLoading) {
        setIsLoadingData(true);
      }
    }
  }, [fetcher.data, primaryLocale, editableValues, effectiveFieldDefinitions]); // Removed selectedItem - use ref instead

  // Show global InfoBox for success/error messages and revalidate after save
  useEffect(() => {
    // Skip if this response was already processed (prevents duplicate processing on re-renders)
    if (fetcher.data === processedSaveResponseRef.current) {
      return;
    }

    // Skip if no save was actually initiated (prevents false "saved" messages during reload/revalidation)
    if (!isSavePendingRef.current) {
      return;
    }

    if (fetcher.data?.success && fetcher.data.actionType === "updateContent") {
      // Mark this response as processed and clear save pending flag
      processedSaveResponseRef.current = fetcher.data;
      isSavePendingRef.current = false;

      // Check if there's a pending translation to start after this save
      if (pendingTranslationAfterSaveRef.current) {
        const { fieldKey, sourceText, targetLocales, contextTitle, itemId } = pendingTranslationAfterSaveRef.current;
        pendingTranslationAfterSaveRef.current = null;

        debugLog.acceptAndTranslate(' Save completed, now starting translation');

        // For templates: Update originalTemplateValuesRef IMMEDIATELY after save completes,
        // before the translation starts. Otherwise isLoadingData flips back to false (10ms timer)
        // while the translation is still in-flight, and the stale originalTemplateValuesRef
        // causes templateHasFieldChanges to return true → save button flickers active.
        if (config.contentType === 'templates') {
          originalTemplateValuesRef.current = { ...editableValuesRef.current };
          setTemplateValuesVersion(v => v + 1);
        }

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
            const translations = result.translations as Record<string, string>;
            const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
            const shopifyKey = field?.translationKey;
            const item = selectedItemRef.current;

            if (shopifyKey) {
              // Delegate ref mutations to transition method
              dataLoader.onTranslateFieldToAllLocalesComplete(
                shopifyKey,
                translations as Record<string, string>,
                currentLanguage
              );

              // If the current language is one of the translated languages, update editableValues
              if (translations[currentLanguage]) {

                setEditableValues(prev => ({
                  ...prev,
                  [fieldKey]: translations[currentLanguage]
                }));
              } else if (currentLanguage === primaryLocale && acceptedPrimaryValueRef.current?.fieldKey === fieldKey) {
                // Restore the accepted primary value (translation response only contains foreign languages)
                // Capture value BEFORE passing to setState updater — the ref is cleared
                // synchronously below, but React may execute the updater later in a batch,
                // at which point the ref would already be null → crash.
                const acceptedValue = acceptedPrimaryValueRef.current.value;
                setEditableValues(prev => ({
                  ...prev,
                  [fieldKey]: acceptedValue
                }));
              }

              // Clear the accepted primary value ref after processing
              acceptedPrimaryValueRef.current = null;
            }

            const failedFieldLocales = (result.failedLocales as string[]) || [];
            const rejected = (result.rejectedFields as Record<string, string[]>) || {};
            const rejectedLocales = Object.keys(rejected);
            const skipped = (result.skippedFields as Record<string, string[]>) || {};
            const skippedLocales = Object.keys(skipped);

            if (failedFieldLocales.length > 0 || rejectedLocales.length > 0 || skippedLocales.length > 0) {
              const messages: string[] = [];

              if (failedFieldLocales.length > 0) {
                const failedList = failedFieldLocales.join(", ");
                messages.push(
                  String(t.content?.translatePartialLocales || "Translation partially completed: {successCount}/{totalCount} language(s) succeeded. Language(s) {failedLocales} failed.")
                    .replace("{successCount}", String(Object.keys(translations).length))
                    .replace("{totalCount}", String(Object.keys(translations).length + failedFieldLocales.length))
                    .replace("{failedLocales}", failedList)
                );
              }

              if (rejectedLocales.length > 0) {
                const details = rejectedLocales
                  .map(locale => `${locale}: ${rejected[locale].map(k => resolveFieldLabel(k)).join(", ")}`)
                  .join("; ");
                messages.push(
                  String(t.content?.translateRejectedFields || "Some fields could not be saved to Shopify: {details}. The translated content was generated but Shopify rejected it.")
                    .replace("{details}", details)
                );
              }

              if (skippedLocales.length > 0) {
                const details = skippedLocales
                  .map(locale => `${locale}: ${skipped[locale].map(k => resolveFieldLabel(k)).join(", ")}`)
                  .join("; ");
                messages.push(
                  String(t.content?.translateSkippedFields || "Some fields were skipped because the translated value is identical to the primary locale: {details}.")
                    .replace("{details}", details)
                );
              }

              showInfoBox(
                messages.join(" "),
                "warning",
                t.common?.warning || "Warning"
              );
            } else {
              const fieldLabel = resolveFieldLabel(fieldKey);
              showInfoBox(
                t.common?.fieldTranslatedToLanguages
                  ?.replace("{fieldType}", fieldLabel)
                  .replace("{count}", String(Object.keys(translations).length))
                  || `${fieldLabel} translated to ${Object.keys(translations).length} language(s)`,
                "success",
                t.common?.success || "Success"
              );
            }

            // Reset the accept-and-translate flow flag after translations are complete
            setIsAcceptAndTranslateFlow(false);

            // For templates: Update original values so hasChanges becomes false
            if (config.contentType === 'templates') {
              // Update with the translated value if we're viewing a foreign locale,
              // OR with the current editableValues for the primary locale (the accepted
              // AI suggestion was saved but originalTemplateValuesRef was never updated
              // because the early `return` at the end of this block skips the normal
              // post-save update at ~line 1990).
              if (translations[currentLanguage]) {
                originalTemplateValuesRef.current = {
                  ...originalTemplateValuesRef.current,
                  [fieldKey]: translations[currentLanguage]
                };
              } else if (currentLanguage === primaryLocale) {
                // Primary locale: sync all original values with current editableValues
                // so the save button correctly shows "no changes"
                const snapshot = { ...editableValuesRef.current };
                originalTemplateValuesRef.current = snapshot;
              }
              setTemplateValuesVersion(v => v + 1);
            }

            setIsLoadingData(true);
          }
        );

        // Don't revalidate yet - wait for translation to complete
        return;
      }

      // Check if any alt-text indices failed to save to Shopify
      const failedAltTextIndices = fetcher.data.failedAltTextIndices || [];
      // If this save was triggered by a translate action, the translate callback already
      // showed its own success toast — only show warnings/errors here, skip the generic "Changes saved".
      const wasTranslateSave = isSaveFromTranslateRef.current;
      isSaveFromTranslateRef.current = false;

      if (failedAltTextIndices.length > 0) {
        const failedList = failedAltTextIndices.map((i: number) => i + 1).join(", ");
        showInfoBox(
          String(t.content?.altTextSavePartialImages || "Changes saved, but alt-text for image(s) {failedImages} could not be saved to Shopify. Please sync the product again.")
            .replace("{failedImages}", failedList),
          "warning",
          t.common?.warning || "Warning"
        );
      } else if ("warning" in fetcher.data && fetcher.data.warning) {
        // Server returned success but with a warning (e.g. Shopify saved, DB cache failed)
        showInfoBox(
          String(fetcher.data.warning),
          "warning",
          t.common?.warning || "Warning"
        );
      } else if (!wasTranslateSave) {
        showInfoBox(
          t.common?.changesSaved || "Changes saved successfully!",
          "success",
          t.common?.success || "Success"
        );
      }

      // Update original alt-texts to match current values (so hasChanges becomes false)
      setOriginalAltTexts({ ...imageAltTextsRef.current });

      // For templates: Update original values to match current values (so hasChanges becomes false)
      if (config.contentType === 'templates') {
        originalTemplateValuesRef.current = { ...editableValues };
        setTemplateValuesVersion(v => v + 1); // Trigger useMemo recalculation

        // For foreign locale saves: update localTranslationsRef so isFieldTranslated
        // and hasLocaleMissingTranslations return correct results IMMEDIATELY —
        // without waiting for revalidation. No item mutation needed; resolve()
        // reads localTranslationsRef with higher priority than item.translations.
        const savedLocale = savedLocaleRef.current;
        if (savedLocale && savedLocale !== primaryLocale) {
          effectiveFieldDefinitions.forEach((field) => {
            const value = editableValues[field.key];
            const tKey = field.translationKey;

            // Update localTranslationsRef for isFieldTranslated
            if (!localTranslationsRef.current[tKey]) {
              localTranslationsRef.current[tKey] = {};
            }
            if (value && value.trim()) {
              localTranslationsRef.current[tKey][savedLocale] = value;
            } else {
              delete localTranslationsRef.current[tKey][savedLocale];
            }
          });
        }
      }

      // Mark this item as recently saved to prevent on-demand sync from re-fetching
      // stale translations from Shopify (race condition with eventual consistency)
      if (selectedItemId) {
        markRecentlySaved(selectedItemId);
      }

      // Revalidate to fetch fresh data from the database after successful save
      // This ensures translations and all changes are reflected in the UI
      // Only revalidate if not already revalidating to prevent AbortError
      if (revalidatorRef.current.state === 'idle') {
        try {
          revalidatorRef.current.revalidate();
        } catch (error) {
          // Ignore AbortError from Shopify admin interference
          debugLog.revalidate(' Error during revalidation (ignored):', error);
        }
      }
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data && isSavePendingRef.current) {
      // Also mark error responses as processed
      processedSaveResponseRef.current = fetcher.data;
      isSavePendingRef.current = false;
      isSaveFromTranslateRef.current = false;
      const translatedError = translateErrorMessage(String(fetcher.data.error || ""), t);
      showInfoBox(translatedError, "critical", t.common?.error || "Error");
    } else if (fetcher.data && !fetcher.data.success && 'errorKey' in fetcher.data && isSavePendingRef.current) {
      // ─── Handle i18n error-key responses (e.g. emptyPrimaryFieldsError) ───
      // When the server rejects a save with an errorKey, we must:
      //  1. Show the localised error message
      //  2. Restore empty fields to their original values so the UI never
      //     stays in an inconsistent (empty) state after a blocked save.
      // This auto-discard is critical for templates: Shopify permanently
      // drops fields whose primary-locale value is saved as empty, so we
      // revert the UI immediately to prevent accidental data loss.
      // ──────────────────────────────────────────────────────────────────
      processedSaveResponseRef.current = fetcher.data;
      isSavePendingRef.current = false;
      isSaveFromTranslateRef.current = false;

      const errorKey = String((fetcher.data as { errorKey?: string }).errorKey);
      const errorMessage =
        (t.content as Record<string, string>)?.[errorKey] ||
        errorKey;
      showInfoBox(errorMessage, "critical", (t.content?.error as string) || t.common?.error || "Error");

      // Auto-restore empty fields to their original values (discard empty edits)
      if (config.contentType === 'templates' && originalTemplateValuesRef.current) {
        setEditableValues(prev => {
          const restored = { ...prev };
          let restoredCount = 0;
          for (const [key, value] of Object.entries(restored)) {
            if (value.trim() === "" && originalTemplateValuesRef.current[key]) {
              restored[key] = originalTemplateValuesRef.current[key];
              restoredCount++;
            }
          }
          debugLog.submit(` Auto-restored ${restoredCount} empty fields to original values`);
          return restored;
        });
      }
    }
  }, [fetcher.data, showInfoBox, t, safeSubmit, submitAIAction, effectiveFieldDefinitions, currentLanguage, primaryLocale]);

  // Catch-all for unhandled fetcher errors (e.g. translateAll / translateAllForLocale failures).
  // Runs AFTER the save-specific handler above, so save errors that were already processed
  // (tracked via processedSaveResponseRef) are skipped to avoid double toasts.
  const processedGenericErrorRef = useRef<unknown>(null);
  useEffect(() => {
    if (!fetcher.data || fetcher.data.success) return;
    if (!('error' in fetcher.data)) return;
    // Already handled by save-specific or errorKey handler
    if (fetcher.data === processedSaveResponseRef.current) return;
    // Already handled by this catch-all
    if (fetcher.data === processedGenericErrorRef.current) return;
    processedGenericErrorRef.current = fetcher.data;

    const translatedError = translateErrorMessage(String(fetcher.data.error || ""), t);
    showInfoBox(translatedError, "critical", t.common?.error || "Error");
  }, [fetcher.data, showInfoBox, t]);

  // Clear justSubmittedRef when fetcher picks up the request (state leaves 'idle')
  // or when it returns to idle (request completed). This ensures the synchronous
  // double-submit guard in safeSubmit only blocks within the same tick.
  useEffect(() => {
    justSubmittedRef.current = false;
  }, [fetcher.state]);

  // Process queued saves when the fetcher becomes idle.
  // IMPORTANT: This effect MUST run AFTER the response handler effects above,
  // which read savedLocaleRef.current to process the completed save's response.
  // React runs effects in definition order, so placing this after ensures the
  // response handler clears savedLocaleRef before we overwrite it for the next queued save.
  useEffect(() => {
    if (fetcher.state === 'idle' && saveQueueRef.current.length > 0) {
      const next = saveQueueRef.current.shift()!;
      debugLog.submit(' Processing queued save, locale:', next.savedLocale, ', remaining in queue:', saveQueueRef.current.length);

      // Restore metadata for this queued save
      savedLocaleRef.current = next.savedLocale;
      isSavePendingRef.current = true;

      try {
        fetcherRef.current.submit(next.formData, next.options);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          debugLog.submit(' AbortError on queued save (ignored)');
        } else {
          throw error;
        }
      }
    }
  }, [fetcher.state]);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  // Wrapper for performAutoSave with default locale
  const performSaveWithValues = (valuesToSave: Record<string, string>, locale: string = currentLanguage) => {
    performAutoSave(valuesToSave, locale);
  };

  const handleSave = () => {
    if (!selectedItemId || !hasChanges) {
      return;
    }

    // Compute changed fields BEFORE the save submit so getChangedFields
    // compares against the correct current values.
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
          debugLog.translationClear(`Marked translations for field "${field.key}" (key: ${translationKey}) as deleted`);
        }
      });

      // Cache the saved values in a ref that survives revalidation.
      // resolve() checks savedPrimaryValuesRef first for primary locale.
      savedPrimaryValuesRef.current[selectedItemId] = { ...editableValues };
    }

    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };

    // Pass policyType for ShopPolicy primary locale updates (required by Shopify API)
    if (config.resourceType === "ShopPolicy" && selectedItem?.type) {
      formDataObj.policyType = selectedItem.type;
    }

    // Add field values - for foreign locales, only send fields that actually changed
    Object.assign(formDataObj, buildFieldsForSave(editableValues, currentLanguage));

    // Add image alt-texts ONLY if they actually changed (avoid sending unchanged alt-texts
    // which would trigger unnecessary Shopify API calls that fail when primary alt-text has no digest)
    if (hasAltTextChanges && Object.keys(imageAltTexts).length > 0) {
      // Filter to only include alt-texts that actually differ from the original
      const changedAltTexts: Record<number, string> = {};
      for (const [key, value] of Object.entries(imageAltTexts)) {
        const numKey = Number(key);
        if (originalAltTexts[numKey] !== value) {
          changedAltTexts[numKey] = value;
        }
      }
      if (Object.keys(changedAltTexts).length > 0) {
        formDataObj.imageAltTexts = JSON.stringify(changedAltTexts);
        debugLog.save(' 🖼️ imageAltTexts being sent (changed only):', JSON.stringify(changedAltTexts));
      }
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
    savedLocaleRef.current = currentLanguage; // Track which locale we're saving
    isSavePendingRef.current = true; // Track that a save was initiated
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
    if (!selectedItemId || !selectedItem) return;

    const currentValue = editableValues[fieldKey] || "";
    const contextTitle = editableValues.title || "";
    const contextDescription = editableValues.description || editableValues.body || "";
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;

    // Determine which image to send based on content type and sendImageToAI state
    let imageUrl: string | undefined;
    if (sendImageToAI) {
      if (config.contentType === "products") {
        // For products: use currently selected image or fallback to featured image
        const images = selectedItem.images || [];
        const featuredImage = selectedItem.featuredImage;
        imageUrl = images[selectedImageIndex]?.url || featuredImage?.url;
      } else if (config.contentType === "collections" || config.contentType === "blogs") {
        // For collections/blogs: use featured image only
        const featuredImage = selectedItem.featuredImage;
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
          [fieldKey]: result.generatedContent as string,
        }));
      }
    );
  };

  const handleFormatAI = (fieldKey: string) => {
    if (!selectedItemId || !selectedItem) return;

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
        const images = selectedItem.images || [];
        const featuredImage = selectedItem.featuredImage;
        imageUrl = images[selectedImageIndex]?.url || featuredImage?.url;
      } else if (config.contentType === "collections" || config.contentType === "blogs") {
        // For collections/blogs: use featured image only
        const featuredImage = selectedItem.featuredImage;
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
        // Handle success - set AI suggestion for format
        setAiSuggestions((prev) => ({
          ...prev,
          [fieldKey]: result.generatedContent as string,
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
        const translatedValue = result.translatedValue as string;
        if (field.translationKey) {
          // Delegate ref mutations to transition method
          const transResult = dataLoader.onTranslateFieldComplete(
            fieldKey,
            field.translationKey,
            translatedValue,
            targetLocale,
            editableValuesRef.current
          );

          // Apply UI updates
          if (transResult.updatedValues) {
            setEditableValues(transResult.updatedValues);
          }
          if (transResult.clearedFallbackKeys.length > 0) {
            setFallbackFields((prev) => {
              const newSet = new Set(prev);
              transResult.clearedFallbackKeys.forEach((key) => newSet.delete(key));
              return newSet;
            });
            transResult.clearedFallbackKeys.forEach((key) =>
              fallbackFieldsRef.current.delete(key)
            );
          }
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

          // Ensure the translated field is always included in the save.
          // buildFieldsForSave may filter it out due to stale fallbackFieldsRef
          // or originalLoadedValuesRef timing issues during async AI callbacks.
          if (translatedValue && translatedValue.trim()) {
            formDataObj[fieldKey] = translatedValue;
          }

          savedLocaleRef.current = targetLocale;
          isSavePendingRef.current = true;
          isSaveFromTranslateRef.current = true;
          safeSubmit(formDataObj, { method: "POST" });

          // Reset the baseline so the just-saved translated field isn't re-sent on the next save.
          originalLoadedValuesRef.current = { ...newValues };
        }

        // Show explicit success toast for the translation
        const fieldLabel = resolveFieldLabel(fieldKey);
        showInfoBox(
          t.common?.fieldTranslatedAndSaved
            ?.replace("{fieldType}", fieldLabel)
            || `${fieldLabel} translated and saved successfully`,
          "success",
          t.common?.success || "Success"
        );

        // For templates: Update original values so templateHasFieldChanges becomes false
        if (config.contentType === 'templates') {
          originalTemplateValuesRef.current = {
            ...originalTemplateValuesRef.current,
            [fieldKey]: translatedValue,
          };
          setTemplateValuesVersion(v => v + 1);
        }

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
        const translations = result.translations as Record<string, string> || {};
        const shopifyKey = field.translationKey;
        const item = selectedItemRef.current;
        const translationCount = Object.keys(translations).length;

        // Delegate ref mutations to transition method
        if (shopifyKey) {
          dataLoader.onTranslateFieldToAllLocalesComplete(
            shopifyKey,
            translations,
            currentLanguage
          );

          // If the current language is one of the translated languages, update editableValues immediately
          if (translations[currentLanguage]) {
            setEditableValues(prev => ({
              ...prev,
              [fieldKey]: translations[currentLanguage]
            }));
          }
        }

        // Always show feedback — even if item ref was cleared during the async call.
        // The translations were saved server-side regardless.
        const failedFieldLocales2 = (result.failedLocales as string[]) || [];
        const rejected2 = (result.rejectedFields as Record<string, string[]>) || {};
        const rejectedLocales2 = Object.keys(rejected2);
        const skipped2 = (result.skippedFields as Record<string, string[]>) || {};
        const skippedLocales2 = Object.keys(skipped2);

        if (failedFieldLocales2.length > 0 || rejectedLocales2.length > 0 || skippedLocales2.length > 0) {
          const messages: string[] = [];

          if (failedFieldLocales2.length > 0) {
            const failedList = failedFieldLocales2.join(", ");
            messages.push(
              String(t.content?.translatePartialLocales || "Translation partially completed: {successCount}/{totalCount} language(s) succeeded. Language(s) {failedLocales} failed.")
                .replace("{successCount}", String(translationCount))
                .replace("{totalCount}", String(translationCount + failedFieldLocales2.length))
                .replace("{failedLocales}", failedList)
            );
          }

          if (rejectedLocales2.length > 0) {
            const details = rejectedLocales2
              .map(locale => `${locale}: ${rejected2[locale].map(k => resolveFieldLabel(k)).join(", ")}`)
              .join("; ");
            messages.push(
              String(t.content?.translateRejectedFields || "Some fields could not be saved to Shopify: {details}. The translated content was generated but Shopify rejected it.")
                .replace("{details}", details)
            );
          }

          if (skippedLocales2.length > 0) {
            const details = skippedLocales2
              .map(locale => `${locale}: ${skipped2[locale].map(k => resolveFieldLabel(k)).join(", ")}`)
              .join("; ");
            messages.push(
              String(t.content?.translateSkippedFields || "Some fields were skipped because the translated value is identical to the primary locale: {details}.")
                .replace("{details}", details)
            );
          }

          showInfoBox(
            messages.join(" "),
            "warning",
            t.common?.warning || "Warning"
          );
        } else {
          const fieldLabel2 = resolveFieldLabel(fieldKey);
          const toastMsg = t.common?.fieldTranslatedToLanguages
              ?.replace("{fieldType}", fieldLabel2)
              .replace("{count}", String(translationCount))
              || `${fieldLabel2} translated to ${translationCount} language(s)`;
          showInfoBox(toastMsg, "success", t.common?.success || "Success");
        }

        // For templates: Update original value so hasChanges becomes false after translation
        if (config.contentType === 'templates' && translations[currentLanguage]) {
          originalTemplateValuesRef.current = {
            ...originalTemplateValuesRef.current,
            [fieldKey]: translations[currentLanguage]
          };
          setTemplateValuesVersion(v => v + 1);
        }

        // Call callback to update cache if provided
        if (onTranslateToAllLocalesComplete) {
          onTranslateToAllLocalesComplete(fieldKey, translations as Record<string, string>);
        }

        // Revalidate to fetch fresh data with the new translations
        if (revalidatorRef.current.state === 'idle') {
          revalidatorRef.current.revalidate();
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
            const translatedCount = (result.translatedCount as number) || 0;
            const imageCount = (result.imageCount as number) || 0;
            const failedImages: number[] = (result.failedImages as number[]) || [];

            if (failedImages.length > 0) {
              const failedList = failedImages.map((i: number) => i + 1).join(", ");
              showInfoBox(
                String(t.content?.altTextTranslateAllPartialImages || "Alt-texts saved for {successCount}/{totalCount} image(s) in {languageCount} language(s). Image(s) {failedImages} could not be saved to Shopify. Please sync the product again.")
                  .replace("{successCount}", String(imageCount - failedImages.length))
                  .replace("{totalCount}", String(imageCount))
                  .replace("{languageCount}", String(translatedCount))
                  .replace("{failedImages}", failedList),
                "warning",
                t.common?.warning || "Warning"
              );
            } else {
              showInfoBox(
                String(t.content?.altTextTranslateAllSuccess || "Alt-texts for {totalCount} image(s) translated to {languageCount} language(s)")
                  .replace("{totalCount}", String(imageCount))
                  .replace("{languageCount}", String(translatedCount)),
                "success",
                t.common?.success || "Success"
              );
            }
            // Update UI state with translated alt texts for current language
            if (result.translatedResults && currentLanguage !== primaryLocale) {
              const translatedForCurrentLocale: Record<number, string> = {};
              const results = result.translatedResults as Record<string, Record<string, string>>;
              for (const [imgIdxStr, localeMap] of Object.entries(results)) {
                const idx = parseInt(imgIdxStr, 10);
                if (!failedImages.includes(idx) && localeMap[currentLanguage]) {
                  translatedForCurrentLocale[idx] = localeMap[currentLanguage];
                }
              }
              if (Object.keys(translatedForCurrentLocale).length > 0) {
                setImageAltTexts(prev => {
                  const updated = { ...prev, ...translatedForCurrentLocale };
                  setOriginalAltTexts(updated);
                  return updated;
                });
              }
            }
            if (revalidatorRef.current.state === 'idle') {
              try { revalidatorRef.current.revalidate(); } catch {}
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



    // Step 2: Save the primary text first
    // After save completes, the useEffect will trigger the translation
    debugLog.acceptAndTranslate(' Saving primary text first, then will translate');
    performSaveWithValues(newValues, primaryLocale);
  };

  const handleRejectSuggestion = useCallback((fieldKey: string) => {
    setAiSuggestions((prev) => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldKey];
      return newSuggestions;
    });
  }, []);

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

  const handleValueChange = useCallback((fieldKey: string, value: string) => {
    // Force isLoadingData to false to ensure change detection works for manual changes
    setIsLoadingData(false);

    // If this field was a fallback, remove it from fallback fields since user is editing
    if (fallbackFieldsRef.current.has(fieldKey)) {
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
  }, [fallbackFieldsRef]);

  const handleToggleHtmlMode = useCallback((fieldKey: string) => {
    setHtmlModes((prev) => ({
      ...prev,
      [fieldKey]: prev[fieldKey] === "html" ? "rendered" : "html",
    }));
  }, []);

  const handleClearField = useCallback((fieldKey: string) => {
    // Force isLoadingData to false to ensure change detection works
    setIsLoadingData(false);

    // If this field was a fallback, remove it from fallback fields
    if (fallbackFieldsRef.current.has(fieldKey)) {
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

    // Update validation refs so isFieldTranslated / hasLocaleMissingTranslations
    // reflect the cleared state immediately (yellow highlight + button blinking)
    if (currentLanguage !== primaryLocale) {
      const field = effectiveFieldDefinitions.find(f => f.key === fieldKey);
      if (field) {
        const tKey = field.translationKey;
        if (localTranslationsRef.current[tKey]) {
          delete localTranslationsRef.current[tKey][currentLanguage];
        }
        // Mark as deleted so resolve() returns empty even if item.translations has old data
        deletedTranslationKeysRef.current.add(tKey);
      }
    }
  }, [fallbackFieldsRef, currentLanguage, primaryLocale, effectiveFieldDefinitions]);

  const handleClearAllClick = useCallback(() => {
    setIsClearAllModalOpen(true);
  }, []);

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

    // Update validation refs so isFieldTranslated / hasLocaleMissingTranslations
    // reflect the cleared state immediately (yellow highlight + button blinking)
    if (currentLanguage !== primaryLocale) {
      effectiveFieldDefinitions.forEach((field) => {
        if (field.key === "title") return; // title was kept
        const tKey = field.translationKey;
        if (localTranslationsRef.current[tKey]) {
          delete localTranslationsRef.current[tKey][currentLanguage];
        }
        // Mark as deleted so resolve() returns empty even if item.translations has old data
        deletedTranslationKeysRef.current.add(tKey);
      });
    }

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

  const handleClearAllCancel = useCallback(() => {
    setIsClearAllModalOpen(false);
  }, []);

  const handleClearAllForLocaleClick = useCallback(() => {
    setIsClearAllModalOpen(true);
  }, []);

  const handleClearAllForLocaleConfirm = () => {
    if (!selectedItemId || !selectedItem || currentLanguage === primaryLocale) return;

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

    // Update validation refs so isFieldTranslated / hasLocaleMissingTranslations
    // reflect the cleared state immediately (yellow highlight + button blinking)
    effectiveFieldDefinitions.forEach((field) => {
      const tKey = field.translationKey;
      if (localTranslationsRef.current[tKey]) {
        delete localTranslationsRef.current[tKey][currentLanguage];
      }
      // Mark as deleted so resolve() returns empty even if item.translations has old data
      deletedTranslationKeysRef.current.add(tKey);
    });

    // Clear image alt texts - set each to "" explicitly so the UI doesn't fall back to original image.altText
    const clearedAltTexts: Record<number, string> = {};
    if (selectedItem?.images && selectedItem.images.length > 0) {
      selectedItem.images.forEach((_: ContentImage, index: number) => {
        clearedAltTexts[index] = "";
      });
      setImageAltTexts(clearedAltTexts);
      setOriginalAltTexts({});
    }
    setAltTextSuggestions({});

    // Close modal
    setIsClearAllModalOpen(false);

    // ── Persist the clear: submit save to server so translations are deleted ──
    // Without this, navigating away and back would reload stale translations from the DB.

    // Build formData with all translated fields set to "" (to trigger server-side deletion)
    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };

    // Send only fields that had a non-empty translated value (those need deletion)
    effectiveFieldDefinitions.forEach((field) => {
      if (fallbackFieldsRef.current.has(field.key)) return; // no translation to delete
      const originalValue = originalLoadedValuesRef.current[field.key] || "";
      if (originalValue) {
        formDataObj[field.key] = "";
      }
    });

    // Send alt-texts that had translations
    const altTextsToDelete: Record<number, string> = {};
    let hasAltTextsToDelete = false;
    if (selectedItem?.images) {
      selectedItem.images.forEach((img: ContentImage, index: number) => {
        const hasTranslation = img.altTextTranslations?.some(
          (t: { locale: string }) => t.locale === currentLanguage
        );
        if (hasTranslation) {
          altTextsToDelete[index] = "";
          hasAltTextsToDelete = true;
        }
      });
    }
    if (hasAltTextsToDelete) {
      formDataObj.imageAltTexts = JSON.stringify(altTextsToDelete);
    }

    // No item.translations mutation needed — deletedTranslationKeysRef (set above)
    // ensures resolve() returns empty even if item.translations has stale data.

    if (selectedItem.images) {
      selectedItem.images.forEach((img: ContentImage) => {
        if (img.altTextTranslations) {
          img.altTextTranslations = img.altTextTranslations.filter(
            (t: { locale: string }) => t.locale !== currentLanguage
          );
        }
      });
    }

    // Update originalLoadedValues so change detection reflects the cleared state
    originalLoadedValuesRef.current = { ...clearedValues };

    // Submit save and set tracking refs

    savedLocaleRef.current = currentLanguage;
    isSavePendingRef.current = true;
    safeSubmit(formDataObj, { method: "POST" });
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
          `allAltTextsTranslate_${currentLanguage}`,
          (result) => {
            const failedImages: number[] = (result.failedImages as number[]) || [];

            // Only accept translations that were successfully saved to Shopify
            if (result.translatedAltTexts) {
              const translated: Record<number, string> = {};
              Object.entries(result.translatedAltTexts as Record<string, string>).forEach(([indexStr, text]) => {
                const idx = parseInt(indexStr, 10);
                if (!failedImages.includes(idx)) {
                  translated[idx] = String(text);
                }
              });

              if (Object.keys(translated).length > 0) {
                setImageAltTexts(prev => {
                  const updated = { ...prev, ...translated };
                  setOriginalAltTexts(updated);
                  return updated;
                });
                // No auto-save needed - server already saved to Shopify and DB
              }
            }

            if (failedImages.length > 0) {
              const failedList = failedImages.map((i: number) => i + 1).join(", ");
              showInfoBox(
                String(t.content?.altTextTranslatePartialImages || "Alt-texts partially saved. Image(s) {failedImages} could not be saved to Shopify. Please sync the product again.")
                  .replace("{failedImages}", failedList),
                "warning",
                t.common?.warning || "Warning"
              );
            }
          }
        );
      }
    }
  };

  // ============================================================================
  // ALT-TEXT HANDLERS
  // ============================================================================

  const handleAltTextChange = useCallback((imageIndex: number, value: string) => {
    setImageAltTexts(prev => ({
      ...prev,
      [imageIndex]: value
    }));
  }, []);

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
            [imageIndex]: result.altText as string,
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
        // Handle success - directly apply the translated alt-text (no suggestion box)
        if (result.translatedAltText) {
          const translatedAltText = result.translatedAltText as string;

          // Use functional update to avoid stale closure
          setImageAltTexts(prev => {
            const newAltTexts = { ...prev, [imageIndex]: translatedAltText };

            // Skip next data load to prevent revalidation from overwriting
        

            // Auto-save immediately
            const itemId = selectedItemRef.current?.id;
            if (itemId) {
              const formDataObj: Record<string, string> = {
                action: "updateContent",
                itemId,
                locale: currentLanguage,
                primaryLocale,
              };
              Object.assign(formDataObj, buildFieldsForSave(editableValuesRef.current, currentLanguage));
              formDataObj.imageAltTexts = JSON.stringify(newAltTexts);

              savedLocaleRef.current = currentLanguage;
              isSavePendingRef.current = true;
              isSaveFromTranslateRef.current = true;
              safeSubmit(formDataObj, { method: "POST" });
            }

            // Update original alt-texts so hasChanges becomes false
            setOriginalAltTexts(newAltTexts);

            return newAltTexts;
          });

          // Show success toast
          showInfoBox(
            t.common?.fieldTranslatedAndSaved
              ?.replace("{fieldType}", "Alt-Text")
              || "Alt-Text translated and saved successfully",
            "success",
            t.common?.success || "Success"
          );
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
        const failedLocales = (result.failedLocales as string[]) || [];
        const translatedAltTexts = result.translatedAltTexts as Record<string, string> | undefined;
        const translatedCount = translatedAltTexts ? Object.keys(translatedAltTexts).length : targetLocales.length;
        const successCount = translatedCount - failedLocales.length;

        if (failedLocales.length > 0) {
          const failedList = failedLocales.join(", ");
          showInfoBox(
            String(t.content?.altTextPartialLocales || "Alt-text for image {imageNumber} partially translated. Language(s) {failedLocales} could not be saved to Shopify. Please sync the product again.")
              .replace("{imageNumber}", String(imageIndex + 1))
              .replace("{failedLocales}", failedList),
            "warning",
            t.common?.warning || "Warning"
          );
        } else {
          showInfoBox(
            String(t.content?.altTextTranslatedToLanguages || "Alt-text translated to {count} language(s)")
              .replace("{count}", String(successCount)),
            "success",
            t.common?.success || "Success"
          );
        }

        // Revalidate to fetch fresh data from the database
        if (revalidatorRef.current.state === 'idle') {
          try {
            revalidatorRef.current.revalidate();
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
        const translatedCount = (result.translatedCount as number) || 0;
        const imageCount = (result.imageCount as number) || 0;
        const failedImages: number[] = (result.failedImages as number[]) || [];

        if (failedImages.length > 0) {
          const failedList = failedImages.map((i: number) => i + 1).join(", ");
          showInfoBox(
            String(t.content?.altTextTranslateAllPartialImages || "Alt-texts saved for {successCount}/{totalCount} image(s) in {languageCount} language(s). Image(s) {failedImages} could not be saved to Shopify. Please sync the product again.")
              .replace("{successCount}", String(imageCount - failedImages.length))
              .replace("{totalCount}", String(imageCount))
              .replace("{languageCount}", String(translatedCount))
              .replace("{failedImages}", failedList),
            "warning",
            t.common?.warning || "Warning"
          );
        } else {
          showInfoBox(
            String(t.content?.altTextTranslateAllSuccess || "Alt-texts for {totalCount} image(s) translated to {languageCount} language(s)")
              .replace("{totalCount}", String(imageCount))
              .replace("{languageCount}", String(translatedCount)),
            "success",
            t.common?.success || "Success"
          );
        }

        // Update UI state with translated alt texts for current language
        if (result.translatedResults && currentLanguage !== primaryLocale) {
          const translatedForCurrentLocale: Record<number, string> = {};
          const results = result.translatedResults as Record<string, Record<string, string>>;
          for (const [imgIdxStr, localeMap] of Object.entries(results)) {
            const idx = parseInt(imgIdxStr, 10);
            if (!failedImages.includes(idx) && localeMap[currentLanguage]) {
              translatedForCurrentLocale[idx] = localeMap[currentLanguage];
            }
          }
          if (Object.keys(translatedForCurrentLocale).length > 0) {
            setImageAltTexts(prev => {
              const updated = { ...prev, ...translatedForCurrentLocale };
              setOriginalAltTexts(updated);
              return updated;
            });
          }
        }
        if (revalidatorRef.current.state === 'idle') {
          try {
            revalidatorRef.current.revalidate();
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
      `allAltTextsTranslate_${currentLanguage}`,
      (result) => {
        const failedImages: number[] = (result.failedImages as number[]) || [];

        // Only accept translations that were successfully saved to Shopify
        if (result.translatedAltTexts) {
          const translated: Record<number, string> = {};
          Object.entries(result.translatedAltTexts as Record<string, string>).forEach(([indexStr, text]) => {
            const idx = parseInt(indexStr, 10);
            if (!failedImages.includes(idx)) {
              translated[idx] = String(text);
            }
          });

          if (Object.keys(translated).length > 0) {
            setImageAltTexts(prev => {
              const updated = { ...prev, ...translated };
              setOriginalAltTexts(updated);
              return updated;
            });
            // No auto-save needed - server already saved to Shopify and DB
          }
        }

        if (failedImages.length > 0) {
          const failedList = failedImages.map((i: number) => i + 1).join(", ");
          showInfoBox(
            String(t.content?.altTextTranslatePartialImages || "Alt-texts partially saved. Image(s) {failedImages} could not be saved to Shopify. Please sync the product again.")
              .replace("{failedImages}", failedList),
            "warning",
            t.common?.warning || "Warning"
          );
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

    // Immediately update the in-memory item so the fallback display
    // (images[index]?.altText) shows the correct value even if imageAltTexts
    // state gets cleared during revalidation cycles.
    const item = selectedItemRef.current;
    if (item?.images?.[imageIndex] && currentLanguage === primaryLocale) {
      item.images[imageIndex].altText = suggestion;
    }

    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });



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

    // Immediately update the in-memory item so the fallback display
    // (images[index]?.altText) shows the correct value even if imageAltTexts
    // state gets cleared during revalidation cycles.
    if (item.images?.[imageIndex]) {
      item.images[imageIndex].altText = suggestion;
    }

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
      Object.assign(formDataObj, buildFieldsForSave(editableValues, primaryLocale));
      formDataObj.imageAltTexts = JSON.stringify(newAltTexts);
      savedLocaleRef.current = primaryLocale;
      isSavePendingRef.current = true;
      safeSubmit(formDataObj, { method: "POST" });
      setOriginalAltTexts(newAltTexts);
      return;
    }



    debugLog.altText('Saving primary alt-text first, then will translate to all locales');

    // Step 1: Save the primary alt-text first
    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: primaryLocale,
      primaryLocale,
    };
    Object.assign(formDataObj, buildFieldsForSave(editableValues, primaryLocale));
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

  const handleRejectAltTextSuggestion = useCallback((imageIndex: number) => {
    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });
  }, []);

  // ============================================================================
  // SEND IMAGE TO AI HANDLERS
  // ============================================================================

  const handleToggleSendImageToAI = useCallback(() => {
    setSendImageToAI(prev => !prev);
  }, []);

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
      // Reset to primary locale alt-texts - fallback will use images[i].altText
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

  const isFieldTranslated = (fieldKey: string): boolean => {
    if (!selectedItem) return false;
    const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
    if (!field) return false;

    // Phase 4: Check deletedTranslationKeysRef FIRST — if a field was cleared,
    // it should appear untranslated even if item.translations still has old data.
    if (deletedTranslationKeysRef.current.has(field.translationKey)) {
      return false;
    }

    // Check localTranslationsRef (from translateFieldToAllLocales / saves)
    // This ensures immediate UI feedback before revalidation completes
    const localValue = localTranslationsRef.current[field.translationKey]?.[currentLanguage];
    if (localValue) {
      return true;
    }

    return selectedItem.translations?.some(
      (t: Translation) => t.key === field.translationKey && t.locale === currentLanguage
    );
  };

  const getFieldBackgroundColor = (fieldKey: string): string => {
    if (currentLanguage === primaryLocale) {
      return "transparent";
    }
    // Reuse isFieldTranslated which checks all overlay refs correctly
    return isFieldTranslated(fieldKey) ? "#f0f9ff" : "transparent";
  };

  const getEditableValue = (fieldKey: string): string => {
    // If the key exists in editableValues, always use it (even if empty).
    // After data loading, editableValues contains the resolved values for all fields.
    // An empty string means either "no translation" or "user cleared the field" — both correct.
    const localValue = editableValues[fieldKey];
    if (localValue !== undefined && localValue !== null) {
      return localValue;
    }

    // For foreign languages, try to get translation from item.translations
    // (only reached before initial data load completes)
    if (currentLanguage !== primaryLocale && selectedItem) {
      const field = effectiveFieldDefinitions.find(f => f.key === fieldKey);

      if (field?.translationKey) {
        const translation = selectedItem.translations?.find(
          (t: Translation) => t.key === field.translationKey && t.locale === currentLanguage
        );

        if (translation?.value) {
          return translation.value;
        }
      }
    }

    // Fallback: For primary locale or if no translation exists, use getFieldValue or original value
    if (currentLanguage === primaryLocale && selectedItem && config.getFieldValue) {
      return config.getFieldValue(selectedItem, fieldKey) || "";
    }

    return "";
  };

  const setEditableValue = (fieldKey: string, value: string) => {
    handleValueChange(fieldKey, value);
  };

  // Helper to update original template values (used after loading translations)
  // Also syncs originalLoadedValuesRef so buildFieldsForSave uses the correct baseline
  const setOriginalTemplateValues = (values: Record<string, string>) => {
    if (config.contentType === 'templates') {
      originalTemplateValuesRef.current = { ...values };
      originalLoadedValuesRef.current = { ...values };
      setTemplateValuesVersion(v => v + 1);
    }
  };

  // Atomically replace ALL editable values and original values for templates after a reload.
  // This avoids race conditions from 25+ individual setEditableValue calls and ensures
  // editableValues and originalLoadedValuesRef are updated in a single React batch.
  const reloadTemplateValues = useCallback((values: Record<string, string>) => {
    if (config.contentType !== 'templates') return;
    debugLog.dataLoad(' reloadTemplateValues - atomic update with', Object.keys(values).length, 'fields');
    setEditableValues(values);
    originalTemplateValuesRef.current = { ...values };
    originalLoadedValuesRef.current = { ...values };
    // Mark initial load as successful so retry mechanism doesn't interfere
    initialLoadSuccessfulRef.current = true;
    retryCountRef.current = 0;
    setTemplateValuesVersion(v => v + 1);
    setIsLoadingData(false);
  }, [config]);

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
      reloadTemplateValues,
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

// getItemFieldValue is now imported from useUiDataLoader.ts
// updateItemInMemory was removed in Phase 4 — items are now read-only.
// Saved values are provided by ref overlays (savedPrimaryValuesRef, localTranslationsRef)
// that resolve() reads with higher priority than item properties / item.translations.
