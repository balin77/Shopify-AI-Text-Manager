/**
 * Field Handlers Hook
 *
 * Extracted from useUnifiedContentEditor.ts — all field-related event handlers.
 * Handles: save, discard, AI generate, translate, accept/reject suggestions,
 *          language/item selection, value changes, clear operations.
 */

import { isThemeContentType, isResourceBackedThemeContent } from "~/utils/content-type-groups";
import { isAttributeField } from "../services/content-attributes.shared";
import { useCallback, useState } from "react";
import { getTranslatedValue } from "../utils/contentEditor.utils";
import { getItemFieldValue, buildLocaleKey, buildDeletedKey } from "./useUiDataLoader";
import { debugLog } from "../utils/debug";
import { writeLastSelectedId } from "../utils/last-selected-item";
import { markOperationActive, markOperationFailed, isOperationActive } from "./useAIOperationsStore";
import { confirmNavigation } from "./useSaveBar";
import type {
  TranslatableContentItem,
  ContentImage,
  ShopLocale,
  ContentEditorConfig,
  TranslationStrings,
  InfoBoxTone,
  FieldDefinition,
  MarketInfo,
} from "../types/content-editor.types";
import type { TransitionResult } from "./useUiDataLoader";
import { aiImageCandidates } from "../services/ai/vision-policy.shared";

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
  /** Selected market ("" = global). Threaded into save/clear so market-specific
   *  edits persist under the right market dimension. */
  selectedMarketId: string;
  hasChanges: boolean;
  hasAltTextChanges: boolean;
  enabledLanguages: string[];
  editableValues: Record<string, string>;
  aiSuggestions: Record<string, string>;
  imageAltTexts: Record<number, string>;
  originalAltTexts: Record<number, string>;
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
  baselineValuesRef: { current: Record<string, string> };
  revalidatorRef: { current: { state: string; revalidate: () => void } };
  savedLocaleRef: { current: string | null };
  savedMarketIdRef: { current: string };
  savedItemIdRef: { current: string | null };
  isSavePendingRef: { current: boolean };
  isSavingCurrentItem: boolean;
  isSaveFromTranslateRef: { current: boolean };
  /** Tracks the fieldKey of a copy save so the response handler can clear the loading state. */
  pendingCopyFieldKeyRef: { current: string | null };
  pendingTranslationAfterSaveRef: { current: { fieldKey: string; sourceText: string; targetLocales: string[]; contextTitle: string; itemId: string } | null };
  acceptedPrimaryValueRef: { current: { fieldKey: string; value: string } | null };
  initialLoadSuccessfulRef: { current: boolean };
  retryCountRef: { current: number };

  // Functions
  submitAIAction: (
    data: Record<string, string>,
    fieldKey: string,
    onSuccess?: (result: Record<string, unknown>) => void,
    onError?: (error: string) => void,
    options?: { suppressErrorBox?: boolean }
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
  dataLoader: {
    onTranslateFieldComplete: (
      fieldKey: string,
      translationKey: string,
      translatedValue: string,
      targetLocale: string,
      currentEditableValues: Record<string, string>,
      marketIdArg?: string
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
  setSelectedMarketId: React.Dispatch<React.SetStateAction<string>>;
  /** All markets (for the language-change reset guard). */
  markets: MarketInfo[];
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
  setBaselineVersion: React.Dispatch<React.SetStateAction<number>>;
  setFieldErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setIsSaving: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface FieldHandlers {
  handleSave: () => void;
  handleDiscard: () => void;
  handleGenerateAI: (fieldKey: string, userInstruction?: string) => void;
  handleFormatAI: (fieldKey: string) => void;
  /** Work the active language's tracked keywords into every field missing them. */
  handleInsertKeywords: () => void;
  /** True while that multi-field run is in flight. */
  isInsertingKeywords: boolean;
  handleTranslateField: (fieldKey: string) => void;
  handleTranslateFieldToAllLocales: (fieldKey: string, options?: { auto?: boolean }) => void;
  handleCopyField: (fieldKey: string) => void;
  handleCopyFieldToAllLocales: (fieldKey: string) => void;
  handleTranslateAll: () => void;
  handleAcceptSuggestion: (fieldKey: string) => void;
  handleAcceptAndTranslate: (fieldKey: string) => void;
  handleRejectSuggestion: (fieldKey: string) => void;
  handleLanguageChange: (locale: string) => void;
  handleMarketChange: (marketId: string) => void;
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
  // Local to this hook: the keyword-insertion run spans several fields, so
  // no single field's own AI-loading flag describes it.
  const [isInsertingKeywords, setIsInsertingKeywords] = useState(false);
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
    selectedMarketId,
    hasChanges,
    hasAltTextChanges,
    enabledLanguages,
    editableValues,
    aiSuggestions,
    imageAltTexts,
    originalAltTexts,
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
    baselineValuesRef,
    revalidatorRef,
    savedLocaleRef,
    savedMarketIdRef,
    savedItemIdRef,
    isSavePendingRef,
    isSavingCurrentItem,
    isSaveFromTranslateRef,
    pendingCopyFieldKeyRef,
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
    dataLoader,
    setSelectedItemId,
    setCurrentLanguage,
    setSelectedMarketId,
    markets,
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
    setBaselineVersion,
    setFieldErrors,
    setIsSaving,
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

  // If we're saving in the primary locale, mark the changed fields' translations
  // as deleted so the UI reflects the server-side purge immediately. Drive this
  // off the already-computed `changedFields` (the exact same list the server uses
  // to delete) instead of re-deriving from the live item — otherwise a
  // normalization-only diff on `body` would wrongly hide its translations here
  // even after the getChangedFields fix keeps the server from deleting them.
  if (currentLanguage === primaryLocale && selectedItem) {
    changedFields.forEach((fieldKey) => {
      const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
      if (field?.translationKey) {
        deletedTranslationKeysRef.current.add(field.translationKey);
        debugLog.translationClear(`Marked translations for field "${fieldKey}" (key: ${field.translationKey}) as deleted`);
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

  // Market scope for market-specific translations (foreign locales only; the
  // primary locale is always global).
  if (currentLanguage !== primaryLocale && selectedMarketId) {
    formDataObj.marketId = selectedMarketId;
  }

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

    // PLAN §Phase 3 — a SEPARATE list, because it answers a different question.
    // `changedFields` says which translations went stale; this says which
    // merchandising attributes the merchant actually touched. A primary save
    // carries every field, so without it the server cannot tell an edit from a
    // passenger — and would rewrite vendor/tags/visibility on every save.
    // They are separate rather than one list because the accept-and-translate
    // flow deliberately withholds `changedFields` (see useEditorAutoSave).
    const changedAttributes = changedFields.filter((fieldKey) => {
      const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
      return !!field && isAttributeField(field);
    });
    if (changedAttributes.length > 0) {
      formDataObj.changedAttributeFields = JSON.stringify(changedAttributes);
    }

    if (changedAltTextIndices.length > 0) {
      formDataObj.changedAltTextIndices = JSON.stringify(changedAltTextIndices);
      debugLog.save(' Changed alt-text indices (translations will be deleted):', changedAltTextIndices);
    }
  }

  // Skip next data load to prevent revalidation from overwriting cleared/saved values.
  savedLocaleRef.current = currentLanguage; // Track which locale we're saving
  savedMarketIdRef.current = selectedMarketId;
  savedItemIdRef.current = selectedItemId; // Track which item we're saving
  isSavePendingRef.current = true; // Track that a save was initiated
  setIsSaving(true); // Drive spinner — fetcher.state is unreliable due to React 18 batching
  safeSubmit(formDataObj, { method: "POST" });
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
};

/**
 * @param userInstruction Ad-hoc instruction the merchant typed into the
 *   AIInstructionPrompt box before submitting. Undefined/empty keeps the
 *   previous behaviour (no extra form field, unchanged server prompt).
 */
const handleGenerateAI = (fieldKey: string, userInstruction?: string) => {
  if (!selectedItemId || !selectedItem) return;

  const requestItemId = selectedItemId;
  const currentValue = editableValues[fieldKey] || "";
  const contextTitle = editableValues.title || "";
  const contextDescription = editableValues.description || editableValues.body || "";
  const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === currentLanguage)?.name || currentLanguage;

  // The images this item COULD show the AI, best first. Whether any of them is
  // actually sent, and how many, is the shop's setting and is decided
  // server-side — this route takes a direct POST, so the client offering
  // candidates is the only honest half of that contract it can hold up.
  const imageCandidates = aiImageCandidates(config.contentType, selectedItem, selectedImageIndex);

  submitAIAction(
    {
      action: "generateAIText",
      itemId: selectedItemId,
      fieldType: fieldKey,
      currentValue,
      contextTitle,
      contextDescription,
      mainLanguage,
      // Which locale's tracked keywords the prompt should use ("" = primary,
      // the SeoKeyword convention). `mainLanguage` is a display name and can't
      // serve — without this, French copy got the German target keyword.
      keywordLocale: currentLanguage === primaryLocale ? "" : currentLanguage,
      ...(imageCandidates.length > 0 && { imageUrls: JSON.stringify(imageCandidates) }),
      ...(userInstruction?.trim() && { userInstruction: userInstruction.trim() }),
    },
    fieldKey,
    (result) => {
      // Guard: discard if user has switched to a different item since the request was made
      if (selectedItemIdRef.current !== requestItemId) return;
      setAiSuggestions((prev) => ({
        ...prev,
        [fieldKey]: result.generatedContent as string,
      }));
      // Stuffing guard (PLAN_KEYWORDS_EXPANSION.md §3.2): the server retried
      // once and the output STILL over-uses a tracked keyword — warn so the
      // merchant reviews the suggestion before accepting it. This raw-fetch
      // callback is the REAL generate path (submitAIAction), not the legacy
      // fetcher branch in useUnifiedContentEditor.
      if ((result as { keywordStuffingWarning?: boolean }).keywordStuffingWarning) {
        showInfoBox(
          (t.seo as { keywordStuffingWarning?: string } | undefined)?.keywordStuffingWarning ||
            "The generated text still over-uses a tracked keyword — review it before accepting.",
          "warning",
          t.common?.warning || "Warning"
        );
      }
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

  // The images this item COULD show the AI, best first. Whether any of them is
  // actually sent, and how many, is the shop's setting and is decided
  // server-side — this route takes a direct POST, so the client offering
  // candidates is the only honest half of that contract it can hold up.
  const imageCandidates = aiImageCandidates(config.contentType, selectedItem, selectedImageIndex);

  submitAIAction(
    {
      action: "formatAIText",
      itemId: selectedItemId,
      fieldType: fieldKey,
      currentValue,
      contextTitle,
      contextDescription,
      mainLanguage,
      // Same locale contract as generation — the format pass must preserve THIS
      // language's keywords, not the primary language's.
      keywordLocale: currentLanguage === primaryLocale ? "" : currentLanguage,
      ...(imageCandidates.length > 0 && { imageUrls: JSON.stringify(imageCandidates) }),
    },
    fieldKey,
    (result) => {
      // Guard: discard if user has switched to a different item since the request was made
      if (selectedItemIdRef.current !== requestItemId) return;
      setAiSuggestions((prev) => ({
        ...prev,
        [fieldKey]: result.generatedContent as string,
      }));
      // Formatting may now work a missing target keyword in, so it can overshoot
      // the same way generation can — and warns the same way.
      if ((result as { keywordStuffingWarning?: boolean }).keywordStuffingWarning) {
        showInfoBox(
          (t.seo as { keywordStuffingWarning?: string } | undefined)?.keywordStuffingWarning ||
            "The formatted text still over-uses a tracked keyword — review it before accepting.",
          "warning",
          t.common?.warning || "Warning"
        );
      }
    }
  );
};

/**
 * Work the tracked keywords of the ACTIVE language into every field that is
 * still missing them, without rewriting anything else (the `insertKeyword`
 * pass). Unlike "Formatieren" this touches only what it has to: a field whose
 * keywords are already present is not even sent to the server.
 *
 * Results land in aiSuggestions like every other AI action, so the merchant
 * reviews and accepts them per field instead of the button writing silently.
 */
const handleInsertKeywords = async () => {
  if (!selectedItemId || !selectedItem) return;
  const seoStrings = t.seo as
    | {
        insertKeywordsNothing?: string;
        insertKeywordsNoneMissing?: string;
        insertKeywordsDone?: string;
      }
    | undefined;
  const requestItemId = selectedItemId;

  // The fields a keyword can live in, in the order the server understands
  // them. Slugs are deliberately absent — the pass skips them anyway, and
  // asking would only cost a round trip.
  const candidateKeys = ["title", "seoTitle", "metaDescription", "description", "body"].filter(
    (key) =>
      effectiveFieldDefinitions.some((f) => f.key === key) && (editableValues[key] || "").trim(),
  );
  if (candidateKeys.length === 0) {
    showInfoBox(
      seoStrings?.insertKeywordsNothing || "No text to work keywords into.",
      "warning",
      t.common?.warning || "Warning",
    );
    return;
  }

  setIsInsertingKeywords(true);
  let changed = 0;
  let stuffing = false;
  try {
    // Sequential on purpose: the fields share one item and one AI queue, and a
    // fan-out here would just contend with itself.
    for (const fieldKey of candidateKeys) {
      if (selectedItemIdRef.current !== requestItemId) return;
      await submitAIAction(
        {
          action: "insertKeyword",
          itemId: requestItemId,
          fieldType: fieldKey,
          currentValue: editableValues[fieldKey] || "",
          // Same locale contract as generation and format: THIS language's
          // keywords, not the primary language's.
          keywordLocale: currentLanguage === primaryLocale ? "" : currentLanguage,
        },
        fieldKey,
        (result) => {
          if (selectedItemIdRef.current !== requestItemId) return;
          if (result.skipped) return;
          changed += 1;
          if ((result as { keywordStuffingWarning?: boolean }).keywordStuffingWarning) stuffing = true;
          setAiSuggestions((prev) => ({ ...prev, [fieldKey]: result.value as string }));
        },
      );
    }
  } finally {
    setIsInsertingKeywords(false);
  }

  if (selectedItemIdRef.current !== requestItemId) return;
  if (changed === 0) {
    showInfoBox(
      seoStrings?.insertKeywordsNoneMissing || "Every tracked keyword is already in the texts.",
      "info",
      String(t.common?.info || "Info"),
    );
    return;
  }
  showInfoBox(
    (seoStrings?.insertKeywordsDone || "Keywords worked into {count} field(s) — review and accept them.")
      .replace("{count}", String(changed)),
    stuffing ? "warning" : "success",
    stuffing ? t.common?.warning || "Warning" : t.common?.success || "Success",
  );
};

const handleTranslateField = (fieldKey: string) => {
  if (!selectedItemId || !selectedItem) return;

  const requestItemId = selectedItemId;
  const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
  if (!field) return;

  const sourceText =
    savedPrimaryValuesRef.current[selectedItemId]?.[fieldKey] ||
    getItemFieldValue(selectedItem, fieldKey, primaryLocale, config);
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
        // Single-field translate auto-saves to the current (foreign) locale —
        // scope it to the selected market so the override lands correctly.
        if (selectedMarketId) formDataObj.marketId = selectedMarketId;
        Object.assign(formDataObj, buildFieldsForSave(newValues, targetLocale));

        // Ensure the translated field is always included in the save.
        // buildFieldsForSave may filter it out due to stale fallbackFieldsRef
        // or originalLoadedValuesRef timing issues during async AI callbacks.
        if (translatedValue && translatedValue.trim()) {
          formDataObj[fieldKey] = translatedValue;
        }

        savedLocaleRef.current = targetLocale;
        savedMarketIdRef.current = selectedMarketId;
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
      if (isThemeContentType(config.contentType)) {
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

/**
 * `options.auto` marks a run the APP started, not the merchant — today only
 * the product type derived from a category pick.
 *
 * It changes nothing about the translation and everything about the reporting.
 * A merchant who presses the translate button is waiting for an answer, so a
 * missing text or an unreachable provider belongs on screen. A merchant who
 * just pressed Save is not waiting for anything, and a red "Error" landing on
 * top of a save they watched succeed reads as "the save broke". So the
 * pre-flight refusals go quiet (the caller has already checked them) and a
 * real failure comes back as ONE warning that names what did not happen and
 * what to press — never as a critical box, and never as silence either.
 */
const handleTranslateFieldToAllLocales = (fieldKey: string, options?: { auto?: boolean }) => {
  if (!selectedItemId || !selectedItem) return;

  const auto = options?.auto === true;
  const requestItemId = selectedItemId;

  // Filter out primary locale and disabled languages
  const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
  if (targetLocales.length === 0) {
    if (!auto) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning",
        t.common?.warning || "Warning"
      );
    }
    return;
  }

  const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
  if (!field) return;

  const sourceText =
    savedPrimaryValuesRef.current[selectedItemId]?.[fieldKey] ||
    getItemFieldValue(selectedItem, fieldKey, primaryLocale, config);
  if (!sourceText) {
    if (!auto) {
      showInfoBox(
        t.content?.noSourceText || "Kein Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
    }
    return;
  }

  const contextTitle =
    savedPrimaryValuesRef.current[selectedItemId]?.["title"] ||
    getItemFieldValue(selectedItem, 'title', primaryLocale, config) ||
    selectedItem.id || "";

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
      if (isThemeContentType(config.contentType) && translations[currentLanguage]) {
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
    },
    // An automatic run reports its own failure, in its own words: what did not
    // happen and what to press. Never silence — a translation that quietly did
    // not run is indistinguishable from one nobody wanted.
    auto
      ? () => {
          showInfoBox(
            String(
              t.content?.autoTranslateFailed ||
                "{field} could not be translated automatically. Use the translate button on the field to do it now.",
            ).replace("{field}", resolveFieldLabel(fieldKey)),
            "warning",
            t.common?.warning || "Warning",
          );
        }
      : undefined,
    auto ? { suppressErrorBox: true } : undefined,
  );
};

const handleTranslateAll = () => {
  if (!selectedItemId || !selectedItem) return;
  // Guard against double-click: if translateAll is already running, ignore
  if (isOperationActive(selectedItemId, "__translateAll__")) return;

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

// R4-UX8 — KNOWN LIMITATION (intentionally deferred, not a half-fix):
// accepting a suggestion overwrites editableValues[fieldKey] in place with
// no diff preview and no PER-FIELD undo. The only recovery today is the
// page-level handleDiscard(), which reverts EVERY unsaved field, so undoing
// one accidental accept also throws away every other in-progress edit.
//
// A correct fix is a real UI feature, not a one-liner: snapshot the
// pre-accept value (e.g. acceptedSuggestionUndo: Record<fieldKey,string>),
// expose handleUndoAcceptedSuggestion via the FieldHandlers contract, and
// add a transient per-field "Undo" affordance with a defined lifecycle
// (clear on save / item switch / reject). That spans this hook, the
// FieldHandlers type, the provider wiring and AISuggestionBanner, and needs
// a UX decision on where/how long the affordance shows. Shipping only the
// state half here would be dead code; a rushed UI risks regressing the
// accept flow. Tracked for a dedicated, design-aligned change.
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
};

const handleAcceptAndTranslate = (fieldKey: string) => {
  const suggestion = aiSuggestions[fieldKey];
  if (!suggestion || !selectedItemId) return;

  // Resource-backed rubrics (Abo-Pläne/System/…) have a read-only main language.
  // If this is somehow invoked while viewing the primary locale, refuse instead
  // of attempting a primary save the server rejects. (Generation is disabled on
  // primary for these rubrics, so this is a defensive guard.)
  if (currentLanguage === primaryLocale && isResourceBackedThemeContent(config.contentType)) {
    showInfoBox(
      String(t.content?.primaryReadOnlyHint
        || "This field can't be edited in the main language here — manage the original in your Shopify admin. You can still translate it into other languages."),
      "warning",
      String(t.common?.warning || "Warning")
    );
    return;
  }

  // Set flag to prevent translation deletion during this flow
  setIsAcceptAndTranslateFlow(true);

  // If this field was a fallback, remove it since user accepted an AI value
  if (fallbackFields.has(fieldKey)) {
    setFallbackFields((prev) => {
      const newSet = new Set(prev);
      newSet.delete(fieldKey);
      return newSet;
    });
    fallbackFieldsRef.current.delete(fieldKey);
  }

  // Create the new values with the accepted suggestion
  const newValues = {
    ...editableValues,
    [fieldKey]: suggestion,
  };

  // Accept the suggestion into the currently-viewed locale
  setEditableValues(newValues);

  setAiSuggestions((prev) => {
    const newSuggestions = { ...prev };
    delete newSuggestions[fieldKey];
    return newSuggestions;
  });

  // Get context title for translation
  const contextTitle = getItemFieldValue(selectedItem!, 'title', primaryLocale, config) || selectedItem!.id || "";

  // ==========================================================================
  // FOREIGN LOCALE PATH
  // The accepted suggestion is written in a foreign language `L`. We must NOT
  // treat it as primary base content (the old bug copied the foreign text into
  // every primary field untranslated). Instead:
  //   1. Keep the accepted text EXACTLY in `L`.
  //   2. Translate it INTO the primary language and save that as the primary
  //      base content for THIS field only — WITHOUT `changedFields`, so the
  //      existing foreign translations are NOT deleted (the one field is
  //      re-registered by this flow).
  //   3. Translate the accepted text into the OTHER foreign locales (source =
  //      `L`, so no double translation via the primary language).
  // ==========================================================================
  if (currentLanguage !== primaryLocale) {
    const L = currentLanguage;
    const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
    const requestItemId = selectedItemId;

    // Fields without a translationKey cannot be saved as a translation — just
    // accept the value into `L` and let the user save manually.
    if (!field?.translationKey) {
      setIsAcceptAndTranslateFlow(false);
      return;
    }
    const translationKey = field.translationKey;

    // The foreign flow uses hand-built saves (not performAutoSave), so the
    // deletion-suppression flag isn't needed. Clear it so a subsequent manual
    // save isn't affected.
    setIsAcceptAndTranslateFlow(false);

    // Update the `L` overlay AND the change-detection baseline IMMEDIATELY so the
    // accepted field is not flagged "dirty" — everything here saves automatically,
    // so the Save button must stay inactive.
    const transResult = dataLoader.onTranslateFieldComplete(
      fieldKey,
      translationKey,
      suggestion,
      L,
      editableValuesRef.current,
      // Accept & Translate persists GLOBALLY in Phase 1 (foreignForm below has no
      // marketId), so the overlay must be staged under the global key too.
      ""
    );
    if (transResult.updatedValues) setEditableValues(transResult.updatedValues);

    // Persist the accepted foreign text EXACTLY in `L`.
    const foreignSaveValues = { ...editableValuesRef.current, [fieldKey]: suggestion };
    const foreignForm: Record<string, string> = {
      action: "updateContent",
      itemId: requestItemId,
      locale: L,
      primaryLocale,
    };
    Object.assign(foreignForm, buildFieldsForSave(foreignSaveValues, L));
    // Always include the accepted field (buildFieldsForSave may filter it out
    // due to stale originalLoadedValuesRef timing during async callbacks).
    foreignForm[fieldKey] = suggestion;
    savedLocaleRef.current = L;
    savedMarketIdRef.current = selectedMarketId;
    savedItemIdRef.current = requestItemId;
    isSavePendingRef.current = true;
    isSaveFromTranslateRef.current = true;
    safeSubmit(foreignForm, { method: "POST" });
    originalLoadedValuesRef.current = { ...foreignSaveValues };

    // ONE AI call: translate the accepted text into the primary language AND the
    // other foreign locales in a single batch. The server persists the OTHER
    // locales as translations but SKIPS the primary locale (skipSaveLocales) and
    // returns it, so the client saves it as base content (below).
    // Resource-backed rubrics (Abo-Pläne/System/Versand/Filter) have a read-only
    // main language — the original lives in Shopify. Do NOT back-translate the
    // accepted text into the primary language, save it, or overlay it in the UI;
    // only translate into the OTHER foreign locales.
    const primaryReadOnly = isResourceBackedThemeContent(config.contentType);
    const targetOthers = enabledLanguages.filter((l) => l !== primaryLocale && l !== L);
    const allTargets = primaryReadOnly ? targetOthers : [primaryLocale, ...targetOthers];

    // Nothing left to translate (no other foreign locales) — the accepted text is
    // already saved in `L`. For read-only rubrics that is the whole job; inform.
    if (allTargets.length === 0) {
      if (primaryReadOnly) {
        showInfoBox(
          String(t.content?.primaryReadOnlyTranslateInfo
            || "The main language is read-only for this content type — the translation was accepted, but the original is managed in your Shopify admin."),
          "info",
          String(t.common?.info || "Info")
        );
      }
      return;
    }

    debugLog.acceptAndTranslate(' Foreign locale: single batch translate (primary + others), source = ' + L);
    submitAIAction(
      {
        action: "translateFieldToAllLocales",
        itemId: requestItemId,
        fieldType: fieldKey,
        sourceText: suggestion,
        targetLocales: JSON.stringify(allTargets),
        // Translate the primary too, but don't persist it as a foreign
        // translation — the client saves it as base content below. For read-only
        // rubrics the primary is not a target at all, so nothing to skip.
        skipSaveLocales: JSON.stringify(primaryReadOnly ? [] : [primaryLocale]),
        contextTitle,
        // Server treats `primaryLocale` as the SOURCE language for the AI call.
        primaryLocale: L,
      },
      fieldKey,
      (result) => {
        if (selectedItemIdRef.current !== requestItemId) return;
        const translations = (result.translations as Record<string, string>) || {};

        // Save the primary-language value as BASE content (this field only, NO
        // changedFields → existing foreign translations are preserved).
        // Read-only rubrics never translate/save/overlay the main language.
        const primaryTranslated = primaryReadOnly ? "" : (translations[primaryLocale] || "").trim();
        if (primaryTranslated) {
          // Overlay the new primary value so the main language shows it
          // IMMEDIATELY when the user switches to it — independent of when the
          // primary base save commits or whether the loader reads stale data.
          // resolve() checks savedPrimaryValuesRef first for the primary locale.
          if (!savedPrimaryValuesRef.current[requestItemId]) {
            savedPrimaryValuesRef.current[requestItemId] = {};
          }
          savedPrimaryValuesRef.current[requestItemId][fieldKey] = primaryTranslated;

          const primaryForm: Record<string, string> = {
            action: "updateContent",
            itemId: requestItemId,
            locale: primaryLocale,
            primaryLocale,
            [fieldKey]: primaryTranslated,
          };
          // Products reject any primary-locale update without a non-empty title
          // (updatePrimaryProduct); include the real primary title for non-title
          // single-field saves.
          if (config.contentType === "products" && fieldKey !== "title") {
            primaryForm.title = getItemFieldValue(selectedItem!, "title", primaryLocale, config);
          }
          if (config.resourceType === "ShopPolicy" && selectedItem?.type) {
            primaryForm.policyType = selectedItem.type;
          }
          // Keep savedLocaleRef on `L`: we are viewing L, the server persists
          // this as primary via the form `locale` field, and processing the
          // response under `primaryLocale` would pick a stale primary baseline.
          savedLocaleRef.current = L;
          savedMarketIdRef.current = selectedMarketId;
          savedItemIdRef.current = requestItemId;
          isSavePendingRef.current = true;
          isSaveFromTranslateRef.current = true;
          safeSubmit(primaryForm, { method: "POST" });
        }

        // Update overlays for the OTHER foreign locales (already saved server-side).
        const othersTranslations: Record<string, string> = {};
        for (const [loc, val] of Object.entries(translations)) {
          if (loc !== primaryLocale) othersTranslations[loc] = val;
        }
        if (Object.keys(othersTranslations).length > 0) {
          dataLoader.onTranslateFieldToAllLocalesComplete(translationKey, othersTranslations, L);
        }

        const failedLocales = (result.failedLocales as string[]) || [];
        const fieldLabel = resolveFieldLabel(fieldKey);
        if (failedLocales.length > 0) {
          showInfoBox(
            String(t.content?.translatePartialLocales || "Translation partially completed: {successCount}/{totalCount} language(s) succeeded. Language(s) {failedLocales} failed.")
              .replace("{successCount}", String(Object.keys(translations).length))
              .replace("{totalCount}", String(Object.keys(translations).length + failedLocales.length))
              .replace("{failedLocales}", failedLocales.join(", ")),
            "warning",
            t.common?.warning || "Warning"
          );
        } else {
          showInfoBox(
            t.common?.fieldTranslatedToLanguages
              ?.replace("{fieldType}", fieldLabel)
              .replace("{count}", String(Object.keys(othersTranslations).length + (primaryTranslated ? 1 : 0)))
              || `${fieldLabel} translated`,
            "success",
            t.common?.success || "Success"
          );
        }

        setIsLoadingData(true);
        // Revalidate to reconcile with the server's canonical data. The primary
        // and other-locale overlays above already drive the UI, so even if this
        // revalidation races the in-flight primary save and briefly reads stale
        // data, resolve() keeps showing the new (overlaid) values until the
        // server catches up.
        try { revalidatorRef.current.revalidate(); } catch {}
      },
      () => {
        // Translation failed — the accepted foreign text is still saved in `L`.
        if (selectedItemIdRef.current !== requestItemId) return;
      }
    );
    return;
  }

  // ==========================================================================
  // PRIMARY LOCALE PATH (unchanged)
  // ==========================================================================
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



  // For theme content, adopt the accepted values as the change-detection baseline
  // NOW, in the same synchronous batch as setEditableValues(newValues) above.
  // Otherwise the save button flickers active for the whole in-flight primary save:
  // isLoadingData is not held during a fetcher submit, so editableValues != baseline
  // reads as dirty until the save response finally resets the baseline. This save is
  // automatic ("Übernehmen & Übersetzen" auto-saves), so no dirty state should show.
  if (isThemeContentType(config.contentType)) {
    baselineValuesRef.current = { ...newValues };
    setBaselineVersion((v) => v + 1);
    originalTemplateValuesRef.current = { ...newValues };
    setTemplateValuesVersion((v) => v + 1);
  }

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

const handleLanguageChange = async (locale: string) => {
  if (hasChanges || isSavingCurrentItem) {
    await confirmNavigation();
  }
  setCurrentLanguage(locale);
  // If the currently-selected market does not serve the new locale, fall back to
  // "global" — a market-specific translation only makes sense for locales the
  // market actually offers (and the primary locale is always global).
  if (selectedMarketId && locale === primaryLocale) {
    setSelectedMarketId("");
  } else if (selectedMarketId) {
    const market = markets.find((m) => m.id === selectedMarketId);
    if (!market || !market.localeCodes.includes(locale)) {
      setSelectedMarketId("");
    }
  }
};

const handleMarketChange = async (marketId: string) => {
  if (marketId === selectedMarketId) return;
  // Market switch behaves like a locale switch "light": no server round-trip, but
  // unsaved edits would be lost on re-resolve, so guard them the same way.
  if (hasChanges || isSavingCurrentItem) {
    await confirmNavigation();
  }
  setSelectedMarketId(marketId);
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

const handleItemSelect = async (itemId: string) => {
  if (hasChanges || isSavingCurrentItem) {
    await confirmNavigation();
  }
  setSelectedItemId(itemId);
  // Persist only on explicit user selection. Restore-effects and the
  // disappear-fallback in useUnifiedContentEditor must NOT write — see
  // the comment block above the restore effect for why.
  writeLastSelectedId(config.contentType, itemId);
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

  // Clear any translation error for this field when the user starts editing
  setFieldErrors(prev => {
    if (!prev[fieldKey]) return prev;
    const next = { ...prev };
    delete next[fieldKey];
    return next;
  });

  // Update the state immediately without any side effects
  // This ensures the input field responds instantly to user typing
  setEditableValues((prev) => ({
    ...prev,
    [fieldKey]: value,
  }));
}, [fallbackFieldsRef, setFieldErrors]);

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
      // Market-fold the overlay + deleted keys so clearing a market-specific
      // value does not blank the global value (resolve() then falls back to it).
      const localeKey = buildLocaleKey(currentLanguage, selectedMarketId);
      if (localTranslationsRef.current[tKey]) {
        delete localTranslationsRef.current[tKey][localeKey];
      }
      // Mark as deleted so resolve() returns empty even if item.translations has old data
      deletedTranslationKeysRef.current.add(buildDeletedKey(tKey, selectedMarketId));
    }
  }
}, [fallbackFieldsRef, currentLanguage, selectedMarketId, primaryLocale, effectiveFieldDefinitions]);

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
  // reflect the cleared state immediately (yellow highlight + button blinking).
  // Market-fold the keys so a market-scoped "clear all for this locale" only
  // blanks the market overrides and lets resolve() fall back to the global values
  // (mirrors the market-scoped save above and handleClearField).
  const clearLocaleKey = buildLocaleKey(currentLanguage, selectedMarketId);
  effectiveFieldDefinitions.forEach((field) => {
    const tKey = field.translationKey;
    if (localTranslationsRef.current[tKey]) {
      delete localTranslationsRef.current[tKey][clearLocaleKey];
    }
    // Mark as deleted so resolve() returns empty even if item.translations has old data
    deletedTranslationKeysRef.current.add(buildDeletedKey(tKey, selectedMarketId));
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
  // Clearing all fields for the current locale is market-scoped: it removes only
  // the selected market's overrides, leaving the global translations intact.
  if (currentLanguage !== primaryLocale && selectedMarketId) {
    formDataObj.marketId = selectedMarketId;
  }

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
  savedMarketIdRef.current = selectedMarketId;
  isSavePendingRef.current = true;
  safeSubmit(formDataObj, { method: "POST" });
};

const handleTranslateAllForLocale = () => {
  if (!selectedItemId || !selectedItem || currentLanguage === primaryLocale) return;
  // Guard against double-click: if translateAllForLocale is already running for this locale, ignore
  if (isOperationActive(selectedItemId, `__translateAllForLocale__${currentLanguage}`)) return;

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

const handleCopyField = (fieldKey: string): void => {
  if (!selectedItemId || !selectedItem) return;
  const field = effectiveFieldDefinitions.find(f => f.key === fieldKey);
  if (!field) return;
  const primaryValue = getItemFieldValue(selectedItem, fieldKey, primaryLocale, config);
  if (!primaryValue) return;

  const transResult = dataLoader.onTranslateFieldComplete(
    fieldKey,
    field.translationKey,
    primaryValue,
    currentLanguage,
    editableValuesRef.current
  );

  if (transResult.updatedValues) {
    setEditableValues(transResult.updatedValues);
  } else {
    setEditableValues(prev => ({ ...prev, [fieldKey]: primaryValue }));
  }
  if (transResult.clearedFallbackKeys.length > 0) {
    setFallbackFields(prev => {
      const newSet = new Set(prev);
      transResult.clearedFallbackKeys.forEach(k => newSet.delete(k));
      return newSet;
    });
    transResult.clearedFallbackKeys.forEach(k => fallbackFieldsRef.current.delete(k));
  }

  const newValues = transResult.updatedValues ?? { ...editableValuesRef.current, [fieldKey]: primaryValue };
  const formDataObj: Record<string, string> = {
    action: "updateContent",
    itemId: selectedItemId,
    locale: currentLanguage,
    primaryLocale,
  };
  // Copy-to-field persists to the current (foreign) locale under the selected market.
  if (currentLanguage !== primaryLocale && selectedMarketId) {
    formDataObj.marketId = selectedMarketId;
  }
  Object.assign(formDataObj, buildFieldsForSave(newValues, currentLanguage));
  formDataObj[fieldKey] = primaryValue;

  markOperationActive(selectedItemId, fieldKey, "copy");
  pendingCopyFieldKeyRef.current = fieldKey;

  savedLocaleRef.current = currentLanguage;
  savedMarketIdRef.current = selectedMarketId;
  // Track WHICH item is being saved so the save-response handler's
  // `isSavedItemCurrent` guard passes. Without this, savedItemIdRef stays null
  // (cleared by a prior save) → the handler early-returns before reaching
  // markOperationFailed(copy), leaving every button on this field spinning forever.
  savedItemIdRef.current = selectedItemId;
  isSavePendingRef.current = true;
  isSaveFromTranslateRef.current = true;
  safeSubmit(formDataObj, { method: "POST" });
  originalLoadedValuesRef.current = { ...newValues };

  // Success/error feedback is deferred to the save-response handler so the
  // InfoBox reflects the actual Shopify result (see pendingCopyFieldKeyRef in
  // useUnifiedContentEditor.ts), not an optimistic guess.
};

const handleCopyFieldToAllLocales = (fieldKey: string): void => {
  if (!selectedItemId) return;
  const field = effectiveFieldDefinitions.find(f => f.key === fieldKey);
  if (!field) return;
  const primaryValue = editableValuesRef.current[fieldKey];
  if (!primaryValue) return;

  const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
  if (targetLocales.length === 0) return;

  const translations: Record<string, string> = Object.fromEntries(
    targetLocales.map(locale => [locale, primaryValue])
  );

  dataLoader.onTranslateFieldToAllLocalesComplete(field.translationKey, translations, currentLanguage);

  const capturedItemId = selectedItemId;
  markOperationActive(capturedItemId, fieldKey, "copyToAllLocales");

  const runSaves = async () => {
    for (const locale of targetLocales) {
      const fd = new FormData();
      fd.set("action", "updateContent");
      fd.set("itemId", capturedItemId);
      fd.set("locale", locale);
      fd.set("primaryLocale", primaryLocale);
      fd.set(fieldKey, primaryValue);
      try {
        await fetch(window.location.pathname, { method: "POST", body: fd });
      } catch {
        // individual locale save failure is non-critical
      }
    }
    markOperationFailed(capturedItemId, fieldKey);
  };
  runSaves();

  onTranslateToAllLocalesComplete?.(fieldKey, translations);
  showInfoBox(t.common?.copied ?? "Copied", "success");
};

  return {
    handleSave,
    handleDiscard,
    handleGenerateAI,
    handleFormatAI,
    handleInsertKeywords,
    isInsertingKeywords,
    handleTranslateField,
    handleTranslateFieldToAllLocales,
    handleCopyField,
    handleCopyFieldToAllLocales,
    handleTranslateAll,
    handleAcceptSuggestion,
    handleAcceptAndTranslate,
    handleRejectSuggestion,
    handleLanguageChange,
    handleMarketChange,
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
