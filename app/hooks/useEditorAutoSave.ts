/**
 * useEditorAutoSave
 *
 * Encapsulates the auto-save function and its helper utilities extracted from
 * useUnifiedContentEditor. Responsible for building save payloads, computing
 * changed fields / alt-text indices, and submitting them via safeSubmit.
 */

import { useCallback, useRef } from "react";
import { getItemFieldValue } from "./useUiDataLoader";
import { debugLog } from "../utils/debug";
import type {
  ShopLocale,
  ContentEditorConfig,
} from "../types/content-editor.types";

// ---------------------------------------------------------------------------
// Prop / return types
// ---------------------------------------------------------------------------

interface UseEditorAutoSaveProps {
  selectedItemId: string | null;
  selectedItemIdRef: React.MutableRefObject<string | null>;
  currentLanguage: string;
  primaryLocale: string;
  config: ContentEditorConfig;
  fetcher: any;
  editableValuesRef: React.MutableRefObject<Record<string, string>>;
  imageAltTextsRef: React.MutableRefObject<Record<number, string>>;
  originalAltTextsRef: React.MutableRefObject<Record<number, string>>;
  effectiveFieldDefinitions: any[];
  selectedItem: any;
  shopLocales: ShopLocale[];
  savedLocaleRef: React.MutableRefObject<string | null>;
  savedItemIdRef: React.MutableRefObject<string | null>;
  isSavePendingRef: React.MutableRefObject<boolean>;
  isSaveFromTranslateRef: React.MutableRefObject<boolean>;
  // These refs are owned by useUiDataLoader / the main hook; passed in for reading
  fallbackFieldsRef: React.MutableRefObject<Set<string>>;
  originalLoadedValuesRef: React.MutableRefObject<Record<string, string>>;
  originalTemplateValuesRef: React.MutableRefObject<Record<string, string>>;
  deletedTranslationKeysRef: React.MutableRefObject<Set<string>>;
  isAcceptAndTranslateFlowRef: React.MutableRefObject<boolean>;
  savedPrimaryValuesRef: React.MutableRefObject<Record<string, Record<string, string>>>;
  // Save queue / guard refs owned by the main hook
  saveQueueRef: React.MutableRefObject<Array<{
    formData: FormData;
    options: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" };
    savedLocale: string | null;
    savedItemId: string | null;
  }>>;
  justSubmittedRef: React.MutableRefObject<boolean>;
  fetcherRef: React.MutableRefObject<any>;
}

interface UseEditorAutoSaveReturn {
  performAutoSave: (values: Record<string, string>, locale: string) => void;
  getChangedFields: (values: Record<string, string>) => string[];
  getChangedAltTextIndices: () => number[];
  buildFieldsForSave: (values: Record<string, string>, locale: string) => Record<string, string>;
  safeSubmit: (data: Record<string, any>, options?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }) => void;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useEditorAutoSave(props: UseEditorAutoSaveProps): UseEditorAutoSaveReturn {
  const {
    selectedItemId,
    currentLanguage,
    primaryLocale,
    config,
    editableValuesRef,
    imageAltTextsRef,
    originalAltTextsRef,
    effectiveFieldDefinitions,
    selectedItem,
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
  } = props;

  // We need a stable ref for selectedItem so closures don't capture stale values
  const selectedItemRef = useRef(selectedItem);
  selectedItemRef.current = selectedItem;

  // ---------------------------------------------------------------------------
  // safeSubmit — lifted here so it can be used by performAutoSave and returned
  // for use in other parts of the main hook.
  // ---------------------------------------------------------------------------
  const safeSubmit = useCallback((
    data: Record<string, any>,
    options?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }
  ) => {
    debugLog.submit(' Submitting data:', data);
    debugLog.submit(' Options:', options);

    const formData = new FormData();
    Object.entries(data).forEach(([key, value]) => {
      formData.append(key, String(value));
    });

    if (fetcherRef.current.state !== 'idle' || justSubmittedRef.current) {
      debugLog.submit(' Fetcher busy (state:', fetcherRef.current.state, ', justSubmitted:', justSubmittedRef.current, '), queuing save for locale:', savedLocaleRef.current);
      saveQueueRef.current.push({
        formData,
        options: options || { method: "POST" },
        savedLocale: savedLocaleRef.current,
        savedItemId: savedItemIdRef.current,
      });
      return;
    }

    try {
      justSubmittedRef.current = true;
      fetcherRef.current.submit(formData, options || { method: "POST" });
    } catch (error) {
      console.error('❌ [safeSubmit] Error caught:', error);
      justSubmittedRef.current = false;
      if (error instanceof Error && error.name === 'AbortError') {
        debugLog.submit(' AbortError caught (data likely saved):', error.message);
      } else {
        console.error('🔴 [safeSubmit] Non-AbortError - re-throwing:', error);
        throw error;
      }
    }
  }, []); // Empty deps - stable reference using refs

  // ---------------------------------------------------------------------------
  // getChangedFields
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // buildFieldsForSave
  // ---------------------------------------------------------------------------
  const buildFieldsForSave = useCallback((
    values: Record<string, string>,
    locale: string
  ): Record<string, string> => {
    const result: Record<string, string> = {};
    effectiveFieldDefinitions.forEach((field) => {
      if (locale !== primaryLocale && fallbackFieldsRef.current.has(field.key)) {
        return;
      }
      const value = values[field.key] || "";
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

  // ---------------------------------------------------------------------------
  // getChangedAltTextIndices
  // ---------------------------------------------------------------------------
  const getChangedAltTextIndices = useCallback((): number[] => {
    const item = selectedItemRef.current;
    if (!item || !item.images) return [];

    const changedIndices: number[] = [];
    for (const [indexStr, currentValue] of Object.entries(imageAltTextsRef.current)) {
      const index = parseInt(indexStr, 10);
      const originalValue = item.images[index]?.altText || "";
      if (currentValue !== originalValue) {
        changedIndices.push(index);
      }
    }

    return changedIndices;
  }, []);

  // ---------------------------------------------------------------------------
  // performAutoSave
  // ---------------------------------------------------------------------------
  const performAutoSave = useCallback((valuesToSave: Record<string, string>, locale: string) => {
    if (!selectedItemId) return;

    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: locale,
      primaryLocale,
    };

    // Pass policyType for ShopPolicy primary locale updates (required by Shopify API)
    if (config.resourceType === "ShopPolicy" && selectedItemRef.current?.type) {
      formDataObj.policyType = selectedItemRef.current.type;
    }

    // Add field values - for foreign locales, only send fields that actually changed
    Object.assign(formDataObj, buildFieldsForSave(valuesToSave, locale));

    // Add image alt-texts ONLY if they actually changed
    if (Object.keys(imageAltTextsRef.current).length > 0) {
      const origAltTexts = originalAltTextsRef.current;
      const changedAltTexts: Record<number, string> = {};
      for (const [key, value] of Object.entries(imageAltTextsRef.current)) {
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
    // BUT: Skip this if we're in an accept-and-translate flow
    const item = selectedItemRef.current;
    if (locale === primaryLocale && item && !isAcceptAndTranslateFlowRef.current) {
      const changedFields = getChangedFields(valuesToSave);
      if (changedFields.length > 0) {
        formDataObj.changedFields = JSON.stringify(changedFields);

        changedFields.forEach((fieldKey) => {
          const field = effectiveFieldDefinitions.find(f => f.key === fieldKey);
          if (field?.translationKey) {
            deletedTranslationKeysRef.current.add(field.translationKey);
          }
        });
      }

      const changedAltTextIndices = getChangedAltTextIndices();
      if (changedAltTextIndices.length > 0) {
        formDataObj.changedAltTextIndices = JSON.stringify(changedAltTextIndices);
        debugLog.autoSave(' Changed alt-text indices (translations will be deleted):', changedAltTextIndices);
      }
    }

    // Cache saved primary values so they survive revalidation
    if (locale === primaryLocale) {
      savedPrimaryValuesRef.current[selectedItemId] = { ...valuesToSave };
    }

    debugLog.autoSave(' Saving with values:', valuesToSave, 'locale:', locale);
    savedLocaleRef.current = locale;
    savedItemIdRef.current = selectedItemId;
    isSavePendingRef.current = true;
    safeSubmit(formDataObj, { method: "POST" });
    // NOTE: clearPendingNavigation is NOT called here — it is deferred to the
    // response handler in useUnifiedContentEditor, which checks that the saved
    // item is still the currently-selected item before unblocking navigation.
  }, [selectedItemId, primaryLocale, effectiveFieldDefinitions, getChangedFields, getChangedAltTextIndices, safeSubmit]);

  return {
    performAutoSave,
    getChangedFields,
    getChangedAltTextIndices,
    buildFieldsForSave,
    safeSubmit,
  };
}
