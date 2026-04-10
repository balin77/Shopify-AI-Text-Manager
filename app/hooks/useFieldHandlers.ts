/**
 * Field Handlers Hook
 *
 * Extracted from useUnifiedContentEditor.ts — all field-related event handlers.
 * Handles: save, discard, AI generate, translate, accept/reject suggestions,
 *          language/item selection, value changes, clear operations.
 */

import { useCallback } from "react";
import { getTranslatedValue } from "../utils/contentEditor.utils";
import { getItemFieldValue } from "./useUiDataLoader";
import { debugLog } from "../utils/debug";
import { markOperationActive } from "./useAIOperationsStore";
import type {
  TranslatableContentItem,
  ContentImage,
  ShopLocale,
  ContentEditorConfig,
  TranslationStrings,
  InfoBoxTone,
  FieldDefinition,
} from "../types/content-editor.types";
import type { TransitionResult } from "./useUiDataLoader";

// ============================================================================
// TYPES
// ============================================================================

export interface FieldHandlerProps {
  // Config
  config: ContentEditorConfig;
  primaryLocale: string;
  effectiveFieldDefinitions: FieldDefinition[];
  shopLocales: ShopLocale[];
  t: TranslationStrings;
  onTranslateToAllLocalesComplete?: (fieldKey: string, translations: Record<string, string>) => void;

  // State values
  selectedItemId: string | null;
  selectedItem: TranslatableContentItem | undefined;
  currentLanguage: string;
  hasChanges: boolean;
  hasAltTextChanges: boolean;
  enabledLanguages: string[];
  editableValues: Record<string, string>;
  aiSuggestions: Record<string, string>;
  imageAltTexts: Record<number, string>;
  originalAltTexts: Record<number, string>;
  sendImageToAI: boolean;
  selectedImageIndex: number;
  fallbackFields: Set<string>;

  // Refs (MutableRefObject-compatible)
  selectedItemIdRef: { current: string | null };
  selectedItemRef: { current: TranslatableContentItem | undefined };
  editableValuesRef: { current: Record<string, string> };
  imageAltTextsRef: { current: Record<number, string> };
  originalAltTextsRef: { current: Record<number, string> };
  fallbackFieldsRef: { current: Set<string> };
  isAcceptAndTranslateFlowRef: { current: boolean };
  deletedTranslationKeysRef: { current: Set<string> };
  localTranslationsRef: { current: Record<string, Record<string, string>> };
  savedPrimaryValuesRef: { current: Record<string, Record<string, string>> };
  originalLoadedValuesRef: { current: Record<string, string> };
  originalTemplateValuesRef: { current: Record<string, string> };
  revalidatorRef: { current: { state: string; revalidate: () => void } };
  savedLocaleRef: { current: string | null };
  isSavePendingRef: { current: boolean };
  isSaveFromTranslateRef: { current: boolean };
  pendingTranslationAfterSaveRef: { current: { fieldKey: string; sourceText: string; targetLocales: string[]; contextTitle: string; itemId: string } | null };
  acceptedPrimaryValueRef: { current: { fieldKey: string; value: string } | null };
  initialLoadSuccessfulRef: { current: boolean };
  retryCountRef: { current: number };

  // Functions
  submitAIAction: (
    data: Record<string, string>,
    fieldKey: string,
    onSuccess?: (result: Record<string, unknown>) => void,
    onError?: (error: string) => void
  ) => Promise<void>;
  performAutoSave: (valuesToSave: Record<string, string>, locale: string) => void;
  safeSubmit: (
    data: Record<string, any>,
    options?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }
  ) => void;
  buildFieldsForSave: (values: Record<string, string>, locale: string) => Record<string, string>;
  getChangedFields: (valuesToCheck: Record<string, string>) => string[];
  getChangedAltTextIndices: () => number[];
  resolveFieldLabel: (fieldKey: string) => string;
  showInfoBox: (message: string, tone: InfoBoxTone, title?: string) => void;
  handleNavigationAttempt: (navigate: () => void, hasChanges: boolean) => void;
  clearPendingNavigation: () => void;
  dataLoader: {
    onTranslateFieldComplete: (
      fieldKey: string,
      translationKey: string,
      translatedValue: string,
      targetLocale: string,
      currentEditableValues: Record<string, string>
    ) => TransitionResult;
    onTranslateFieldToAllLocalesComplete: (
      translationKey: string,
      translations: Record<string, string>,
      currentLocale: string
    ) => void;
  };

  // State setters
  setSelectedItemId: React.Dispatch<React.SetStateAction<string | null>>;
  setCurrentLanguage: React.Dispatch<React.SetStateAction<string>>;
  setEditableValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setAiSuggestions: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setHtmlModes: React.Dispatch<React.SetStateAction<Record<string, "html" | "rendered">>>;
  setEnabledLanguages: React.Dispatch<React.SetStateAction<string[]>>;
  setIsAcceptAndTranslateFlow: React.Dispatch<React.SetStateAction<boolean>>;
  setIsLoadingData: React.Dispatch<React.SetStateAction<boolean>>;
  setIsClearAllModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setImageAltTexts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  setAltTextSuggestions: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  setOriginalAltTexts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  setFallbackFields: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTemplateValuesVersion: React.Dispatch<React.SetStateAction<number>>;
}

export interface FieldHandlers {
  handleSave: () => void;
  handleDiscard: () => void;
  handleGenerateAI: (fieldKey: string) => void;
  handleFormatAI: (fieldKey: string) => void;
  handleTranslateField: (fieldKey: string) => void;
  handleTranslateFieldToAllLocales: (fieldKey: string) => void;
  handleTranslateAll: () => void;
  handleAcceptSuggestion: (fieldKey: string) => void;
  handleAcceptAndTranslate: (fieldKey: string) => void;
  handleRejectSuggestion: (fieldKey: string) => void;
  handleLanguageChange: (locale: string) => void;
  handleToggleLanguage: (locale: string) => void;
  handleItemSelect: (itemId: string) => void;
  handleValueChange: (fieldKey: string, value: string) => void;
  handleToggleHtmlMode: (fieldKey: string) => void;
  handleClearField: (fieldKey: string) => void;
  handleClearAllClick: () => void;
  handleClearAllConfirm: () => void;
  handleClearAllCancel: () => void;
  handleClearAllForLocaleClick: () => void;
  handleClearAllForLocaleConfirm: () => void;
  handleTranslateAllForLocale: () => void;
}

// ============================================================================
// HOOK
// ============================================================================

export function useFieldHandlers(props: FieldHandlerProps): FieldHandlers {
  const {
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
    isSavePendingRef,
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
  } = props;

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

  const requestItemId = selectedItemId;
  const currentValue = editableValues[fieldKey] || "";
  const contextTitle = editableValues.title || "";
  const contextDescription = editableValues.description || editableValues.body || "";
  const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === currentLanguage)?.name || currentLanguage;

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
      // Guard: discard if user has switched to a different item since the request was made
      if (selectedItemIdRef.current !== requestItemId) return;
      setAiSuggestions((prev) => ({
        ...prev,
        [fieldKey]: result.generatedContent as string,
      }));
    }
  );
};

const handleFormatAI = (fieldKey: string) => {
  if (!selectedItemId || !selectedItem) return;

  const requestItemId = selectedItemId;
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
  const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === currentLanguage)?.name || currentLanguage;

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
      // Guard: discard if user has switched to a different item since the request was made
      if (selectedItemIdRef.current !== requestItemId) return;
      setAiSuggestions((prev) => ({
        ...prev,
        [fieldKey]: result.generatedContent as string,
      }));
    }
  );
};

const handleTranslateField = (fieldKey: string) => {
  if (!selectedItemId || !selectedItem) return;

  const requestItemId = selectedItemId;
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
      // Guard: discard UI updates if user switched to a different item during the request.
      // The server-side save already used the correct itemId captured above.
      if (selectedItemIdRef.current !== requestItemId) return;
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

  const requestItemId = selectedItemId;

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
      // Guard: discard UI updates if user switched to a different item during the request.
      // The server-side save already used the correct itemId captured above.
      if (selectedItemIdRef.current !== requestItemId) return;
      // Handle success - translations is Record<locale, translatedText>
      const translations = result.translations as Record<string, string> || {};
      const shopifyKey = field.translationKey;
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

  const requestItemId = selectedItemId;

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

  // Mark in global store so spinner persists across navigation
  markOperationActive(selectedItemId, "__translateAll__", "translateAll");

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
          // Guard: discard UI updates if user switched to a different item during the request.
          if (selectedItemIdRef.current !== requestItemId) return;
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

  const requestItemId = selectedItemId;

  // Mark in global store so spinner persists across navigation
  markOperationActive(selectedItemId, `__translateAllForLocale__${currentLanguage}`, "translateAllForLocale", currentLanguage);

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
          // Guard: discard UI updates if user switched to a different item during the request.
          if (selectedItemIdRef.current !== requestItemId) return;
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

  return {
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
  };
}
