/**
 * Field Handlers Hook
 *
 * Extracted from useUnifiedContentEditor.ts — all field-related event handlers.
 * Handles: save, discard, AI generate, translate, accept/reject suggestions,
 *          language/item selection, value changes, clear operations.
 */

import type { PartialSave } from "./useUiDataLoader";
import { isThemeContentType, isResourceBackedThemeContent } from "~/utils/content-type-groups";
import { isAttributeField, isTranslatableFieldDefinition } from "../services/content-attributes.shared";
import { buildLocaleDeletedKey, dropLocaleMarks } from "../services/editor/deleted-translation-marks.shared";
import { useCallback, useRef, useState } from "react";
import { getTranslatedValue } from "../utils/contentEditor.utils";
import { getItemFieldValue, buildLocaleKey, buildDeletedKey } from "./useUiDataLoader";
import { debugLog } from "../utils/debug";
import { writeLastSelectedId } from "../utils/last-selected-item";
import { writeLastContentLocale } from "../utils/last-content-locale";
import { markOperationActive, markOperationFailed, isOperationActive, isTranslateIntoLocaleRunning } from "./useAIOperationsStore";
import {
  setFieldSuggestion,
  clearFieldSuggestion,
  clearSuggestionsForScope,
  type SuggestionScope,
} from "./useAISuggestionStore";
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
import { partialLocaleCounts } from "../services/translations/partial-result.shared";
import { postContentEditorSave } from "../services/editor/content-action-endpoint.shared";
import { runPerLocaleSavesDetailed, copyOutcomeMessage } from "../services/editor/per-locale-saves.shared";
import { fallbackFieldsAfterDiscard, type LoadedFallbackSnapshot } from "../services/editor/discard-fallback.shared";
import { buildOwnSaveForm, isUnsavedPrimarySource, hasUnsavedPrimaryTranslateSource } from "../services/editor/own-field-save.shared";
import { applyAltTranslateAllAnswer, forLocaleAltResults } from "../services/alt-text-feedback.shared";

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
  onCopyToAllLocalesFailed?: (fieldKey: string, locales: string[]) => void;

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
  /** Item + locale + market the suggestions above are stored under. */
  suggestionScope: SuggestionScope;
  imageAltTexts: Record<number, string>;
  originalAltTexts: Record<number, string>;
  selectedImageIndex: number;
  fallbackFields: Set<string>;

  // Refs (MutableRefObject-compatible)
  selectedItemIdRef: { current: string | null };
  selectedItemRef: { current: TranslatableContentItem | undefined };
  editableValuesRef: { current: Record<string, string> };
  imageAltTextsRef: { current: Record<number, string> };
  /** Locale (or `locale::market`) → index → alt text, from useEditorAltText.
   *  Checked BEFORE the loaded item, so a primary save has to drop what the
   *  server just deleted here as well. */
  localAltTextOverlayRef: { current: Record<string, Record<number, string>> };
  originalAltTextsRef: { current: Record<number, string> };
  fallbackFieldsRef: { current: Set<string> };
  /** Which fields the last load resolved as INHERITED, and with what value —
   *  Discard restores their fallback flag (see fallbackFieldsAfterDiscard). */
  loadedFallbackRef?: { current: LoadedFallbackSnapshot | null };
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
  /** An AI/copy button's own save is in flight. Those saves are kept out of
   *  `hasChanges`, so no confirmation can ask about them: a view switch is
   *  REFUSED with a message while one is on its way (never queued). */
  isOwnSaveInFlight?: () => boolean;
  isSaveFromTranslateRef: { current: boolean };
  /** Set by a save that carries only SOME fields (a single-field translate),
   *  read by the save-response handling so it treats only those as saved. */
  partialSaveRef: { current: PartialSave | null };
  /** The locale on screen NOW — an AI callback lands after the merchant may
   *  have switched away from the locale it was asked for. */
  currentLanguageRef: { current: string };
  selectedMarketIdRef: { current: string };
  /** Tracks the fieldKey of a copy save so the response handler can clear the loading state. */
  pendingCopyFieldKeyRef: { current: string | null };
  pendingCopyFieldItemIdRef: { current: string | null };
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
  /** "Translate all" as its own request, never queued with the saves on the
   *  shared fetcher (see useUnifiedContentEditor). Optional for callers that
   *  render the handlers alone; they fall back to the fetcher. */
  submitTranslateRun?: (data: Record<string, string>, itemId: string | null) => void;
  /** Refuses (with a message, returning true) an AI/copy button's own save of
   *  (item, locale) while a "translate all" run blocks it. Asked at the START
   *  of every own-save flow, before anything is staged. */
  refuseOwnSave?: (itemId: string | null, locale: string, opts?: { notStarted?: boolean }) => boolean;
  /** The same rule, silent. */
  isOwnSaveBlocked?: (itemId: string | null, locale: string) => boolean;
  /** "Saved; the translation into the other languages was skipped". */
  sayTranslateToOthersSkipped?: () => void;
  sayPrimaryTextSkipped?: () => void;
  /** Refuses (with a message, returning true) a "translate all" run while a
   *  save of the item it would race is out or queued. `locale` "*" = every
   *  language. */
  refuseTranslateRun?: (itemId: string, locale: string) => boolean;
  /** The "deleted" marks a save that is out or queued still stands behind:
   *  they are not a discarded draft's, and stay. */
  deletedMarksOfSavesOut?: () => ReadonlySet<string>;
  buildFieldsForSave: (values: Record<string, string>, locale: string) => Record<string, string>;
  getChangedFields: (valuesToCheck: Record<string, string>) => string[];
  getChangedAltTextIndices: () => number[];
  resolveFieldLabel: (fieldKey: string) => string;
  showInfoBox: (message: string, tone: InfoBoxTone) => void;
  dataLoader: {
    onTranslateFieldComplete: (
      fieldKey: string,
      translationKey: string,
      translatedValue: string,
      targetLocale: string,
      currentEditableValues: Record<string, string>,
      marketIdArg?: string,
      viewing?: boolean
    ) => TransitionResult;
    onTranslateFieldToAllLocalesComplete: (
      translationKey: string,
      translations: Record<string, string>,
      currentLocale: string
    ) => void;
    onCopyToLocalesFailed: (
    translationKey: string,
    locales: string[],
    copiedValue: string,
    opts?: { itemUnchanged?: boolean; allLocalesFailed?: boolean },
  ) => void;
  };

  // State setters
  setSelectedItemId: React.Dispatch<React.SetStateAction<string | null>>;
  setCurrentLanguage: React.Dispatch<React.SetStateAction<string>>;
  setSelectedMarketId: React.Dispatch<React.SetStateAction<string>>;
  /** All markets (for the language-change reset guard). */
  markets: MarketInfo[];
  setEditableValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setHtmlModes: React.Dispatch<React.SetStateAction<Record<string, "html" | "rendered">>>;
  setEnabledLanguages: React.Dispatch<React.SetStateAction<string[]>>;
  setIsAcceptAndTranslateFlow: React.Dispatch<React.SetStateAction<boolean>>;
  setIsLoadingData: React.Dispatch<React.SetStateAction<boolean>>;
  setIsClearAllModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setImageAltTexts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
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
  /** The single-field Copy's save was refused: take back the overlay value,
   *  the baselines and the visible value it wrote up front. */
  /** `keepVisible`: the copied text stays on screen as an unsaved draft (a
   *  refused own save); only what marked it saved is undone. */
  rollbackCopyField: (opts?: { keepVisible?: boolean }) => void;
  /** The copy LANDED: forget its rollback record. */
  discardCopyFieldRecord: () => void;
  handleCopyFieldToAllLocales: (fieldKey: string) => void;
  /** `false` when the run was refused (nothing was started). */
  handleTranslateAll: () => boolean | void;
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
  handleClearAllForLocaleConfirm: () => boolean | void;
  handleTranslateAllForLocale: () => boolean | void;
}

// ============================================================================
// HOOK
// ============================================================================

/** What a single-field Copy wrote before its save answered, and what was
 *  there before, so a refused save can put the real stored value back. */
interface CopyFieldRollback {
  itemId: string;
  fieldKey: string;
  translationKey: string;
  localeKey: string;
  deletedKey: string;
  /** This locale's own "cleared" mark, which the copy drops too. */
  localeDeletedKey: string;
  hadLocaleDeletedMarker: boolean;
  locale: string;
  marketId: string;
  value: string;
  prevOverlay: string | undefined;
  hadDeletedMarker: boolean;
  prevBaseline: string | undefined;
  prevOriginalLoaded: string | undefined;
  prevEditable: string | undefined;
  wasFallback: boolean;
}

export function useFieldHandlers(props: FieldHandlerProps): FieldHandlers {
  const copyFieldRollbackRef = useRef<CopyFieldRollback | null>(null);
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
    onCopyToAllLocalesFailed,
    selectedItemId,
    selectedItem,
    currentLanguage,
    selectedMarketId,
    hasChanges,
    hasAltTextChanges,
    enabledLanguages,
    editableValues,
    aiSuggestions,
    suggestionScope,
    imageAltTexts,
    originalAltTexts,
    selectedImageIndex,
    fallbackFields,
    selectedItemIdRef,
    selectedItemRef,
    editableValuesRef,
    imageAltTextsRef,
    localAltTextOverlayRef,
    originalAltTextsRef,
    fallbackFieldsRef,
    loadedFallbackRef,
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
    isOwnSaveInFlight,
    isSaveFromTranslateRef,
    partialSaveRef,
    currentLanguageRef,
    selectedMarketIdRef,
    pendingCopyFieldKeyRef,
    pendingCopyFieldItemIdRef,
    pendingTranslationAfterSaveRef,
    acceptedPrimaryValueRef,
    initialLoadSuccessfulRef,
    retryCountRef,
    submitAIAction,
    performAutoSave,
    safeSubmit,
    submitTranslateRun,
    refuseTranslateRun,
    deletedMarksOfSavesOut,
    refuseOwnSave,
    isOwnSaveBlocked,
    sayTranslateToOthersSkipped,
    sayPrimaryTextSkipped,
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
    setHtmlModes,
    setEnabledLanguages,
    setIsAcceptAndTranslateFlow,
    setIsLoadingData,
    setIsClearAllModalOpen,
    setImageAltTexts,
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

/** Is this field's PRIMARY value an unsaved draft? (False on a foreign locale.) */
const isPrimaryFieldUnsaved = (fieldKey: string): boolean =>
  isUnsavedPrimarySource({
    currentLanguage: currentLanguageRef.current,
    primaryLocale,
    value: editableValuesRef.current[fieldKey],
    baseline: baselineValuesRef.current[fieldKey],
  });

/** Any primary draft the whole-item "Translate all" would take as its source
 *  (a translatable field or an alt text). False on a foreign locale. */
const hasUnsavedTranslateAllSource = (): boolean =>
  hasUnsavedPrimaryTranslateSource({
    currentLanguage: currentLanguageRef.current,
    primaryLocale,
    fieldKeys: effectiveFieldDefinitions.filter(isTranslatableFieldDefinition).map((f) => f.key),
    values: editableValuesRef.current,
    baseline: baselineValuesRef.current,
    alts: imageAltTexts,
    originalAlts: originalAltTextsRef.current,
  });

const refuseUnsavedSource = (): void => {
  showInfoBox(
    String(t.common?.saveFirstSource || "Save first — the main-language text has unsaved changes."),
    "warning",
  );
};

/**
 * Save ONE field — an AI or copy button's own result — immediately, and
 * nothing else (owner's rule, 2026-10-02: AI and copy buttons save at once,
 * typing stays a draft). The other fields and alt texts on screen may hold
 * the merchant's unsaved input; they stay drafts for the Save button, which is
 * why the save is PARTIAL (its response moves only this field's baseline).
 *
 * On the primary locale a real change of the field travels as `changedFields`
 * — the merchant's purge / auto-translate policy then applies exactly as if
 * they had typed it and pressed Save — unless the caller is about to write
 * the translations itself (`markChanged: false`, accept-and-translate).
 */
const submitOwnFieldSave = (
  fieldKey: string,
  value: string,
  opts: { markChanged?: boolean; fromTranslate?: boolean } = {},
): boolean => {
  if (!selectedItemId) return false;
  const locale = currentLanguage;
  // Before anything below is staged (the saved-primary cache, the marks).
  if (refuseOwnSave?.(selectedItemId, locale)) return false;
  const marketId = selectedMarketId;
  const isPrimary = locale === primaryLocale;
  const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
  const changed =
    isPrimary && opts.markChanged !== false
      ? getChangedFields({ ...editableValuesRef.current, [fieldKey]: value }).includes(fieldKey)
      : false;
  const form = buildOwnSaveForm({
    itemId: selectedItemId,
    locale,
    primaryLocale,
    marketId,
    fields: { [fieldKey]: value },
    changedFields: changed ? [fieldKey] : [],
    changedAttributeFields: changed && field && isAttributeField(field) ? [fieldKey] : [],
    policyType: config.resourceType === "ShopPolicy" && selectedItem?.type ? selectedItem.type : undefined,
  });
  if (isPrimary) {
    // The same client-side mirror of the server's purge as handleSave.
    if (changed && field?.translationKey) {
      deletedTranslationKeysRef.current.add(field.translationKey);
    }
    // resolve() reads this first for the primary locale — this field only.
    savedPrimaryValuesRef.current[selectedItemId] = {
      ...(savedPrimaryValuesRef.current[selectedItemId] ?? {}),
      [fieldKey]: value,
    };
  }
  partialSaveRef.current = { locale, marketId, values: { [fieldKey]: value }, altIndices: [] };
  savedLocaleRef.current = locale;
  savedMarketIdRef.current = marketId;
  savedItemIdRef.current = selectedItemId;
  isSavePendingRef.current = true;
  if (opts.fromTranslate) isSaveFromTranslateRef.current = true;
  setIsSaving(true);
  safeSubmit(form, { method: "POST" });
  return true;
};

/** An AI result that arrived while its own save is blocked: into the field as
 *  a plain draft through the typing path (dirty, save bar up, nothing staged). */
const applyAsDraft = (fieldKey: string, value: string) => {
  handleValueChange(fieldKey, value);
  clearFieldSuggestion(suggestionScope, fieldKey);
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

    // The same invalidation for the ALT texts of the images whose primary alt
    // changed: the server deletes their foreign translations (the global layer
    // AND the market overrides), and every place the editor reads them from
    // would otherwise keep serving the deleted value for the rest of the
    // session, with a save from that view writing it straight back.
    //
    // Unconditional, exactly like `deletedTranslationKeysRef` above: the client
    // does not know the merchant's purge switch, so with the deletion switched
    // OFF this shows the alt texts as gone for the rest of the session while
    // Shopify still serves them. A deliberate match with the field path rather
    // than an oversight — one reload corrects it, and the two halves of one
    // save must not disagree about what the server did.
    if (changedAltTextIndices.length > 0) {
      for (const key of Object.keys(localAltTextOverlayRef.current)) {
        // EVERY foreign layer goes -- the global one and the market overlays
        // (`buildLocaleKey` writes a market key as `locale@@market`): the
        // server's invalidation removes the market overrides of these images
        // as well (purgeMarketOverrides), so keeping them here would render a
        // deleted market alt and write it straight back on the next save.
        if (key === primaryLocale) continue;
        for (const index of changedAltTextIndices) {
          delete localAltTextOverlayRef.current[key][index];
        }
      }
      const images: Array<{ altTextTranslations?: Array<{ locale: string; marketId?: string }> }> =
        selectedItem.images && selectedItem.images.length > 0
          ? selectedItem.images
          : selectedItem.featuredImage
            ? [selectedItem.featuredImage]
            : [];
      for (const index of changedAltTextIndices) {
        const img = images[index];
        if (!img?.altTextTranslations) continue;
        img.altTextTranslations = img.altTextTranslations.filter(
          (t: { locale: string; marketId?: string }) => t.locale === primaryLocale,
        );
      }
    }

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

  // Discard returns to the BASELINE -- the exact values change detection
  // compares against (`useEditorChangeDetection`), installed by every load and
  // every confirmed save. Re-deriving the values here from the raw item (the old
  // body below) was a second, narrower resolve chain: it knew no market layer,
  // no handle / SEO-title fallback, no local overlay and no deleted key. In a
  // market view the market overrides came back as their GLOBAL wording, which
  // differs from the baseline -- so the "discarded" editor was dirty again and
  // the save bar never closed. That is what the leave dialog's discard after a
  // MARKET switch produced (it lands on the new market's view); a language switch
  // happened to resolve both ways to the same values. Same for the alt texts:
  // their baseline is `originalAltTexts`.
  // An unsaved CLEAR of this view is discarded with it: its locale marks go,
  // or a later re-read would keep showing the field empty while Shopify still
  // serves the translation. Not while a save of this view is out -- a sent
  // clear's marks belong to its answer.
  if (currentLanguage !== primaryLocale) {
    dropLocaleMarks(deletedTranslationKeysRef.current, currentLanguage, selectedMarketId, deletedMarksOfSavesOut?.());
  }
  const baseline = baselineValuesRef.current;
  if (Object.keys(baseline).length > 0) {
    setEditableValues({ ...baseline });
    setImageAltTexts({ ...originalAltTextsRef.current });
    // A field typed over an inherited value lost its fallback flag; back at
    // the baseline it is inherited again. (Alt texts keep theirs: nothing
    // clears `fallbackAltTextIndices` but a load.)
    const restoredFallbacks = fallbackFieldsAfterDiscard(loadedFallbackRef?.current ?? null, baseline);
    setFallbackFields(restoredFallbacks);
    fallbackFieldsRef.current = new Set(restoredFallbacks);
    return;
  }

  // No baseline yet (nothing loaded): the older derivation from the item.
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
  // The scope the merchant ASKED from. A suggestion that arrives after they
  // moved on belongs here, not to wherever they are now — and this is what
  // makes it wait for them instead of being dropped.
  const requestScope: SuggestionScope = { ...suggestionScope, resourceId: requestItemId };
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
      setFieldSuggestion(requestScope, fieldKey, result.generatedContent as string);
      // The WARNING is only worth showing while the merchant is still looking
      // at the item it belongs to; the suggestion above is kept either way.
      if (selectedItemIdRef.current !== requestItemId) return;
      // Stuffing guard (PLAN_KEYWORDS_EXPANSION.md §3.2): the server retried
      // once and the output STILL over-uses a tracked keyword — warn so the
      // merchant reviews the suggestion before accepting it. This raw-fetch
      // callback is the REAL generate path (submitAIAction), not the legacy
      // fetcher branch in useUnifiedContentEditor.
      if ((result as { keywordStuffingWarning?: boolean }).keywordStuffingWarning) {
        showInfoBox(
          (t.seo as { keywordStuffingWarning?: string } | undefined)?.keywordStuffingWarning ||
            "The generated text still over-uses a tracked keyword — review it before accepting.",
          "warning"
        );
      }
    }
  );
};

const handleFormatAI = (fieldKey: string) => {
  if (!selectedItemId || !selectedItem) return;

  const requestItemId = selectedItemId;
  const requestScope: SuggestionScope = { ...suggestionScope, resourceId: requestItemId };
  const currentValue = editableValues[fieldKey] || "";
  if (!currentValue) {
    showInfoBox(
      t.common?.noContentToFormat || "No content available to format",
      "warning"
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
      setFieldSuggestion(requestScope, fieldKey, result.generatedContent as string);
      if (selectedItemIdRef.current !== requestItemId) return;
      // Formatting may now work a missing target keyword in, so it can overshoot
      // the same way generation can — and warns the same way.
      if ((result as { keywordStuffingWarning?: boolean }).keywordStuffingWarning) {
        showInfoBox(
          (t.seo as { keywordStuffingWarning?: string } | undefined)?.keywordStuffingWarning ||
            "The formatted text still over-uses a tracked keyword — review it before accepting.",
          "warning"
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
  const requestScope: SuggestionScope = { ...suggestionScope, resourceId: requestItemId };

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
      "warning"
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
          if (result.skipped) return;
          setFieldSuggestion(requestScope, fieldKey, result.value as string);
          // The run's own bookkeeping (the summary box at the end) only makes
          // sense while the merchant is still on the item it summarises.
          if (selectedItemIdRef.current !== requestItemId) return;
          changed += 1;
          if ((result as { keywordStuffingWarning?: boolean }).keywordStuffingWarning) stuffing = true;
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
      "info"
    );
    return;
  }
  showInfoBox(
    (seoStrings?.insertKeywordsDone || "Keywords worked into {count} field(s) — review and accept them.")
      .replace("{count}", String(changed)),
    stuffing ? "warning" : "success"
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
      "warning"
    );
    return;
  }

  const targetLocale = currentLanguage;
  // Its result is saved at once: while a run writes into this language the
  // AI request is not even started.
  if (refuseOwnSave?.(requestItemId, targetLocale, { notStarted: true })) return;

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
      // The merchant may have switched language while the AI worked. The
      // translation still belongs to `targetLocale` and is still saved there,
      // but nothing of it may land in the locale now on screen.
      const viewing =
        currentLanguageRef.current === targetLocale && selectedMarketIdRef.current === selectedMarketId;
      // A run into this language started while the AI worked: the result is a
      // draft (where it is still on screen), nothing is staged or saved.
      // Off screen (the merchant moved on) the result is simply dropped,
      // without a message about a draft that does not exist.
      if (viewing ? refuseOwnSave?.(requestItemId, targetLocale) : isOwnSaveBlocked?.(requestItemId, targetLocale)) {
        if (viewing && translatedValue) handleValueChange(fieldKey, translatedValue);
        return;
      }
      if (field.translationKey) {
        // Delegate ref mutations to transition method
        const transResult = dataLoader.onTranslateFieldComplete(
          fieldKey,
          field.translationKey,
          translatedValue,
          targetLocale,
          editableValuesRef.current,
          // The market the save below persists under — the one at click time.
          selectedMarketId,
          viewing
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
        // ONLY the translated field. Other fields may carry the merchant's
        // unsaved input, and saving it here would be an autosave they never
        // asked for; they stay dirty for their own Save instead.
        if (translatedValue && translatedValue.trim()) {
          formDataObj[fieldKey] = translatedValue;
        }
        partialSaveRef.current = { locale: targetLocale, marketId: selectedMarketId, values: { [fieldKey]: translatedValue } };

        savedLocaleRef.current = targetLocale;
        savedMarketIdRef.current = selectedMarketId;
        // Same claim as handleSave/handleCopyFieldToAllLocales: without it the
        // save-response effects fail their `isSavedItemCurrent` guard and
        // early-return, so this translation never reaches onSaveComplete's
        // overlay write or the tail revalidation — and `isSaveFromTranslateRef`
        // is never reset either (its reset sits past that return), which
        // swallows the "changes saved" box of the NEXT ordinary save.
        savedItemIdRef.current = requestItemId;
        isSavePendingRef.current = true;
        isSaveFromTranslateRef.current = true;
        safeSubmit(formDataObj, { method: "POST" });

        // Reset the baseline for the just-saved field only, so it isn't re-sent
        // on the next save and nothing else is marked saved that was not.
        if (viewing) {
          originalLoadedValuesRef.current = { ...originalLoadedValuesRef.current, [fieldKey]: translatedValue };
        }
      }

      // Show explicit success toast for the translation
      const fieldLabel = resolveFieldLabel(fieldKey);
      showInfoBox(
        t.common?.fieldTranslatedAndSaved
          ?.replace("{fieldType}", fieldLabel)
          || `${fieldLabel} translated and saved successfully`,
        "success"
      );

      // For templates: Update original values so templateHasFieldChanges becomes false
      if (isThemeContentType(config.contentType) && viewing) {
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
  // It writes EVERY language: refused (an app-started run silently) while
  // any run of the item is out, before anything is staged or requested.
  if (auto) {
    if (isOwnSaveBlocked?.(selectedItemId, primaryLocale)) {
      // Not silent: the merchant never pressed anything, so without a word
      // the product type just stays untranslated and nobody learns why.
      showInfoBox(
        String(t.common?.productTypeTranslateSkippedWhileBusy || "The product type was not translated into the other languages because a translation or save of this item was still running. You can start it later with the field\u2019s translate-to-all-languages button."),
        "info",
      );
      return;
    }
  } else if (refuseOwnSave?.(selectedItemId, primaryLocale, { notStarted: true })) return;
  const requestItemId = selectedItemId;

  // Filter out primary locale and disabled languages
  const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
  if (targetLocales.length === 0) {
    if (!auto) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning"
      );
    }
    return;
  }

  const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
  if (!field) return;

  // Backstop for the disabled button: the source is the SAVED primary text,
  // and the draft on screen would purge these translations when it is saved.
  if (!auto && isPrimaryFieldUnsaved(fieldKey)) {
    refuseUnsavedSource();
    return;
  }

  const sourceText =
    savedPrimaryValuesRef.current[selectedItemId]?.[fieldKey] ||
    getItemFieldValue(selectedItem, fieldKey, primaryLocale, config);
  if (!sourceText) {
    if (!auto) {
      showInfoBox(
        t.content?.noSourceText || "Kein Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning"
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
          currentLanguageRef.current
        );

        // The locale on screen NOW, not the one at click time: after a switch
        // mid-request the captured one would write another language's text into
        // this view as an unsaved edit, which the next save then stores there.
        const viewingLocale = currentLanguageRef.current;
        if (translations[viewingLocale]) {
          const value = translations[viewingLocale];
          setEditableValues(prev => ({ ...prev, [fieldKey]: value }));
          // Already saved server-side, so it is the baseline, not an edit.
          originalLoadedValuesRef.current = { ...originalLoadedValuesRef.current, [fieldKey]: value };
          baselineValuesRef.current = { ...baselineValuesRef.current, [fieldKey]: value };
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
          const counts2 = partialLocaleCounts(translations, failedFieldLocales2);
          messages.push(
            String(t.content?.translatePartialLocales || "Translation partially completed: {successCount}/{totalCount} language(s) succeeded. Language(s) {failedLocales} failed.")
              .replace("{successCount}", String(counts2.succeeded))
              .replace("{totalCount}", String(counts2.total))
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
          "warning"
        );
      } else {
        const fieldLabel2 = resolveFieldLabel(fieldKey);
        const toastMsg = t.common?.fieldTranslatedToLanguages
            ?.replace("{fieldType}", fieldLabel2)
            .replace("{count}", String(translationCount))
            || `${fieldLabel2} translated to ${translationCount} language(s)`;
        showInfoBox(toastMsg, "success");
      }

      // For templates: Update original value so hasChanges becomes false after translation
      if (isThemeContentType(config.contentType) && translations[currentLanguageRef.current]) {
        originalTemplateValuesRef.current = {
          ...originalTemplateValuesRef.current,
          [fieldKey]: translations[currentLanguageRef.current]
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
            "warning"
          );
        }
      : undefined,
    auto ? { suppressErrorBox: true } : undefined,
  );
};

const handleTranslateAll = (): boolean | void => {
  if (!selectedItemId || !selectedItem) return;
  // Guard against double-click: if translateAll is already running, ignore
  if (isOperationActive(selectedItemId, "__translateAll__")) return;
  if (refuseTranslateRun?.(selectedItemId, "*")) return false;

  // Its source is the SAVED primary text: with a primary draft open, the
  // later Save would purge what this run writes into every language.
  if (hasUnsavedTranslateAllSource()) {
    refuseUnsavedSource();
    return;
  }

  const requestItemId = selectedItemId;

  // Filter out primary locale and disabled languages
  const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
  if (targetLocales.length === 0) {
    showInfoBox(
      t.common?.noTargetLanguagesSelected || "No target languages selected",
      "warning"
    );
    return;
  }

  // Mark in global store so spinner persists across navigation
  markOperationActive(selectedItemId, "__translateAll__", "translateAll");

  const formDataObj: Record<string, string> = {
    action: "translateAll",
    itemId: selectedItemId,
    targetLocales: JSON.stringify(targetLocales),
    // The SOURCE language of everything below, under the name every AI path in
    // this app already reads it by — including the THEME content action, which
    // this same handler posts to for `/app/templates` and its siblings.
    //
    // It used to be absent, and both receivers then defaulted it to "en" while
    // both batch prompts NAME it ("Translate these fields from English to: …"):
    // on a German shop the model was told the source was English — and for `en`
    // as a TARGET that reads as translating English into English, which the
    // batch helper's source-echo guard deliberately does not catch (a cell
    // equal to its source is legitimate when the two languages are the same).
    // The untranslated German could then be echo-confirmed and mirrored as the
    // English translation.
    primaryLocale,
  };

  // Add all field values from primary locale — the TRANSLATABLE ones only.
  // The merchandising attributes are left out: `status`, `vendor`, `tags` and
  // their siblings hold ONE value per item, have no Shopify translation key,
  // and sending them meant paying for an AI translation of "ACTIVE" that the
  // save then refused and reported to the merchant as a failed field. The
  // server filters on the canonical key map for the same reason; this keeps
  // them off the wire and out of the prompt.
  //
  // Asked in the POSITIVE (`isTranslatableFieldDefinition`) rather than by
  // excluding `isAttributeField`, because the attributes are not the only field
  // here that has no Shopify content key: an image GALLERY carries
  // `translationKey: "images"`, which is not one either, and its alt-texts are
  // translated by their own action further down this function.
  effectiveFieldDefinitions.forEach((field) => {
    if (!isTranslatableFieldDefinition(field)) return;
    const value = getItemFieldValue(selectedItem, field.key, primaryLocale, config);
    if (value) {
      formDataObj[field.key] = value;
    }
  });

  if (submitTranslateRun) submitTranslateRun(formDataObj, requestItemId);
  else safeSubmit(formDataObj, { method: "POST" });

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
              "warning"
            );
          } else {
            showInfoBox(
              String(t.content?.altTextTranslateAllSuccess || "Alt-texts for {totalCount} image(s) translated to {languageCount} language(s)")
                .replace("{totalCount}", String(imageCount))
                .replace("{languageCount}", String(translatedCount)),
              "success"
            );
          }
          // Stage every saved (image, locale) under the locale it was written
          // for, and show the one on screen NOW — not the one the button was
          // pressed in (always the primary): a merchant who switched language
          // while the run worked never saw these arrive.
          const translatedForCurrentLocale = applyAltTranslateAllAnswer(
            localAltTextOverlayRef.current,
            result.translatedResults as Record<string, Record<string, string>> | undefined,
            failedImages,
            {
              locale: currentLanguageRef.current,
              marketId: selectedMarketIdRef.current,
              primaryLocale,
              current: imageAltTextsRef.current,
              original: originalAltTextsRef.current,
            },
          );
          if (Object.keys(translatedForCurrentLocale).length > 0) {
            setImageAltTexts(prev => ({ ...prev, ...translatedForCurrentLocale }));
            // Only the translated indices are saved; another image's typed
            // alt stays a draft against its own baseline.
            setOriginalAltTexts(prev => ({ ...prev, ...translatedForCurrentLocale }));
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

  // A resource-backed rubric's main language is read-only: refuse BEFORE any
  // state moves, or the refused accept would leave a dirty draft behind that
  // no save can ever write (and the suggestion would be gone with it).
  if (currentLanguage === primaryLocale && isResourceBackedThemeContent(config.contentType)) {
    showInfoBox(
      String(t.content?.primaryReadOnlyHint
        || "This field can't be edited in the main language here — manage the original in your Shopify admin. You can still translate it into other languages."),
      "warning"
    );
    return;
  }

  // A run blocks the save this accept would make: the suggestion becomes a
  // plain draft and nothing else moves.
  {
    const acceptField = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
    const wouldSave = currentLanguage === primaryLocale || !!acceptField?.translationKey;
    if (wouldSave && refuseOwnSave?.(selectedItemId, currentLanguage)) {
      applyAsDraft(fieldKey, suggestion);
      return;
    }
  }

  // Force isLoadingData to false to ensure change detection works
  setIsLoadingData(false);

  // If this field was a fallback, remove it since user accepted an AI value
  if (fallbackFields.has(fieldKey)) {
    setFallbackFields((prev) => {
      const newSet = new Set(prev);
      newSet.delete(fieldKey);
      return newSet;
    });
    // At once, not on the next render: the save below is answered against it.
    fallbackFieldsRef.current.delete(fieldKey);
  }

  // Update the UI state
  setEditableValues((prev) => ({ ...prev, [fieldKey]: suggestion }));

  clearFieldSuggestion(suggestionScope, fieldKey);

  // Accepting SAVES the field at once — this field only (owner's rule,
  // 2026-10-02). A foreign field without a translation key has nowhere to be
  // saved as a translation and stays a draft, as before.
  const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
  if (currentLanguage !== primaryLocale && !field?.translationKey) return;
  submitOwnFieldSave(fieldKey, suggestion);
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
      "warning"
    );
    return;
  }

  // It writes the primary text and every language (a foreign accept writes
  // the primary too): ANY run of the item blocks it, before anything is armed.
  if (refuseOwnSave?.(selectedItemId, primaryLocale)) {
    applyAsDraft(fieldKey, suggestion);
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

  clearFieldSuggestion(suggestionScope, fieldKey);

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
    // ONLY the accepted field: other fields may hold unsaved input, which
    // stays dirty for its own Save rather than riding along here.
    foreignForm[fieldKey] = suggestion;
    partialSaveRef.current = { locale: L, marketId: "", values: { [fieldKey]: suggestion } };
    savedLocaleRef.current = L;
    savedMarketIdRef.current = selectedMarketId;
    savedItemIdRef.current = requestItemId;
    isSavePendingRef.current = true;
    isSaveFromTranslateRef.current = true;
    safeSubmit(foreignForm, { method: "POST" });
    originalLoadedValuesRef.current = { ...originalLoadedValuesRef.current, [fieldKey]: suggestion };

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
          "info"
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
        // A run of this item started while the AI worked: the PRIMARY base
        // save below is not made and nothing is staged for it (the server
        // already stored what it translated; a reload shows it).
        // The foreign text AND the other languages WERE saved (the request
        // ran with skipSaveLocales=[primary]); only the primary save is
        // skipped -- said exactly that way.
        if (isOwnSaveBlocked?.(requestItemId, primaryLocale)) {
          sayPrimaryTextSkipped?.();
          setIsAcceptAndTranslateFlow(false);
          if (revalidatorRef.current.state === 'idle') {
            try { revalidatorRef.current.revalidate(); } catch {}
          }
          return;
        }
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
          // PARTIAL, carrying no foreign value at all: this writes the PRIMARY
          // field, so nothing of the L view is saved by it — handled as a full
          // save it overlaid every field on screen as an L translation and
          // marked unsaved input clean.
          partialSaveRef.current = { locale: L, marketId: selectedMarketId, values: {} };
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
            "warning"
          );
        } else {
          showInfoBox(
            t.common?.fieldTranslatedToLanguages
              ?.replace("{fieldType}", fieldLabel)
              .replace("{count}", String(Object.keys(othersTranslations).length + (primaryTranslated ? 1 : 0)))
              || `${fieldLabel} translated`,
            "success"
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
      "warning"
    );
    setIsAcceptAndTranslateFlow(false);
    // No translations needed, just save the primary text directly — this
    // field only; other unsaved fields stay drafts.
    submitOwnFieldSave(fieldKey, suggestion);
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
    // This field only: every other field may hold unsaved input and must
    // stay dirty against the baseline it had.
    baselineValuesRef.current = { ...baselineValuesRef.current, [fieldKey]: suggestion };
    setBaselineVersion((v) => v + 1);
    originalTemplateValuesRef.current = { ...originalTemplateValuesRef.current, [fieldKey]: suggestion };
    setTemplateValuesVersion((v) => v + 1);
  }

  // Step 2: Save the primary text first — THIS field only, and without
  // `changedFields` (the flow is about to write its translations itself).
  // After save completes, the useEffect will trigger the translation.
  debugLog.acceptAndTranslate(' Saving primary text first, then will translate');
  submitOwnFieldSave(fieldKey, suggestion, { markChanged: false });
};

const handleRejectSuggestion = useCallback((fieldKey: string) => {
  clearFieldSuggestion(suggestionScope, fieldKey);
}, [suggestionScope]);

/**
 * A view switch while an AI/copy button's own save is on its way is REFUSED,
 * never queued: that save is kept out of `hasChanges`, so no save bar shows
 * and no confirmation could ask, and its answer must land on the view it was
 * made for. The merchant gets a short message and switches again once it has
 * landed. Deterministic on purpose -- no waiting, no tokens, no timers.
 */
const refuseSwitchDuringOwnSave = (): boolean => {
  if (!isOwnSaveInFlight?.()) return false;
  showInfoBox(
    String(t.common?.switchWhileSaving || "Still saving – please wait a moment and then switch again."),
    "info",
  );
  return true;
};

const handleLanguageChange = async (locale: string) => {
  if (refuseSwitchDuringOwnSave()) return;
  if (hasChanges || isSavingCurrentItem) {
    await confirmNavigation();
  }
  // A clear the merchant just left behind unsaved is discarded with the view:
  // its marks would otherwise keep that field empty there for the session.
  if (currentLanguage !== primaryLocale) {
    dropLocaleMarks(deletedTranslationKeysRef.current, currentLanguage, selectedMarketId, deletedMarksOfSavesOut?.());
  }
  setCurrentLanguage(locale);
  // This click is the only writer of the remembered working language: the
  // editor unmounts on every main-nav navigation, and coming back in the
  // primary locale threw away the language the merchant was editing in — and
  // with it the view onto anything stored per locale, a pending AI suggestion
  // included. It sits directly beside the state change and behind the same
  // unsaved-changes confirmation, so what is remembered is exactly the switch
  // that happened — never one the merchant backed out of.
  writeLastContentLocale(locale);
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
  if (refuseSwitchDuringOwnSave()) return;
  // Market switch behaves like a locale switch "light": no server round-trip, but
  // unsaved edits would be lost on re-resolve, so guard them the same way.
  if (hasChanges || isSavingCurrentItem) {
    await confirmNavigation();
  }
  if (currentLanguage !== primaryLocale) {
    dropLocaleMarks(deletedTranslationKeysRef.current, currentLanguage, selectedMarketId, deletedMarksOfSavesOut?.());
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
  if (refuseSwitchDuringOwnSave()) return;
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
      // THIS locale's mark: another language's value of the same key is untouched.
      deletedTranslationKeysRef.current.add(buildLocaleDeletedKey(tKey, selectedMarketId, currentLanguage));
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
      deletedTranslationKeysRef.current.add(buildLocaleDeletedKey(tKey, "", currentLanguage));
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
  clearSuggestionsForScope(suggestionScope);

  // Close modal
  setIsClearAllModalOpen(false);
};

const handleClearAllCancel = useCallback(() => {
  setIsClearAllModalOpen(false);
}, []);

// A translation INTO this language is still being written: Shopify would get
// the clear's removals and the run's registrations in an order nobody controls,
// and its answer would put the values back on screen. Refused with a message,
// like a switch during an own save -- a run for ANOTHER language does not
// refuse (its answer is staged under its own language).
const refuseClearWhileTranslatingHere = (): boolean => {
  if (!selectedItemId || currentLanguage === primaryLocale) return false;
  if (!isTranslateIntoLocaleRunning(selectedItemId, currentLanguage)) return false;
  showInfoBox(
    String(t.common?.clearWhileTranslating || "A translation into this language is still running \u2013 please wait until it has finished and then clear."),
    "info",
  );
  return true;
};

const handleClearAllForLocaleClick = () => {
  if (refuseClearWhileTranslatingHere()) return;
  setIsClearAllModalOpen(true);
};

const handleClearAllForLocaleConfirm = (): boolean | void => {
  if (!selectedItemId || !selectedItem || currentLanguage === primaryLocale) return false;
  if (refuseClearWhileTranslatingHere()) {
    setIsClearAllModalOpen(false);
    return false;
  }

  // Force isLoadingData to false to ensure change detection works
  setIsLoadingData(false);

  // Prevent retry mechanism from restoring old values after intentional clear
  initialLoadSuccessfulRef.current = true;
  retryCountRef.current = 0;

  // Clear all TRANSLATED field values for the current foreign language. The
  // merchandising attributes (status, vendor, tags, ...) and the gallery hold
  // ONE value per item and have no translation: blanking them showed a status
  // select without its value, and the field then read as changed for good.
  // A per-language theme IMAGE is a stored foreign value too (it is not
  // AI-translatable, but it is translated): clear-all removes it as well.
  const translatableFields = effectiveFieldDefinitions.filter(
    (field) => isTranslatableFieldDefinition(field) || (field.type === "themeImage" && !!field.translationKey),
  );
  const clearedValues: Record<string, string> = { ...editableValuesRef.current };
  translatableFields.forEach((field) => {
    clearedValues[field.key] = "";
  });
  setEditableValues(clearedValues);

  // Update validation refs so isFieldTranslated / hasLocaleMissingTranslations
  // reflect the cleared state immediately (yellow highlight + button blinking).
  // Market-fold the keys so a market-scoped "clear all for this locale" only
  // blanks the market overrides and lets resolve() fall back to the global values
  // (mirrors the market-scoped save above and handleClearField).
  const clearLocaleKey = buildLocaleKey(currentLanguage, selectedMarketId);
  translatableFields.forEach((field) => {
    const tKey = field.translationKey;
    if (localTranslationsRef.current[tKey]) {
      delete localTranslationsRef.current[tKey][clearLocaleKey];
    }
    // Mark as deleted so resolve() returns empty even if item.translations has
    // old data -- for THIS locale only. A layer-wide mark emptied every other
    // language until the save answered, and another language's late
    // "translate all" answer (which drops the marks of what it answered)
    // brought this language's old values back while their removal was on its
    // way.
    deletedTranslationKeysRef.current.add(buildLocaleDeletedKey(tKey, selectedMarketId, currentLanguage));
  });

  // The images whose foreign alt this clear reaches. A collection and an
  // article load with `images: []` and their ONE image in `featuredImage`
  // (translation key `image_alt_text` on the parent), so walking `images`
  // alone left that alt standing. Only in the GLOBAL layer: the featured
  // alt's translation is stored and removed globally (there is no market
  // layer for it), so a clear inside a market must not reach it -- it would
  // delete the global translation the market inherits. Products unchanged.
  const altImages: ContentImage[] =
    selectedItem.images && selectedItem.images.length > 0
      ? selectedItem.images
      : (config.resourceType === "Collection" || config.resourceType === "Article") &&
          !selectedMarketId &&
          selectedItem.featuredImage
        ? [selectedItem.featuredImage]
        : [];

  // Clear image alt texts - set each to "" explicitly so the UI doesn't fall back to original image.altText
  const clearedAltTexts: Record<number, string> = {};
  if (altImages.length > 0) {
    altImages.forEach((_: ContentImage, index: number) => {
      clearedAltTexts[index] = "";
    });
    setImageAltTexts(clearedAltTexts);
    setOriginalAltTexts({});
  }
  // A staged alt translation of THIS layer (a translate answer that landed
  // earlier) must not win over the clear on the next language switch -- the
  // alt load reads the overlay before the item. Other locales' entries stay.
  delete localAltTextOverlayRef.current[clearLocaleKey];
  clearSuggestionsForScope(suggestionScope);

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
  translatableFields.forEach((field) => {
    if (fallbackFieldsRef.current.has(field.key)) return; // no translation to delete
    const originalValue = originalLoadedValuesRef.current[field.key] || "";
    if (originalValue) {
      formDataObj[field.key] = "";
    }
  });

  // Send alt-texts that had translations
  const altTextsToDelete: Record<number, string> = {};
  let hasAltTextsToDelete = false;
  if (altImages.length > 0) {
    altImages.forEach((img: ContentImage, index: number) => {
      // Only the layer being cleared (the selected market's, else global).
      const hasTranslation = img.altTextTranslations?.some(
        (t: { locale: string; marketId?: string }) =>
          t.locale === currentLanguage && (t.marketId ?? "") === (selectedMarketId || "")
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

  altImages.forEach((img: ContentImage) => {
    if (img.altTextTranslations) {
      img.altTextTranslations = img.altTextTranslations.filter(
        (t: { locale: string; marketId?: string }) =>
          !(t.locale === currentLanguage && (t.marketId ?? "") === (selectedMarketId || ""))
      );
    }
  });

  // Update originalLoadedValues so change detection reflects the cleared state
  originalLoadedValuesRef.current = { ...clearedValues };

  // Submit save and set tracking refs

  savedLocaleRef.current = currentLanguage;
  savedMarketIdRef.current = selectedMarketId;
  // Track WHICH item is being saved, exactly like handleSave and the copy
  // paths. Without it savedItemIdRef stays null (or holds a previous item) and
  // BOTH save-response effects fail their `isSavedItemCurrent` guard and
  // early-return: onSaveComplete never runs, and — the visible half — the
  // REVALIDATION at the end of the second one never fires. The loader data
  // therefore keeps the translations this save just deleted, so as soon as
  // anything re-resolves the fields (an item switch, which clears
  // deletedTranslationKeysRef, or a locale switch) the cleared values come
  // straight back and only a full page reload shows the real state.
  savedItemIdRef.current = selectedItemId;
  isSavePendingRef.current = true;
  setIsSaving(true); // Drive the spinner — same reason as handleSave
  safeSubmit(formDataObj, { method: "POST" });
};

const handleTranslateAllForLocale = (): boolean | void => {
  if (!selectedItemId || !selectedItem || currentLanguage === primaryLocale) return;
  // Guard against double-click: if translateAllForLocale is already running for this locale, ignore
  if (isOperationActive(selectedItemId, `__translateAllForLocale__${currentLanguage}`)) return;
  // A save of this language (a "clear all", say) is still on its way: on its
  // own request the run could land BEFORE its removals and be wiped by them,
  // while the screen shows the AI text. Refused, never queued.
  if (refuseTranslateRun?.(selectedItemId, currentLanguage)) return false;

  const requestItemId = selectedItemId;
  const requestedLocale = currentLanguage;

  // Mark in global store so spinner persists across navigation
  markOperationActive(selectedItemId, `__translateAllForLocale__${currentLanguage}`, "translateAllForLocale", currentLanguage);

  const formDataObj: Record<string, string> = {
    action: "translateAllForLocale",
    itemId: selectedItemId,
    targetLocale: currentLanguage,
    // See handleTranslateAll — both receivers default this to "en" and the
    // prompts name it, so it has to be the shop's real primary locale.
    primaryLocale,
  };

  // Add all field values from primary locale — the TRANSLATABLE ones only.
  // The merchandising attributes are left out: `status`, `vendor`, `tags` and
  // their siblings hold ONE value per item, have no Shopify translation key,
  // and sending them meant paying for an AI translation of "ACTIVE" that the
  // save then refused and reported to the merchant as a failed field. The
  // server filters on the canonical key map for the same reason; this keeps
  // them off the wire and out of the prompt.
  //
  // Asked in the POSITIVE (`isTranslatableFieldDefinition`) rather than by
  // excluding `isAttributeField`, because the attributes are not the only field
  // here that has no Shopify content key: an image GALLERY carries
  // `translationKey: "images"`, which is not one either, and its alt-texts are
  // translated by their own action further down this function.
  effectiveFieldDefinitions.forEach((field) => {
    if (!isTranslatableFieldDefinition(field)) return;
    const value = getItemFieldValue(selectedItem, field.key, primaryLocale, config);
    if (value) {
      formDataObj[field.key] = value;
    }
  });

  if (submitTranslateRun) submitTranslateRun(formDataObj, requestItemId);
  else safeSubmit(formDataObj, { method: "POST" });

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

          // Only accept translations that were successfully saved to Shopify.
          // Staged under the locale they were written for, and shown only
          // while that locale is on screen in the global view (never over a
          // typed draft): the merchant may have switched to another language
          // meanwhile, whose alt fields this answer has nothing to do with.
          if (result.translatedAltTexts) {
            const byIndex = forLocaleAltResults(
              result.translatedAltTexts as Record<string, string>,
              requestedLocale,
            );
            const visible = applyAltTranslateAllAnswer(
              localAltTextOverlayRef.current,
              byIndex,
              failedImages,
              {
                locale: currentLanguageRef.current,
                marketId: selectedMarketIdRef.current,
                primaryLocale,
                current: imageAltTextsRef.current,
                original: originalAltTextsRef.current,
              },
            );
            if (Object.keys(visible).length > 0) {
              setImageAltTexts(prev => ({ ...prev, ...visible }));
              // Only the translated indices are saved; another image's typed
              // alt stays a draft against its own baseline.
              setOriginalAltTexts(prev => ({ ...prev, ...visible }));
            }
            // The server already saved to Shopify and the DB; the item catches
            // up (and the language markers move) with a reload.
            if (revalidatorRef.current.state === 'idle') {
              try { revalidatorRef.current.revalidate(); } catch {}
            }
          }

          if (failedImages.length > 0) {
            const failedList = failedImages.map((i: number) => i + 1).join(", ");
            showInfoBox(
              String(t.content?.altTextTranslatePartialImages || "Alt-texts partially saved. Image(s) {failedImages} could not be saved to Shopify. Please sync the product again.")
                .replace("{failedImages}", failedList),
              "warning"
            );
          }
        }
      );
    }
  }
};

const handleCopyField = (fieldKey: string): void => {
  if (!selectedItemId || !selectedItem) return;
  if (refuseOwnSave?.(selectedItemId, currentLanguage, { notStarted: true })) return;
  const field = effectiveFieldDefinitions.find(f => f.key === fieldKey);
  if (!field) return;
  const primaryValue = getItemFieldValue(selectedItem, fieldKey, primaryLocale, config);
  if (!primaryValue) return;

  // Remember what is about to be overwritten (see CopyFieldRollback).
  {
    const copyMarketId = selectedMarketIdRef.current;
    const copyLocaleKey = buildLocaleKey(currentLanguage, copyMarketId);
    const copyDeletedKey = buildDeletedKey(field.translationKey, copyMarketId);
    const copyLocaleDeletedKey = buildLocaleDeletedKey(field.translationKey, copyMarketId, currentLanguage);
    copyFieldRollbackRef.current = {
      itemId: selectedItemId,
      fieldKey,
      translationKey: field.translationKey,
      localeKey: copyLocaleKey,
      deletedKey: copyDeletedKey,
      localeDeletedKey: copyLocaleDeletedKey,
      hadLocaleDeletedMarker: deletedTranslationKeysRef.current.has(copyLocaleDeletedKey),
      locale: currentLanguage,
      marketId: copyMarketId,
      value: primaryValue,
      prevOverlay: localTranslationsRef.current[field.translationKey]?.[copyLocaleKey],
      hadDeletedMarker: deletedTranslationKeysRef.current.has(copyDeletedKey),
      prevBaseline: baselineValuesRef.current[fieldKey],
      prevOriginalLoaded: originalLoadedValuesRef.current[fieldKey],
      prevEditable: editableValuesRef.current[fieldKey],
      wasFallback: fallbackFieldsRef.current.has(fieldKey),
    };
  }

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

  markOperationActive(selectedItemId, fieldKey, "copy");
  pendingCopyFieldKeyRef.current = fieldKey;
  pendingCopyFieldItemIdRef.current = selectedItemId;

  // ONLY the copied field, under the selected market. Other fields may hold
  // unsaved input, which stays a draft for its own Save. (submitOwnFieldSave
  // claims the item, so the save-response handler's `isSavedItemCurrent`
  // guard passes and the copy's spinner is cleared.)
  submitOwnFieldSave(fieldKey, primaryValue, { fromTranslate: true });
  originalLoadedValuesRef.current = { ...originalLoadedValuesRef.current, [fieldKey]: primaryValue };

  // Success/error feedback is deferred to the save-response handler so the
  // InfoBox reflects the actual Shopify result (see pendingCopyFieldKeyRef in
  // useUnifiedContentEditor.ts), not an optimistic guess.
};

const discardCopyFieldRecord = (): void => {
  copyFieldRollbackRef.current = null;
};

const rollbackCopyField = (opts?: { keepVisible?: boolean }): void => {
  const rec = copyFieldRollbackRef.current;
  copyFieldRollbackRef.current = null;
  if (!rec) return;

  // The overlay and the "deleted" marker are data, keyed by item-independent
  // translation key: undo only OUR write (a later edit under the key stays).
  const overlay = localTranslationsRef.current[rec.translationKey];
  if (overlay && overlay[rec.localeKey] === rec.value) {
    if (rec.prevOverlay === undefined) delete overlay[rec.localeKey];
    else overlay[rec.localeKey] = rec.prevOverlay;
  }
  if (rec.hadDeletedMarker) deletedTranslationKeysRef.current.add(rec.deletedKey);
  if (rec.hadLocaleDeletedMarker) deletedTranslationKeysRef.current.add(rec.localeDeletedKey);

  // Everything below is what the merchant SEES: only while that is still the
  // item, locale and market the copy ran on.
  const stillThere =
    selectedItemRef.current?.id === rec.itemId &&
    currentLanguageRef.current === rec.locale &&
    selectedMarketIdRef.current === rec.marketId;
  if (!stillThere) return;

  const restoreKey = (map: Record<string, string>, previous: string | undefined) => {
    const next = { ...map };
    if (previous === undefined) delete next[rec.fieldKey];
    else next[rec.fieldKey] = previous;
    return next;
  };
  if (baselineValuesRef.current[rec.fieldKey] === rec.value) {
    baselineValuesRef.current = restoreKey(baselineValuesRef.current, rec.prevBaseline);
    setBaselineVersion((v) => v + 1);
  }
  if (originalLoadedValuesRef.current[rec.fieldKey] === rec.value) {
    originalLoadedValuesRef.current = restoreKey(originalLoadedValuesRef.current, rec.prevOriginalLoaded);
  }
  if (isThemeContentType(config.contentType) && originalTemplateValuesRef.current[rec.fieldKey] === rec.value) {
    // The copy mirrored its value into the template baseline too; without a
    // recorded predecessor, the stored (pre-copy) value is the field's own.
    if (rec.prevOriginalLoaded !== undefined) {
      originalTemplateValuesRef.current = restoreKey(originalTemplateValuesRef.current, rec.prevOriginalLoaded);
    }
    setTemplateValuesVersion((v) => v + 1);
  }
  if (opts?.keepVisible) {
    // The text stays, as a draft: no longer inherited, and changed against
    // the restored baseline.
    fallbackFieldsRef.current.delete(rec.fieldKey);
    return;
  }
  // The visible value goes back only while it still holds the copied text.
  if (editableValuesRef.current[rec.fieldKey] === rec.value) {
    setEditableValues((prev) =>
      prev[rec.fieldKey] === rec.value
        ? { ...prev, [rec.fieldKey]: rec.prevEditable ?? "" }
        : prev,
    );
    if (rec.wasFallback) {
      fallbackFieldsRef.current.add(rec.fieldKey);
      setFallbackFields((prev) => new Set(prev).add(rec.fieldKey));
    }
  }
};

const handleCopyFieldToAllLocales = (fieldKey: string): void => {
  if (!selectedItemId) return;
  // It writes EVERY language: any run of the item (or a primary save held
  // behind one) refuses it, before anything is staged.
  if (refuseOwnSave?.(selectedItemId, primaryLocale, { notStarted: true })) return;
  const field = effectiveFieldDefinitions.find(f => f.key === fieldKey);
  if (!field) return;
  const primaryValue = editableValuesRef.current[fieldKey];
  if (!primaryValue) return;

  const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
  if (targetLocales.length === 0) return;

  // Backstop for the disabled button: copying an UNSAVED primary value into
  // every language, then saving the primary, would purge what was copied.
  if (isPrimaryFieldUnsaved(fieldKey)) {
    refuseUnsavedSource();
    return;
  }

  const translations: Record<string, string> = Object.fromEntries(
    targetLocales.map(locale => [locale, primaryValue])
  );

  dataLoader.onTranslateFieldToAllLocalesComplete(field.translationKey, translations, currentLanguage);

  const capturedItemId = selectedItemId;
  markOperationActive(capturedItemId, fieldKey, "copyToAllLocales");

  // Sequential, as before. The answer is READ now (see
  // content-action-endpoint.shared.ts): "copied" is said once every locale
  // confirmed, and a locale that did not is named instead of hidden.
  const runSaves = async () => {
    const { failed, gated } = await runPerLocaleSavesDetailed(
      targetLocales,
      (locale) => {
        const fd = new FormData();
        fd.set("action", "updateContent");
        fd.set("itemId", capturedItemId);
        fd.set("locale", locale);
        fd.set("primaryLocale", primaryLocale);
        fd.set(fieldKey, primaryValue);
        return postContentEditorSave(fd);
      },
      { sequential: true },
    );
    markOperationFailed(capturedItemId, fieldKey);
    if (failed.length > 0) {
      // Take back what the copy showed up front for those locales: the
      // overlay (it outranks the loaded data in resolve()) and whatever a
      // page cached through onTranslateToAllLocalesComplete. Left in place,
      // the editor went on showing a value that was never saved.
      dataLoader.onCopyToLocalesFailed(field.translationKey, failed, primaryValue, {
        itemUnchanged: selectedItemIdRef.current === capturedItemId,
        allLocalesFailed: failed.length === targetLocales.length,
      });
      onCopyToAllLocalesFailed?.(fieldKey, failed);
    }
    const outcome = copyOutcomeMessage(failed, { ...(t.common ?? {}), upgradeRequired: String(t.content?.upgradeRequired ?? "") || undefined }, gated);
    showInfoBox(outcome.text, outcome.tone);
  };
  void runSaves();

  onTranslateToAllLocalesComplete?.(fieldKey, translations);
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
    rollbackCopyField,
    discardCopyFieldRecord,
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
