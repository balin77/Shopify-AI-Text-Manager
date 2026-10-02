/**
 * useEditorAutoSave
 *
 * Encapsulates the auto-save function and its helper utilities extracted from
 * useUnifiedContentEditor. Responsible for building save payloads, computing
 * changed fields / alt-text indices, and submitting them via safeSubmit.
 */

import type { PartialSave } from "./useUiDataLoader";
import { settleUnsentSave, type OwnSaveInFlight } from "../services/editor/own-save-in-flight.shared";
import { sentAltsFromForm, sentFieldsFromForm, type SentSaveScope } from "../services/editor/own-field-save.shared";
import { isThemeContentType } from "~/utils/content-type-groups";
import { isAttributeField } from "../services/content-attributes.shared";
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
  savedMarketIdRef: React.MutableRefObject<string>;
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
    savedMarketId: string;
    savedItemId: string | null;
    partial: PartialSave | null;
    successToast: string | null;
  }>>;
  justSubmittedRef: React.MutableRefObject<boolean>;
  fetcherRef: React.MutableRefObject<any>;
  /** Staged by a caller right before `safeSubmit` for a PARTIAL save; taken
   *  over here and bound to the request it belongs to. */
  partialSaveRef: React.MutableRefObject<PartialSave | null>;
  /** The partial description of the request IN FLIGHT (null = a full save). */
  inFlightPartialRef: React.MutableRefObject<PartialSave | null>;
  /** Staged success text, bound to the request it belongs to (queue entry or in-flight slot). */
  pendingAltTranslateToastRef: React.MutableRefObject<string | null>;
  inFlightToastRef: React.MutableRefObject<string | null>;
  /** Until when the next data re-read keeps unsaved edits (see the editor). */
  preserveEditsUntilRef: React.MutableRefObject<number>;
  /** Registers a partial save (an AI/copy button's own result) as in flight,
   *  so the change detection does not show its value as a draft while it is
   *  being written. A React state setter: stable, safe in the [] callback. */
  setOwnSavesInFlight?: React.Dispatch<React.SetStateAction<OwnSaveInFlight[]>>;
  /** The locale, market and alt texts of the request IN FLIGHT, bound at
   *  submit time like `inFlightPartialRef` (see `revertAltsWithoutPrimary`). */
  inFlightScopeRef?: React.MutableRefObject<SentSaveScope | null>;
  /** True while a "translate all" run of this item writes into `locale` (or,
   *  for the primary locale, runs at all): such a save waits in the queue
   *  until the run answered, so it lands AFTER the run -- a hand-written value
   *  is not overwritten by the AI, and a primary purge is not undone by
   *  translations of the old text. A save of another language goes at once. */
  saveBlockedByTranslateRunRef?: React.MutableRefObject<(locale: string | null, itemId: string | null, beforeIndex?: number) => boolean>;
  /** Called when a save is held back that way (the page says why it waits). */
  onSaveHeldByRunRef?: React.MutableRefObject<() => void>;
  /** Called when an OWN save (an AI/copy button's) is refused because a run
   *  writes into its language: it is not held -- a held own save would make
   *  every switch refuse for the whole run -- and its value stays a draft. */
  onOwnSaveRefusedRef?: React.MutableRefObject<() => void>;
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
    savedMarketIdRef,
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
    partialSaveRef,
    inFlightPartialRef,
    pendingAltTranslateToastRef,
    inFlightToastRef,
    preserveEditsUntilRef,
    setOwnSavesInFlight,
    inFlightScopeRef,
    saveBlockedByTranslateRunRef,
    onSaveHeldByRunRef,
    onOwnSaveRefusedRef,
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

    // A partial save is described by the caller just before this call; the
    // description travels WITH its request (queue entry or in-flight slot),
    // never in one shared slot a different response could consume.
    const partial = partialSaveRef.current;
    partialSaveRef.current = null;
    const successToast = pendingAltTranslateToastRef.current;
    pendingAltTranslateToastRef.current = null;
    // Only a SAVE waits for a "translate all" run of its language.
    const blockedByRun =
      data.action === "updateContent" &&
      !!saveBlockedByTranslateRunRef?.current(savedLocaleRef.current, savedItemIdRef.current);
    const nothingInFlight = fetcherRef.current.state === "idle" && !justSubmittedRef.current;
    if (blockedByRun && partial) {
      // An own save is REFUSED, never held: nothing was sent, so the field
      // keeps the value as a draft for the Save button.
      if (nothingInFlight) isSavePendingRef.current = false;
      onOwnSaveRefusedRef?.current();
      return;
    }
    if (blockedByRun && nothingInFlight) {
      // The caller marked a save pending, but nothing is in flight: the
      // queue drain marks it again when it really goes.
      isSavePendingRef.current = false;
    }
    if (partial) {
      // The reload that follows this save re-reads the item; the fields it did
      // NOT carry may hold unsaved input, which that pass must keep.
      preserveEditsUntilRef.current = Date.now() + 30_000;
      // What this save carries is being WRITTEN, not drafted: until its answer
      // lands the save bar must not count it (own-save-in-flight.shared.ts).
      // Keyed by the partial object itself, which travels with the request
      // (queue entry / in-flight slot) and is how the answer settles it.
      const itemId = savedItemIdRef.current;
      const carriesSomething =
        Object.keys(partial.values).length > 0 ||
        (partial.altValues !== undefined && Object.keys(partial.altValues).length > 0);
      if (setOwnSavesInFlight && itemId && carriesSomething) {
        const entry: OwnSaveInFlight = {
          itemId,
          locale: partial.locale,
          marketId: partial.marketId ?? "",
          values: partial.values,
          altValues: partial.altValues,
          token: partial,
        };
        setOwnSavesInFlight((prev) => [...prev, entry]);
      }
    }

    if (blockedByRun) onSaveHeldByRunRef?.current();
    if (fetcherRef.current.state !== 'idle' || justSubmittedRef.current || blockedByRun) {
      debugLog.submit(' Fetcher busy (state:', fetcherRef.current.state, ', justSubmitted:', justSubmittedRef.current, '), queuing save for locale:', savedLocaleRef.current);
      saveQueueRef.current.push({
        formData,
        options: options || { method: "POST" },
        savedLocale: savedLocaleRef.current,
        savedMarketId: savedMarketIdRef.current,
        savedItemId: savedItemIdRef.current,
        partial,
        successToast,
      });
      return;
    }
    inFlightPartialRef.current = partial;
    inFlightToastRef.current = successToast;
    if (inFlightScopeRef) {
      inFlightScopeRef.current = {
        locale: savedLocaleRef.current ?? "",
        marketId: savedMarketIdRef.current ?? "",
        sentAlts: sentAltsFromForm(data.imageAltTexts),
        sentFields: sentFieldsFromForm(Object.entries(data)),
      };
    }

    try {
      justSubmittedRef.current = true;
      fetcherRef.current.submit(formData, options || { method: "POST" });
      // Reset via microtask: React 18 automatic batching can collapse idle→submitting→idle
      // into a single render, so the useEffect([fetcher.state]) reset never fires.
      // A microtask still blocks same-event-loop-tick double submits but clears before
      // the next user interaction (which is always a new task, never a microtask).
      Promise.resolve().then(() => { justSubmittedRef.current = false; });
    } catch (error) {
      console.error('❌ [safeSubmit] Error caught:', error);
      justSubmittedRef.current = false;
      if (error instanceof Error && error.name === 'AbortError') {
        debugLog.submit(' AbortError caught (data likely saved):', error.message);
        // No answer will come for it: nothing may keep reading as pending.
        isSavePendingRef.current = false;
      } else {
        // The request never left: settle what was staged for it (shared
        // with the queued-save drain in useUnifiedContentEditor).
        settleUnsentSave({
          partial,
          successToast,
          setOwnSavesInFlight,
          inFlightPartialRef,
          inFlightToastRef,
          inFlightScopeRef,
          isSavePendingRef,
        });
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

    // Compare against the value that was LOADED into the editor this session,
    // not the live server item. Shopify (and the rich-text editor) normalize HTML
    // on save, so a re-fetched `item.body` can differ byte-for-byte from the
    // client value even when the user never touched the body. Comparing against
    // the live item would then flag `body` as "changed" on every subsequent
    // primary save and wrongly purge its translations across all foreign locales.
    // The loaded baseline reflects what the user actually started editing from —
    // the same source buildFieldsForSave uses for foreign-locale change filtering.
    const loadedBaseline = originalLoadedValuesRef.current;
    const hasLoadedBaseline = loadedBaseline && Object.keys(loadedBaseline).length > 0;

    effectiveFieldDefinitions.forEach((field) => {
      const currentValue = valuesToCheck[field.key] || "";

      let originalValue: string;
      if (isThemeContentType(config.contentType)) {
        originalValue = originalTemplateValuesRef.current[field.key] || "";
      } else if (hasLoadedBaseline) {
        originalValue = loadedBaseline[field.key] || "";
      } else {
        // Defensive fallback: baseline not yet populated (should not happen after
        // a normal load, but avoids treating everything as changed if it isn't).
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
    if (!item) return [];

    const changedIndices: number[] = [];
    for (const [indexStr, currentValue] of Object.entries(imageAltTextsRef.current)) {
      const index = parseInt(indexStr, 10);
      // Index 0 falls back to `featuredImage` — the same rule `getImageAtIndex`
      // follows, and not an edge case: a collection and an article load with
      // `images: []` and their one image in `featuredImage`, so baselining
      // against `images[0]` alone read every existing alt as "was empty".
      // Setting or changing one still reported a change (anything differs from
      // ""), but CLEARING one did not — and that is the save whose translations
      // most need to go.
      //
      // The fallback is on a MISSING image, never on a missing alt TEXT: a
      // product whose `images[0]` carries no alt would otherwise be baselined
      // against the featured image's, and an edit that matches it would go
      // unreported with its stale translations left standing.
      const originalImage =
        item.images?.[index] ??
        (index === 0
          ? (item as { featuredImage?: { altText?: string } }).featuredImage
          : undefined);
      const originalValue = originalImage?.altText || "";
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

    // ── Two questions, two fields ─────────────────────────────────────────
    // `changedFields` answers "which translations did this primary change make
    // stale", and the accept-and-translate flow deliberately withholds it: it
    // is about to write those very translations, so marking them stale would
    // make them flash empty in between.
    //
    // PLAN §Phase 3 needs a DIFFERENT answer: which merchandising attributes
    // did the merchant actually touch — because a primary save carries every
    // field and the server cannot otherwise tell an edit from a passenger.
    // Folding that into `changedFields` would have re-introduced the deletion
    // this flow exists to avoid; withholding it would silently drop attribute
    // edits while reporting success. So it travels on its own.
    const item = selectedItemRef.current;
    if (locale === primaryLocale && item) {
      const changedFields = getChangedFields(valuesToSave);

      const changedAttributes = changedFields.filter((fieldKey) => {
        const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
        return !!field && isAttributeField(field);
      });
      if (changedAttributes.length > 0) {
        formDataObj.changedAttributeFields = JSON.stringify(changedAttributes);
      }

      if (changedFields.length > 0 && !isAcceptAndTranslateFlowRef.current) {
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
  }, [selectedItemId, primaryLocale, effectiveFieldDefinitions, getChangedFields, getChangedAltTextIndices, safeSubmit]);

  return {
    performAutoSave,
    getChangedFields,
    getChangedAltTextIndices,
    buildFieldsForSave,
    safeSubmit,
  };
}
