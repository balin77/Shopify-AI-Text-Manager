/**
 * Unified Content Editor Hook
 *
 * Based on the products page implementation with all bug fixes.
 * Provides a complete state management and handler system for content editing.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRevalidator } from "@remix-run/react";
import { useNavigationGuard, getTranslatedValue } from "../utils/contentEditor.utils";
import { useEditorImageManagement } from "./useEditorImageManagement";
import { useEditorChangeDetection } from "./useEditorChangeDetection";
import { useItemFocus } from "./useFocusManagement";
import { useLatestRef } from "./useLatestRef";
import { useUiDataLoader, getItemFieldValue } from "./useUiDataLoader";
import { useEditorAutoSave } from "./useEditorAutoSave";
import { useEditorAltText } from "./useEditorAltText";
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
import { translateErrorMessage } from "../utils/editor-error-messages";
import { useFieldHandlers } from "./useFieldHandlers";
import {
  markOperationActive,
  markOperationCompleted,
  markOperationFailed,
  reconcileWithServer,
  useLoadingFieldKeys as useGlobalLoadingFieldKeys,
  useCompletedResults,
  consumeCompletedResult,
} from "./useAIOperationsStore";

interface TaskData {
  fieldType?: string | null;
  targetLocale?: string | null;
}

export function useUnifiedContentEditor(props: UseContentEditorProps): UseContentEditorReturn {
  const { config, items, shopLocales, primaryLocale, fetcher, showInfoBox, t, onTranslateToAllLocalesComplete, initialItemId } = props;
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

  const [selectedItemId, setSelectedItemId] = useState<string | null>(initialItemId || null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const currentLanguageRef = useLatestRef(currentLanguage);
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
  // Uses the global AI operations store so spinners persist across item navigation.
  const loadingFieldKeys = useGlobalLoadingFieldKeys(selectedItemId || "");

  // ============================================================================
  // RECONCILE SPINNER STATE WITH SERVER
  // When the user navigates to an item, poll the DB for running tasks and
  // seed/reconcile the global AI operations store. This catches tasks that
  // completed while the user was on a different item (clears stale spinners)
  // and tasks started by other mechanisms (seeds missing spinners).
  // ============================================================================

  useEffect(() => {
    if (!selectedItemId) return;

    let cancelled = false;

    const run = async () => {
      try {
        const response = await fetch(
          `/api/running-field-tasks?resourceId=${encodeURIComponent(selectedItemId)}`
        );
        if (!response.ok || cancelled) return;
        const data = await response.json();

        const lang = currentLanguageRef.current;
        const activeTasks: TaskData[] =
          (data.tasks as TaskData[] || []).filter((task) => {
            if (!task.fieldType) return false;
            if (task.targetLocale && task.targetLocale !== lang) return false;
            return true;
          });

        const serverFieldKeys = new Set(
          activeTasks.map((t) =>
            t.fieldType === "all" ? "__translateAll__" : t.fieldType!
          )
        );

        // Seed any server-side tasks that aren't in the global store yet
        for (const task of activeTasks) {
          const fk = task.fieldType === "all" ? "__translateAll__" : task.fieldType!;
          markOperationActive(selectedItemId, fk, "server-task", task.targetLocale || undefined);
        }

        // Clear global store entries that the server says are no longer running
        reconcileWithServer(selectedItemId, serverFieldKeys);

        if (activeTasks.length === 0 || cancelled) return;

        // Poll until all seeded tasks finish
        const pollUntilDone = async (remaining: Set<string>) => {
          if (cancelled || remaining.size === 0) return;
          await new Promise((res) => setTimeout(res, 2000));
          if (cancelled) return;

          try {
            const r2 = await fetch(
              `/api/running-field-tasks?resourceId=${encodeURIComponent(selectedItemId)}`
            );
            if (!r2.ok || cancelled) return;
            const d2 = await r2.json();

            const stillRunning = new Set<string>(
              ((d2.tasks as TaskData[]) || [])
                .filter((t): t is TaskData & { fieldType: string } => !!t.fieldType)
                .map((t) => t.fieldType === "all" ? "__translateAll__" : t.fieldType)
            );

            // Reconcile: clear anything the server says is done
            reconcileWithServer(selectedItemId, stillRunning);

            const nowDone = [...remaining].filter((k) => !stillRunning.has(k));
            if (nowDone.length > 0) {
              // Refresh page data to show completed results
              if (revalidatorRef.current.state === "idle") {
                try { revalidatorRef.current.revalidate(); } catch {}
              }
            }

            const newRemaining = new Set([...remaining].filter((k) => stillRunning.has(k)));
            await pollUntilDone(newRemaining);
          } catch {
            if (!cancelled) {
              await new Promise((res) => setTimeout(res, 5000));
              await pollUntilDone(remaining);
            }
          }
        };

        await pollUntilDone(serverFieldKeys);
      } catch {
        // Silently ignore — spinner simply won't be restored on this navigation
      }
    };

    run();
    return () => { cancelled = true; };
  }, [selectedItemId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ============================================================================
  // PROCESS PARKED AI RESPONSES
  // When the user navigates back to an item that had AI operations complete
  // while they were away, consume the parked results and apply them.
  // ============================================================================

  const completedResults = useCompletedResults(selectedItemId || "");

  useEffect(() => {
    if (!selectedItemId || completedResults.length === 0) return;

    for (const completed of completedResults) {
      const result = consumeCompletedResult(completed.resourceId, completed.fieldKey);
      if (!result) continue;

      const data = result.result;

      // Apply based on action type
      if (completed.action === "generateAIText" || completed.action === "formatAIText") {
        // Park AI suggestion for user to accept/reject
        const generatedContent = data.generatedContent as string;
        const fieldType = data.fieldType as string;
        if (generatedContent && fieldType) {
          setAiSuggestions((prev) => ({
            ...prev,
            [fieldType]: generatedContent,
          }));
        }
      }
      // For translate actions, the server saved the translation to DB.
      // Trigger revalidation to pick up fresh data.
      if (
        completed.action === "translateField" ||
        completed.action === "translateFieldToAllLocales" ||
        completed.action === "translateAll" ||
        completed.action === "translateAllForLocale"
      ) {
        if (revalidatorRef.current.state === "idle") {
          try { revalidatorRef.current.revalidate(); } catch {}
        }
      }
    }
  }, [selectedItemId, completedResults]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track if initial data load was successful - disables retry mechanism after successful load
  // Reset when item or language changes, allowing retry during new load cycles
  const initialLoadSuccessfulRef = useRef(false);

  // NOTE: savedPrimaryValuesRef now lives in useUiDataLoader (destructured above)

  // Trigger for forcing data refresh (used by ReloadButton after revalidation)
  // When this counter increments, the data loading effect will re-run
  const [dataRefreshTrigger, setDataRefreshTrigger] = useState(0);

  // ============================================================================
  // SYNC initialItemId → selectedItemId (e.g. from ?select= URL param)
  // useState only uses initialItemId on mount; this effect handles late resolution
  // (e.g. when items load async after mount and initialItemId wasn't in the list yet).
  // We track which initialItemId value has already been applied so that subsequent
  // changes to `items` (lazy loading, augmentation) never override a manual
  // user selection after the initial auto-select was applied.
  // ============================================================================

  const appliedInitialItemIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!initialItemId) return;
    // Already applied this exact initialItemId once — don't override user navigation
    if (appliedInitialItemIdRef.current === initialItemId) return;
    if (items.find(i => i.id === initialItemId)) {
      setSelectedItemId(initialItemId);
      appliedInitialItemIdRef.current = initialItemId;
    }
  }, [initialItemId, items]);

  // ============================================================================
  // AUTO-SELECT FIRST ITEM ON MOUNT
  // Automatically select the first item when the page loads
  // ============================================================================

  useEffect(() => {
    if (items.length === 0) return;
    // If no item selected, or selected item doesn't exist in list, select first item
    if (!selectedItemId || !items.find(i => i.id === selectedItemId)) {
      setSelectedItemId(items[0].id);
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

  // IMPORTANT: Memoize baseSelectedItem to prevent infinite re-renders.
  // Without this, items.find() returns a new object reference on every revalidation,
  // which triggers useChangeTracking and other effects, causing an infinite loop.
  const baseSelectedItem = useMemo(() => {
    return items.find((item) => item.id === selectedItemId);
  }, [items, selectedItemId]);

  // Image management: on-demand loading + image cloning for alt-text mutations
  const {
    selectedItem,
    onDemandImages,
    isLoadingImages,
    prevSelectedItemIdRef,
  } = useEditorImageManagement({ config, selectedItemId, baseSelectedItem });

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
  const selectedItemIdRef = useLatestRef(selectedItemId);

  // ============================================================================
  // EARLY REFS (needed by sub-hooks before AUTO-SAVE section)
  // ============================================================================

  // Use a ref for fetcher to avoid dependency changes causing infinite loops
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Guard against synchronous double-submit
  const justSubmittedRef = useRef(false);

  // Ref to track the locale that was active when the save was initiated
  const savedLocaleRef = useRef<string | null>(null);

  // Ref to track the ITEM ID that was active when the save was initiated.
  // Allows response handlers to detect if the user navigated away before
  // the save response arrived and avoid applying stale state to the wrong item.
  const savedItemIdRef = useRef<string | null>(null);

  // FIFO queue for saves when the fetcher is already in-flight.
  const saveQueueRef = useRef<Array<{
    formData: FormData;
    options: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" };
    savedLocale: string | null;
    savedItemId: string | null;
  }>>([]);

  const editableValuesRef = useLatestRef(editableValues);

  // Ref to track whether a save operation is actually pending
  const isSavePendingRef = useRef(false);
  // Ref to suppress the generic "Changes saved" toast when triggered by translate action
  const isSaveFromTranslateRef = useRef(false);

  // Forwarding-Refs for functions defined later (Ref-Forwarding-Pattern for circular dep)
  const buildFieldsForSaveRef = useRef<(v: Record<string, string>, l: string) => Record<string, string>>(() => ({}));
  const safeSubmitRef = useRef<(data: Record<string, any>, opts?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }) => void>(() => {});
  const submitAIActionRef = useRef<(data: Record<string, string>, fieldKey: string, onSuccess?: (r: Record<string, unknown>) => void, onError?: (e: string) => void) => void>(async () => {});

  // ============================================================================
  // SUB-HOOK: useEditorAltText
  // ============================================================================

  const {
    imageAltTexts, setImageAltTexts,
    altTextSuggestions, setAltTextSuggestions,
    originalAltTexts, setOriginalAltTexts,
    imageAltTextsRef, originalAltTextsRef,
    pendingAltTextAutoSaveRef,
    sendImageToAI, setSendImageToAI,
    selectedImageIndex, setSelectedImageIndex,
    handleAltTextChange, handleGenerateAltText, handleGenerateAllAltTexts,
    handleAcceptAltText, handleRejectAltText,
    handleTranslateAltText, handleTranslateAltTextToAllLocales,
    handleTranslateAllAltTexts, handleTranslateAllAltTextsForLocale,
    handleAcceptAltTextSuggestion, handleAcceptAndTranslateAltText,
    handleRejectAltTextSuggestion, handleToggleSendImageToAI,
  } = useEditorAltText({
    selectedItem,
    selectedItemId,
    selectedItemRef,
    selectedItemIdRef,
    currentLanguage,
    primaryLocale,
    shopLocales,
    config,
    enabledLanguages,
    editableValues,
    editableValuesRef,
    buildFieldsForSave: (v, l) => buildFieldsForSaveRef.current(v, l),
    safeSubmit: (data, opts) => safeSubmitRef.current(data, opts),
    savedLocaleRef,
    isSavePendingRef,
    isSaveFromTranslateRef,
    revalidatorRef,
    submitAIAction: (data, fieldKey, onSuccess, onError) => submitAIActionRef.current(data, fieldKey, onSuccess, onError),
    showInfoBox,
    t,
    setAiSuggestions,
  });

  // Change detection — unified across standard, template, and metaobject content types
  const { hasChanges, hasFieldChanges, hasAltTextChanges } = useEditorChangeDetection({
    config,
    isLoadingData,
    selectedItem,
    currentLanguage,
    primaryLocale,
    editableValues,
    fallbackFields,
    imageAltTexts,
    originalAltTexts,
    originalLoadedValuesRef,
    originalTemplateValuesRef,
    templateValuesVersion,
  });

  // ============================================================================
  // SUB-HOOK: useEditorAutoSave
  // ============================================================================

  const {
    performAutoSave,
    getChangedFields,
    getChangedAltTextIndices,
    buildFieldsForSave,
    safeSubmit,
  } = useEditorAutoSave({
    selectedItemId,
    selectedItemIdRef,
    currentLanguage,
    primaryLocale,
    config,
    fetcher,
    editableValuesRef,
    imageAltTextsRef,
    originalAltTextsRef,
    effectiveFieldDefinitions,
    selectedItem,
    shopLocales,
    savedLocaleRef,
    savedItemIdRef,
    isSavePendingRef,
    isSaveFromTranslateRef,
    fallbackFieldsRef,
    originalLoadedValuesRef,
    originalTemplateValuesRef,
    deletedTranslationKeysRef,
    isAcceptAndTranslateFlowRef,
    savedPrimaryValuesRef,
    saveQueueRef,
    justSubmittedRef,
    fetcherRef,
  });

  // Stable signal that changes when translations arrive for the selected item.
  // When the loader delivers fresh data after lazy-load / revalidation, the
  // translation count jumps from 0 → N.  The data-loading effect depends on
  // this so it re-resolves field values automatically.
  const selectedItemTranslationSignal = useMemo(() => {
    if (!selectedItemId) return 0;
    const item = items.find(i => i.id === selectedItemId);
    const translations = item?.translations ?? [];
    // Content-aware fingerprint instead of plain count: detects re-translations
    // (same count, different values) after background task polling + revalidation.
    // Multiplier ensures count changes always dominate value-length sum changes.
    return translations.reduce(
      (acc, t) => acc + (t.value?.length ?? 0),
      translations.length * 1_000_000
    );
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
        // Don't clear loading state while a revalidation is in progress —
        // the revalidation will bring fresh item.translations and trigger
        // this effect again once complete.
        if (revalidatorRef.current.state !== 'idle') return;
        setIsLoadingData(false);
        setIsInitialDataReady(true);
      }, 10);
      return () => clearTimeout(timer);
    }
    // Use selectedItemId instead of selectedItem to prevent re-runs on reference changes
  }, [editableValues, selectedItemId, isLoadingData, revalidator.state]);

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

  // Submit AI action using fetch API directly to allow parallel requests
  // This enables multiple AI actions to run simultaneously on different fields.
  // Loading state is tracked in the global AI operations store so spinners
  // persist when the user navigates between items.
  const submitAIAction = useCallback(async (
    data: Record<string, string>,
    fieldKey: string,
    onSuccess?: (result: Record<string, unknown>) => void,
    onError?: (error: string) => void
  ) => {
    const itemId = selectedItemIdRef.current;
    if (!itemId) return;

    const action = data.action || "unknown";

    // Mark in global store (spinner visible immediately, survives navigation)
    markOperationActive(itemId, fieldKey, action, data.targetLocale);

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
        await response.text(); // consume body to avoid leaking the connection
        throw new Error(`Server returned ${response.status}: Expected JSON but got ${contentType || 'unknown content type'}`);
      }

      const result = await response.json();
      if (result.success) {
        refreshTaskCount();

        // If user is still on the same item, deliver the result immediately
        if (selectedItemIdRef.current === itemId) {
          markOperationFailed(itemId, fieldKey); // clear from active (not really failed, just done)
          onSuccess?.(result);
        } else {
          // User navigated away — park the result for later consumption
          markOperationCompleted(itemId, fieldKey, action, result);
        }
      } else {
        const errorMsg = result.error || "Unknown error";
        markOperationFailed(itemId, fieldKey);
        // Only show error if user is still on the same item
        if (selectedItemIdRef.current === itemId) {
          onError?.(errorMsg);
          const translatedError = translateErrorMessage(errorMsg, t);
          showInfoBox(translatedError, "critical", t.common?.error || "Error");
        }
      }
    } catch (error) {
      markOperationFailed(itemId, fieldKey);
      if (selectedItemIdRef.current === itemId) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        onError?.(errorMessage);
        const translatedError = translateErrorMessage(errorMessage, t);
        showInfoBox(translatedError, "critical", t.common?.error || "Error");
      }
    }
  }, [showInfoBox, t]);

  // Fill forwarding refs now that real functions are available
  buildFieldsForSaveRef.current = buildFieldsForSave;
  safeSubmitRef.current = safeSubmit;
  submitAIActionRef.current = submitAIAction;

  // ============================================================================
  // FETCHER RESPONSE HANDLERS (based on products implementation)
  // ============================================================================

  // Handle AI generation response
  useEffect(() => {
    if (fetcher.data?.success && (fetcher.data.actionType === "generateAIText" || fetcher.data.actionType === "formatAIText")) {
      const { fieldType, generatedContent } = fetcher.data as GeneratedContentResponse;
      if (generatedContent && generatedContent.trim()) {
        setAiSuggestions((prev) => ({
          ...prev,
          [fieldType]: generatedContent,
        }));
      }
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

  // NOTE: skipNextDataLoadRef was removed in Phase 4 (read-only items).
  // resolve() now computes correct values purely from ref overlays, so
  // the data-load effect always produces the right result without skipping.

  // Ref to track processed translateField responses (prevents duplicate processing/infinite loops)
  const processedTranslateFieldRef = useRef<string | null>(null);

  // Ref to track processed save responses (prevents duplicate InfoBox/revalidation on re-renders)
  const processedSaveResponseRef = useRef<FetcherData | null>(null);

  // Ref to track processed translateAltTextToAllLocales responses (prevents infinite revalidation loop)
  const processedTranslateAltTextAllRef = useRef<FetcherData | null>(null);
  const processedTranslateAllRef = useRef<FetcherData | null>(null);
  const processedTranslateAllForLocaleRef = useRef<FetcherData | null>(null);

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

      // Clear the global store spinner for translateAll
      if (selectedItemIdRef.current) {
        markOperationFailed(selectedItemIdRef.current, "__translateAll__");
      }

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

      // Clear the global store spinner for translateAllForLocale
      if (selectedItemIdRef.current) {
        markOperationFailed(selectedItemIdRef.current, `__translateAllForLocale__${targetLocale}`);
      }
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

      // Guard: if the user navigated to a different item while this save was
      // in-flight, clear refs but do NOT apply state changes to the wrong item.
      const isSavedItemCurrent = savedItemIdRef.current === selectedItemIdRef.current;
      if (!isSavedItemCurrent) {
        debugLog.response(' Item changed during save — clearing refs, skipping in-memory update');
        savedLocaleRef.current = null;
        savedItemIdRef.current = null;
        return;
      }

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

      // Guard: check if the item that was saved is still the currently-selected item.
      const isSavedItemCurrent = savedItemIdRef.current === selectedItemIdRef.current;
      savedItemIdRef.current = null; // Always clean up — we've processed this response

      if (!isSavedItemCurrent) {
        debugLog.response(' Item changed during save — skipping response application for wrong item');
        return;
      }

      // Only unblock deferred navigation now that the correct item's save succeeded
      clearPendingNavigation();

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
            // Guard: discard stale callback if user navigated to a different item
            if (selectedItemRef.current?.id !== itemId) return;

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
            // Trigger revalidation so Remix fetches fresh item.translations from Shopify.
            // The 10ms loading-cleanup timer will wait for this revalidation to finish
            // before clearing isLoadingData, ensuring buttons only stop pulsing once
            // the server has confirmed the saved translations.
            try { revalidatorRef.current.revalidate(); } catch {}
          }
        );

        // Don't revalidate here — translation is still in flight; the callback above
        // triggers revalidation once the translations are confirmed saved on Shopify.
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

      // For metaobjects: Update originalLoadedValuesRef so hasChanges becomes false
      if (config.contentType === 'metaobjects') {
        originalLoadedValuesRef.current = { ...editableValues };
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

      const isSavedItemCurrent = savedItemIdRef.current === selectedItemIdRef.current;
      savedItemIdRef.current = null;

      if (isSavedItemCurrent) {
        clearPendingNavigation();
        const translatedError = translateErrorMessage(String(fetcher.data.error || ""), t);
        showInfoBox(translatedError, "critical", t.common?.error || "Error");
      }
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

      const isSavedItemCurrent = savedItemIdRef.current === selectedItemIdRef.current;
      savedItemIdRef.current = null;

      if (isSavedItemCurrent) {
        clearPendingNavigation();

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
        if (config.contentType === 'metaobjects' && originalLoadedValuesRef.current) {
          setEditableValues(prev => {
            const restored = { ...prev };
            for (const [key, value] of Object.entries(restored)) {
              if (value.trim() === "" && originalLoadedValuesRef.current[key]) {
                restored[key] = originalLoadedValuesRef.current[key];
              }
            }
            return restored;
          });
        }
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
      debugLog.submit(' Processing queued save, locale:', next.savedLocale, ', item:', next.savedItemId, ', remaining in queue:', saveQueueRef.current.length);

      // Restore metadata for this queued save
      savedLocaleRef.current = next.savedLocale;
      savedItemIdRef.current = next.savedItemId;
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
  // DERIVED STATE: isSavingCurrentItem
  // Must be computed BEFORE useFieldHandlers which uses it for navigation guards.
  // True only when the fetcher is busy AND the in-flight save is for the
  // currently-selected item (not a previously-selected one the user navigated from).
  // ============================================================================

  const isSavingCurrentItem = fetcher.state !== "idle" &&
    (fetcher.formData?.get("itemId") === selectedItemId ||
     (isSavePendingRef.current && savedItemIdRef.current === selectedItemId));

  // ============================================================================
  // FIELD EVENT HANDLERS (extracted to useFieldHandlers)
  // ============================================================================

  const {
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
  } = useFieldHandlers({
    config,
    primaryLocale,
    effectiveFieldDefinitions,
    shopLocales,
    t,
    onTranslateToAllLocalesComplete,
    selectedItemId,
    selectedItem,
    currentLanguage,
    hasChanges,
    hasAltTextChanges,
    enabledLanguages,
    editableValues,
    aiSuggestions,
    imageAltTexts,
    originalAltTexts,
    sendImageToAI,
    selectedImageIndex,
    fallbackFields,
    selectedItemIdRef,
    selectedItemRef,
    editableValuesRef,
    imageAltTextsRef,
    originalAltTextsRef,
    fallbackFieldsRef,
    isAcceptAndTranslateFlowRef,
    deletedTranslationKeysRef,
    localTranslationsRef,
    savedPrimaryValuesRef,
    originalLoadedValuesRef,
    originalTemplateValuesRef,
    revalidatorRef,
    savedLocaleRef,
    savedItemIdRef,
    isSavePendingRef,
    isSavingCurrentItem,
    isSaveFromTranslateRef,
    pendingTranslationAfterSaveRef,
    acceptedPrimaryValueRef,
    initialLoadSuccessfulRef,
    retryCountRef,
    submitAIAction,
    performAutoSave,
    safeSubmit,
    buildFieldsForSave,
    getChangedFields,
    getChangedAltTextIndices,
    resolveFieldLabel,
    showInfoBox,
    handleNavigationAttempt,
    clearPendingNavigation,
    dataLoader,
    setSelectedItemId,
    setCurrentLanguage,
    setEditableValues,
    setAiSuggestions,
    setHtmlModes,
    setEnabledLanguages,
    setIsAcceptAndTranslateFlow,
    setIsLoadingData,
    setIsClearAllModalOpen,
    setImageAltTexts,
    setAltTextSuggestions,
    setOriginalAltTexts,
    setFallbackFields,
    setTemplateValuesVersion,
  });

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
    isSavingCurrentItem,
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
