/**
 * useEditorAltText
 *
 * Encapsulates all alt-text state and handlers extracted from useUnifiedContentEditor.
 * Includes:
 *   - Alt-text state (imageAltTexts, altTextSuggestions, originalAltTexts, etc.)
 *   - selectedImageIndex state (whether the AI may LOOK at an image is a
 *     shop-wide setting now, resolved server-side — see
 *     [vision-policy.shared.ts](../services/ai/vision-policy.shared.ts))
 *   - ALT-TEXT HANDLERS section
 *   - SEND IMAGE TO AI HANDLERS section (including reset effects)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { overlayWritesFromTranslations, overlayIndexWrites } from "../services/alt-text-feedback.shared";
import { useLatestRef } from "./useLatestRef";
import { getItemFieldValue, buildLocaleKey } from "./useUiDataLoader";
import { markOperationActive, markOperationFailed } from "./useAIOperationsStore";
import {
  setAltTextSuggestion,
  clearAltTextSuggestion,
  useAltTextSuggestions,
  type SuggestionScope,
} from "./useAISuggestionStore";
import type {
  ShopLocale,
  ContentImage,
  ContentEditorConfig,
  TranslationStrings,
} from "../types/content-editor.types";
import { debugLog } from "../utils/debug";
import { postContentEditorSave } from "../services/editor/content-action-endpoint.shared";
import { runPerLocaleSavesDetailed, copyOutcomeMessage } from "../services/editor/per-locale-saves.shared";
import { buildOwnSaveForm, isUnsavedPrimaryAlt } from "../services/editor/own-field-save.shared";
import type { PartialSave } from "./useUiDataLoader";

/**
 * The medium behind an image tile, as a form field. The server resolves the
 * image to write by this id when it is sent (a position in the editor's list is
 * not a position in the DB order); collections and articles carry none and
 * keep the index.
 */
function mediaIdField(image: unknown): { mediaId?: string } {
  const id = (image as { mediaId?: unknown } | null | undefined)?.mediaId;
  return typeof id === "string" && id.startsWith("gid://") ? { mediaId: id } : {};
}

// ---------------------------------------------------------------------------
// Prop / return types
// ---------------------------------------------------------------------------

interface UseEditorAltTextProps {
  selectedItem: any;
  selectedItemId: string | null;
  selectedItemRef: React.MutableRefObject<any>;
  selectedItemIdRef: React.MutableRefObject<string | null>;
  currentLanguage: string;
  /** Selected market ("" = global). Alt text is resolved/saved per market. */
  selectedMarketId: string;
  primaryLocale: string;
  shopLocales: ShopLocale[];
  config: ContentEditorConfig;
  enabledLanguages: string[];
  editableValues: Record<string, string>;
  editableValuesRef: React.MutableRefObject<Record<string, string>>;
  /**
   * Bumped by the editor once a finished background re-translation has been
   * reloaded. The foreign alt texts are resolved by an effect of their own,
   * keyed on language/market/item, and a revalidation moves none of those —
   * so without this the AI's new alt texts reach the loader and never the
   * screen. Optional: a caller that never refreshes in the background simply
   * leaves it at 0.
   */
  backgroundRefreshVersion?: number;
  /** Success text staged right before the save is submitted; `safeSubmit` binds it to that request. */
  pendingAltTranslateToastRef: React.MutableRefObject<string | null>;
  buildFieldsForSave: (values: Record<string, string>, locale: string) => Record<string, string>;
  safeSubmit: (data: Record<string, any>, options?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }) => void;
  /** Item the in-flight save belongs to; the save-response handler bails without it. */
  savedItemIdRef: React.MutableRefObject<string | null>;
  savedLocaleRef: React.MutableRefObject<string | null>;
  savedMarketIdRef: React.MutableRefObject<string>;
  isSavePendingRef: React.MutableRefObject<boolean>;
  isSaveFromTranslateRef: React.MutableRefObject<boolean>;
  revalidatorRef: React.MutableRefObject<{ state: string; revalidate: () => void }>;
  submitAIAction: (
    data: Record<string, string>,
    fieldKey: string,
    onSuccess?: (result: Record<string, unknown>) => void,
    onError?: (error: string) => void
  ) => void;
  showInfoBox: (message: string, tone?: import("../types/content-editor.types").InfoBoxTone) => void;
  t: TranslationStrings;
  /** Item + locale + market this editor is showing — the key AI suggestions are stored under. */
  suggestionScope: SuggestionScope;
  /** Staged right before `safeSubmit` for a save that carries only SOME alt
   *  texts (an AI or copy button's own result); see PartialSave.altIndices. */
  partialSaveRef: React.MutableRefObject<PartialSave | null>;
}

interface UseEditorAltTextReturn {
  // State
  imageAltTexts: Record<number, string>;
  /** Image indices whose alt text is a market-inherited (global) fallback. */
  fallbackAltTextIndices: Set<number>;
  setImageAltTexts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  altTextSuggestions: Record<number, string>;
  originalAltTexts: Record<number, string>;
  setOriginalAltTexts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  imageAltTextsRef: React.MutableRefObject<Record<number, string>>;
  originalAltTextsRef: React.MutableRefObject<Record<number, string>>;
  pendingAltTextAutoSaveRef: React.MutableRefObject<Record<number, string> | null>;
  /** Locale (or `locale@@market`, see LOCALE_MARKET_SEP) → index → alt text.
   *  Exposed so a PRIMARY save can drop what the server just deleted — the
   *  overlay is read before the loaded item, so a stale entry survives the
   *  purge and gets written back. */
  localAltTextOverlayRef: React.MutableRefObject<Record<string, Record<number, string>>>;
  selectedImageIndex: number;
  setSelectedImageIndex: React.Dispatch<React.SetStateAction<number>>;
  // Handlers
  handleAltTextChange: (imageIndex: number, value: string) => void;
  handleGenerateAltText: (imageIndex: number, userInstruction?: string) => void;
  handleGenerateAllAltTexts: () => void;
  handleAcceptAltText: (imageIndex: number) => void;
  handleRejectAltText: (imageIndex: number) => void;
  handleCopyAltText: (imageIndex: number) => void;
  handleCopyAltTextToAllLocales: (imageIndex: number) => void;
  handleTranslateAltText: (imageIndex: number) => void;
  handleTranslateAltTextToAllLocales: (imageIndex: number) => void;
  handleTranslateAllAltTexts: () => void;
  /** Ref to pending copy index so save-response handler can clear loading state */
  pendingCopyAltTextIndexRef: React.MutableRefObject<number | null>;
  /** Failed copy: drop the optimistic overlay entry if it still holds the copied value. */
  rollbackCopyAltText: () => void;
  discardCopyAltRecord: () => void;
  altBaselineSnapshot: (failedIndices?: number[]) => Record<number, string>;
  getPendingCopyAltItemId: () => string | null;
  handleTranslateAllAltTextsForLocale: () => void;
  handleAcceptAltTextSuggestion: (imageIndex: number) => void;
  handleAcceptAndTranslateAltText: (imageIndex: number) => void;
  handleRejectAltTextSuggestion: (imageIndex: number) => void;
  /** The primary alt of this image is an unsaved draft (copy/translate-to-all
   *  would take it as their source, and its own Save would then purge what
   *  they wrote). Always false on a foreign locale. */
  isPrimaryAltUnsaved: (imageIndex: number) => boolean;
  /** Any primary alt is an unsaved draft ("translate all alt texts"). */
  hasUnsavedPrimaryAlts: () => boolean;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useEditorAltText(props: UseEditorAltTextProps): UseEditorAltTextReturn {
  const {
    selectedItem,
    selectedItemId,
    selectedItemRef,
    selectedItemIdRef,
    currentLanguage,
    selectedMarketId,
    primaryLocale,
    shopLocales,
    config,
    enabledLanguages,
    editableValues,
    editableValuesRef,
    backgroundRefreshVersion = 0,
    pendingAltTranslateToastRef,
    buildFieldsForSave,
    safeSubmit,
    savedItemIdRef,
    savedLocaleRef,
    savedMarketIdRef,
    isSavePendingRef,
    isSaveFromTranslateRef,
    revalidatorRef,
    submitAIAction,
    showInfoBox,
    t,
    suggestionScope,
    partialSaveRef,
  } = props;

  // ============================================================================
  // ALT-TEXT STATE
  // ============================================================================

  // Alt-text state for images (indexed by image position)
  const [imageAltTexts, setImageAltTexts] = useState<Record<number, string>>({});
  // Suggestions live in the global store, not in this component: an answer the
  // merchant has not decided on must survive them leaving the page and coming
  // back (see useAISuggestionStore).
  const altTextSuggestions = useAltTextSuggestions(suggestionScope);
  // Track original alt-texts to detect changes (using state to trigger re-renders)
  const [originalAltTexts, setOriginalAltTexts] = useState<Record<number, string>>({});
  const imageAltTextsRef = useLatestRef(imageAltTexts);
  const originalAltTextsRef = useLatestRef(originalAltTexts);
  const currentLanguageRef = useLatestRef(currentLanguage);
  const selectedMarketIdRefAlt = useLatestRef(selectedMarketId);

  // Track pending auto-save for alt-texts (set by bulk generation and translation effects)
  const pendingAltTextAutoSaveRef = useRef<Record<number, string> | null>(null);
  // Track image index of an in-flight copy save so save-response handler can clear loading
  const pendingCopyAltTextIndexRef = useRef<number | null>(null);
  // What the in-flight copy wrote into the overlay, so a failure can undo exactly that.
  const copyOverlayRollbackRef = useRef<{
    itemId: string;
    key: string;
    index: number;
    value: string;
    prevField: string | undefined;
    prevOriginal: string | undefined;
    prevOverlay: string | undefined;
  } | null>(null);
  // Per-locale overlay for copy operations — eliminates stale window on locale switch
  // structure: { locale: { imageIndex: altText } }
  const localAltTextOverlayRef = useRef<Record<string, Record<number, string>>>({});

  // Image indices whose alt text is inherited from the global value while a
  // non-global market is selected (mirrors the main fields' fallbackFields). The
  // UI greys these out. Empty in the global context.
  const [fallbackAltTextIndices, setFallbackAltTextIndices] = useState<Set<number>>(new Set());

  // Send Image to AI feature state
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  // ============================================================================
  // ALT-TEXT HANDLERS
  // ============================================================================

  const handleAltTextChange = useCallback((imageIndex: number, value: string) => {
    setImageAltTexts(prev => ({
      ...prev,
      [imageIndex]: value
    }));
  }, []);

  /**
   * Get image at index, falling back to featuredImage when images array is empty.
   * This supports articles which store only a featuredImage without an images array.
   */
  const getImageAtIndex = (item: any, index: number): ContentImage | null => {
    if (item?.images && item.images[index]) return item.images[index];
    if (index === 0 && item?.featuredImage) return item.featuredImage;
    return null;
  };

  const isPrimaryAltUnsaved = (imageIndex: number): boolean =>
    isUnsavedPrimaryAlt({
      currentLanguage,
      primaryLocale,
      value: imageAltTexts[imageIndex],
      original: originalAltTexts[imageIndex],
    });

  const hasUnsavedPrimaryAlts = (): boolean => {
    if (currentLanguage !== primaryLocale) return false;
    const keys = new Set([...Object.keys(imageAltTexts), ...Object.keys(originalAltTexts)]);
    for (const key of keys) if (isPrimaryAltUnsaved(Number(key))) return true;
    return false;
  };

  const refuseUnsavedSource = (): void => {
    showInfoBox(
      String(t.common?.saveFirstSource || "Save first — the main-language text has unsaved changes."),
      "warning",
    );
  };

  /**
   * Save exactly these alt texts — an AI or copy button's OWN result — and
   * nothing else. The text fields and every other alt the merchant typed stay
   * drafts for their own Save (the save is PARTIAL, so its response moves only
   * these indices' baselines, and a failed index stays dirty).
   *
   * On the primary locale an index whose text really changed travels as
   * `changedAltTextIndices` (the merchant's purge / auto-translate policy then
   * applies exactly as if they had typed it and pressed Save), unless the
   * caller is about to write the translations itself (`markChanged: false`,
   * the accept-and-translate flow).
   */
  const submitOwnAltSave = (opts: {
    itemId: string;
    locale: string;
    /** The market the save is scoped to ("" = global; ignored on primary). */
    marketId: string;
    alts: Record<number, string>;
    markChanged?: boolean;
    fromTranslate?: boolean;
    successToast?: string;
    /** Record the save under this locale for the response handling (defaults
     *  to `locale`). The foreign accept-and-translate flow writes the PRIMARY
     *  alt while the merchant views `L`, and must not process it as primary. */
    trackLocale?: string | null;
    /** The alt indices of the VIEW this save stands for (default: the ones it sends). */
    viewAltIndices?: number[];
  }): void => {
    const isPrimary = opts.locale === primaryLocale;
    const item = selectedItemRef.current;
    const indices = Object.keys(opts.alts).map(Number);
    const changed =
      isPrimary && opts.markChanged !== false
        ? indices.filter((i) => (opts.alts[i] ?? "") !== (getImageAtIndex(item, i)?.altText || ""))
        : [];
    const form = buildOwnSaveForm({
      itemId: opts.itemId,
      locale: opts.locale,
      primaryLocale,
      marketId: isPrimary ? "" : opts.marketId,
      altTexts: opts.alts,
      changedAltTextIndices: changed,
      policyType: config.resourceType === "ShopPolicy" ? item?.type : undefined,
    });
    if (changed.length > 0) {
      // The server deletes these images' foreign alt translations (global AND
      // market layer) — drop them here too, exactly like the page Save does,
      // or the editor keeps rendering a deleted alt and writes it back.
      for (const key of Object.keys(localAltTextOverlayRef.current)) {
        if (key === primaryLocale) continue;
        for (const index of changed) delete localAltTextOverlayRef.current[key][index];
      }
      for (const index of changed) {
        const img = getImageAtIndex(item, index) as { altTextTranslations?: Array<{ locale: string }> } | null;
        if (img?.altTextTranslations) {
          img.altTextTranslations = img.altTextTranslations.filter((tr) => tr.locale === primaryLocale);
        }
      }
    }
    partialSaveRef.current = {
      locale: currentLanguageRef.current,
      marketId: selectedMarketIdRefAlt.current,
      values: {},
      altIndices: opts.viewAltIndices ?? indices,
    };
    if (opts.successToast) pendingAltTranslateToastRef.current = opts.successToast;
    savedItemIdRef.current = opts.itemId;
    if (opts.trackLocale !== null) {
      savedLocaleRef.current = opts.trackLocale ?? opts.locale;
      savedMarketIdRef.current = isPrimary ? "" : opts.marketId;
    }
    isSavePendingRef.current = true;
    if (opts.fromTranslate) isSaveFromTranslateRef.current = true;
    safeSubmit(form, { method: "POST" });
  };

  /**
   * @param userInstruction Ad-hoc instruction from the AIInstructionPrompt box
   *   on the alt-text field. Undefined/empty generates exactly as before.
   */
  const handleGenerateAltText = (imageIndex: number, userInstruction?: string) => {
    if (!selectedItem) return;
    const image = getImageAtIndex(selectedItem, imageIndex);
    if (!image) return;

    // Captured now, not read when the answer lands: the suggestion belongs to
    // the item, locale and market it was requested from.
    const requestScope: SuggestionScope = { ...suggestionScope, resourceId: selectedItem.id };
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
        ...(userInstruction?.trim() && { userInstruction: userInstruction.trim() }),
      },
      `altText_${imageIndex}`,
      (result) => {
        // Stored under the scope the request was MADE in, so navigating away
        // mid-request no longer throws the answer away — it is waiting on the
        // image when the merchant comes back. (`requestScope` carries the item
        // id, which is what the old `selectedItemIdRef` guard checked for.)
        if (result.altText) {
          setAltTextSuggestion(requestScope, imageIndex, result.altText as string);
        }
      }
    );
  };

  const handleGenerateAllAltTexts = () => {
    const allImages: ContentImage[] = selectedItem?.images?.length > 0
      ? selectedItem.images
      : selectedItem?.featuredImage ? [selectedItem.featuredImage] : [];
    if (!selectedItem || allImages.length === 0) return;

    const requestItemId = selectedItem.id;
    const productTitle = getItemFieldValue(selectedItem, 'title', primaryLocale, config);
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;
    const imagesData = allImages.map((img: ContentImage) => ({ url: img.url }));

    submitAIAction(
      {
        action: "generateAllAltTexts",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle,
        mainLanguage,
        imagesData: JSON.stringify(imagesData),
      },
      "allAltTextsGenerate",
      (result) => {
        // Guard: discard if user switched to a different item during the request.
        if (selectedItemIdRef.current !== requestItemId) return;
        if (result.generatedAltTexts) {
          // Only the GENERATED alts are written into the fields and saved; an
          // alt the merchant typed for another image stays their draft. The
          // baseline moves once the save confirms them (partial alt save).
          const generated = result.generatedAltTexts as Record<number, string>;
          setImageAltTexts((prev) => ({ ...prev, ...generated }));
          pendingAltTextAutoSaveRef.current = { ...generated };
        }
      }
    );
  };

  const handleCopyAltText = (imageIndex: number) => {
    if (!selectedItem || !selectedItemId) return;
    const image = getImageAtIndex(selectedItem, imageIndex);
    if (!image) return;

    const sourceAltText = image.altText || "";
    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden",
        "warning"
      );
      return;
    }

    const prevField = imageAltTexts[imageIndex];
    const prevOriginal = originalAltTexts[imageIndex];
    setImageAltTexts((prev) => ({ ...prev, [imageIndex]: sourceAltText }));
    // Only THIS image's baseline: another alt the merchant typed stays a draft.
    setOriginalAltTexts((prev) => ({ ...prev, [imageIndex]: sourceAltText }));

    // Write to overlay (market-folded) so switching away and back to this
    // locale/market shows the correct value immediately.
    const copyOverlayKey = buildLocaleKey(currentLanguage, selectedMarketId);
    if (!localAltTextOverlayRef.current[copyOverlayKey]) {
      localAltTextOverlayRef.current[copyOverlayKey] = {};
    }
    const prevOverlay = localAltTextOverlayRef.current[copyOverlayKey][imageIndex];
    localAltTextOverlayRef.current[copyOverlayKey][imageIndex] = sourceAltText;
    copyOverlayRollbackRef.current = {
      itemId: selectedItemId,
      key: copyOverlayKey,
      index: imageIndex,
      value: sourceAltText,
      prevField,
      prevOriginal,
      prevOverlay,
    };

    markOperationActive(selectedItemId, `altText_${imageIndex}`, "copy");
    pendingCopyAltTextIndexRef.current = imageIndex;

    // ONLY this image's alt: unsaved text fields and other alts stay drafts.
    submitOwnAltSave({
      itemId: selectedItemId,
      locale: currentLanguage,
      marketId: selectedMarketId,
      alts: { [imageIndex]: sourceAltText },
      fromTranslate: true,
    });

    // Feedback is deferred to the save-response handler (see
    // pendingCopyAltTextIndexRef in useUnifiedContentEditor.ts), so the box
    // reflects the actual Shopify result and not an optimistic guess.
  };

  // The visible field and baseline may be restored only while the screen still
  // shows the item, locale and market the copy ran on, and the index still
  // holds the copied value (a later edit stays).
  const canRestoreVisibleCopy = (
    pending: NonNullable<typeof copyOverlayRollbackRef.current>,
  ) =>
    selectedItemIdRef.current === pending.itemId &&
    buildLocaleKey(currentLanguageRef.current, selectedMarketIdRefAlt.current) === pending.key;

  /** Item the in-flight alt copy was started for (independent of savedItemIdRef). */
  const getPendingCopyAltItemId = () => copyOverlayRollbackRef.current?.itemId ?? null;

  /** Baseline snapshot for a save response: current alt texts, except that an
   *  index whose copy FAILED (and will be rolled back) keeps its previous
   *  original, so the later non-functional baseline write cannot override
   *  the rollback. */
  const altBaselineSnapshot = (failedIndices: number[] = []): Record<number, string> => {
    const base = { ...imageAltTextsRef.current };
    const pending = copyOverlayRollbackRef.current;
    if (
      pending &&
      // Only while that copy is still the save being answered: a record left
      // over from an earlier copy must never rewrite a later save's baseline.
      pendingCopyAltTextIndexRef.current === pending.index &&
      failedIndices.includes(pending.index) &&
      canRestoreVisibleCopy(pending) &&
      base[pending.index] === pending.value
    ) {
      if (pending.prevOriginal === undefined) delete base[pending.index];
      else base[pending.index] = pending.prevOriginal;
    }
    return base;
  };

  /** A copy that LANDED: forget its rollback record, or a later unrelated
   *  save would still be read through it. */
  const discardCopyAltRecord = () => {
    copyOverlayRollbackRef.current = null;
  };

  const rollbackCopyAltText = () => {
    const pending = copyOverlayRollbackRef.current;
    copyOverlayRollbackRef.current = null;
    if (!pending) return;
    const entry = localAltTextOverlayRef.current[pending.key];
    // Only undo our own write: a later edit or copy under the same key stays.
    if (entry && entry[pending.index] === pending.value) {
      if (pending.prevOverlay === undefined) delete entry[pending.index];
      else entry[pending.index] = pending.prevOverlay;
    }
    // Item or locale/market changed: the visible state belongs to someone else.
    if (!canRestoreVisibleCopy(pending)) return;
    const restore = (
      prev: Record<number, string>,
      previous: string | undefined,
    ): Record<number, string> => {
      if (prev[pending.index] !== pending.value) return prev;
      const next = { ...prev };
      if (previous === undefined) delete next[pending.index];
      else next[pending.index] = previous;
      return next;
    };
    setImageAltTexts((prev) => restore(prev, pending.prevField));
    setOriginalAltTexts((prev) => restore(prev, pending.prevOriginal));
  };

  const handleCopyAltTextToAllLocales = (imageIndex: number) => {
    if (!selectedItem || !selectedItemId) return;
    const image = getImageAtIndex(selectedItem, imageIndex);
    if (!image) return;

    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) return;

    // Backstop for the disabled button: copying an unsaved primary alt into
    // every language, then saving it, would purge what was just copied.
    if (isPrimaryAltUnsaved(imageIndex)) {
      refuseUnsavedSource();
      return;
    }

    const sourceAltText = imageAltTexts[imageIndex] || image.altText || "";
    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden",
        "warning"
      );
      return;
    }

    const capturedItemId = selectedItemId;

    // Write to overlay immediately for all target locales
    for (const locale of targetLocales) {
      if (!localAltTextOverlayRef.current[locale]) {
        localAltTextOverlayRef.current[locale] = {};
      }
      localAltTextOverlayRef.current[locale][imageIndex] = sourceAltText;
    }

    markOperationActive(capturedItemId, `altText_${imageIndex}`, "copyToAllLocales");

    // The answer is READ (content-action-endpoint.shared.ts), so a locale that
    // did not save is named instead of reported as copied.
    runPerLocaleSavesDetailed(targetLocales, (locale) => {
      const fd = new FormData();
      fd.set("action", "updateContent");
      fd.set("itemId", capturedItemId);
      fd.set("locale", locale);
      fd.set("primaryLocale", primaryLocale);
      fd.set("imageAltTexts", JSON.stringify({ [imageIndex]: sourceAltText }));
      return postContentEditorSave(fd);
    }).then(({ failed, gated }) => {
      // Take back what the copy wrote up front for those locales: the
      // overlay outranks the loaded alt texts, so left in place the editor
      // went on showing a value that was never saved. Only the copy's own
      // value -- anything written there since is not ours to remove.
      for (const locale of failed) {
        const forLocale = localAltTextOverlayRef.current[locale];
        if (forLocale && forLocale[imageIndex] === sourceAltText) {
          delete forLocale[imageIndex];
        }
      }
      const outcome = copyOutcomeMessage(failed, { ...(t.common ?? {}), upgradeRequired: String(t.content?.upgradeRequired ?? "") || undefined }, gated);
      showInfoBox(outcome.text, outcome.tone);
    }).finally(() => {
      markOperationFailed(capturedItemId, `altText_${imageIndex}`);
      if (revalidatorRef.current.state === 'idle') {
        try { revalidatorRef.current.revalidate(); } catch {}
      }
    });
  };

  const handleTranslateAltText = (imageIndex: number) => {
    if (!selectedItem) return;
    const image = getImageAtIndex(selectedItem, imageIndex);
    if (!image) return;

    const sourceAltText = image.altText || "";

    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning"
      );
      return;
    }

    // The view the merchant ASKED from: the result is saved there even if they
    // moved on, and only shown while they are still looking at it.
    const requestItemId = selectedItem.id;
    const requestLocale = currentLanguage;
    const requestMarketId = selectedMarketId;

    submitAIAction(
      {
        action: "translateAltText",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle: selectedItem.title || "",
        imageIndex: String(imageIndex),
        sourceAltText,
        targetLocale: requestLocale,
        primaryLocale
      },
      `altText_${imageIndex}`,
      (result) => {
        // Directly apply the translated alt-text (no suggestion box) and save
        // THIS image's alt immediately — and only it.
        if (!result.translatedAltText) return;
        if (selectedItemIdRef.current !== requestItemId) return;
        const translatedAltText = result.translatedAltText as string;
        // The save is answered against the view on screen (its baseline, its
        // mirror of the alt): if the merchant switched language or market
        // meanwhile there is no field for this result any more — say so
        // rather than write it somewhere they are not looking.
        const viewing =
          currentLanguageRef.current === requestLocale && selectedMarketIdRefAlt.current === requestMarketId;
        if (!viewing) {
          showInfoBox(
            String(
              (t.imageManager as Record<string, unknown> | undefined)?.altAiResultDiscarded ??
                "The generated alt text was not applied because you switched language or market.",
            ),
            "warning",
          );
          return;
        }
        setImageAltTexts((prev) => ({ ...prev, [imageIndex]: translatedAltText }));
        submitOwnAltSave({
          itemId: requestItemId,
          locale: requestLocale,
          marketId: requestMarketId,
          alts: { [imageIndex]: translatedAltText },
          fromTranslate: true,
          // Success is reported by the save-response handler once Shopify
          // confirmed the save; a failed save shows its own error instead.
          successToast:
            t.common?.fieldTranslatedAndSaved?.replace("{fieldType}", "Alt-Text") ||
            "Alt-Text translated and saved successfully",
        });
      }
    );
  };

  const handleTranslateAltTextToAllLocales = (imageIndex: number) => {
    if (!selectedItem) return;
    const image = getImageAtIndex(selectedItem, imageIndex);
    if (!image) return;

    // Filter out primary locale and disabled languages
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning"
      );
      return;
    }

    // Backstop for the disabled button: the primary alt is an unsaved draft,
    // and its own Save would purge what this writes into every language.
    if (isPrimaryAltUnsaved(imageIndex)) {
      refuseUnsavedSource();
      return;
    }

    const sourceAltText = imageAltTexts[imageIndex] || image.altText || "";

    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning"
      );
      return;
    }

    submitAIAction(
      {
        action: "translateAltTextToAllLocales",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle: selectedItem.title || "",
        imageIndex: String(imageIndex),
        ...mediaIdField(image),
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
            String(t.content?.altTextPartialLocales || "Alt-text for image {imageNumber} partially translated. Language(s) {failedLocales} could not be saved. Please try again or re-sync.")
              .replace("{imageNumber}", String(imageIndex + 1))
              .replace("{failedLocales}", failedList),
            "warning"
          );
        } else {
          showInfoBox(
            String(t.content?.altTextTranslatedToLanguages || "Alt-text translated to {count} language(s)")
              .replace("{count}", String(successCount)),
            "success"
          );
        }

        // The confirmed translations replace whatever an earlier copy-to-all
        // left in the overlay (it outranks the loaded values), and the open
        // language shows them at once.
        for (const { locale, value } of overlayWritesFromTranslations(translatedAltTexts, failedLocales)) {
          if (!localAltTextOverlayRef.current[locale]) localAltTextOverlayRef.current[locale] = {};
          localAltTextOverlayRef.current[locale][imageIndex] = value;
          if (locale === currentLanguageRef.current && !selectedMarketIdRefAlt.current) {
            setImageAltTexts((prev) => ({ ...prev, [imageIndex]: value }));
            setOriginalAltTexts((prev) => ({ ...prev, [imageIndex]: value }));
          }
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
    const allImages: ContentImage[] = selectedItem?.images?.length > 0
      ? selectedItem.images
      : selectedItem?.featuredImage ? [selectedItem.featuredImage] : [];
    if (!selectedItem || allImages.length === 0) return;

    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning"
      );
      return;
    }

    // Backstop for the disabled button (see handleTranslateAltTextToAllLocales).
    if (hasUnsavedPrimaryAlts()) {
      refuseUnsavedSource();
      return;
    }

    // Collect all source alt texts
    const altTextsData: Record<number, string> = {};
    let hasAnyAltText = false;
    allImages.forEach((img: ContentImage, index: number) => {
      const altText = imageAltTexts[index] || img.altText || "";
      if (altText) {
        altTextsData[index] = altText;
        hasAnyAltText = true;
      }
    });

    if (!hasAnyAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning"
      );
      return;
    }

    submitAIAction(
      {
        action: "translateAllAltTextsToAllLocales",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle: selectedItem.title || "",
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

        // Confirmed values go into the overlay for EVERY locale, so a language
        // switch (or a stale earlier copy) never shows older text.
        if (result.translatedResults) {
          const all = result.translatedResults as Record<string, Record<string, string>>;
          for (const [imgIdxStr, localeMap] of Object.entries(all)) {
            const idx = parseInt(imgIdxStr, 10);
            if (Number.isNaN(idx) || failedImages.includes(idx)) continue;
            for (const { locale, value } of overlayWritesFromTranslations(localeMap, [])) {
              if (!localAltTextOverlayRef.current[locale]) localAltTextOverlayRef.current[locale] = {};
              localAltTextOverlayRef.current[locale][idx] = value;
            }
          }
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
            setImageAltTexts(prev => ({ ...prev, ...translatedForCurrentLocale }));
            // Only the translated indices are saved; anything else stays a draft.
            setOriginalAltTexts(prev => ({ ...prev, ...translatedForCurrentLocale }));
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
    const requestedLocale = currentLanguage;
    const allImages: ContentImage[] = selectedItem?.images?.length > 0
      ? selectedItem.images
      : selectedItem?.featuredImage ? [selectedItem.featuredImage] : [];
    if (!selectedItem || allImages.length === 0) return;

    // Collect all source alt texts from primary locale
    const altTextsData: Record<number, string> = {};
    let hasAnyAltText = false;
    allImages.forEach((img: ContentImage, index: number) => {
      const altText = img.altText || "";
      if (altText) {
        altTextsData[index] = altText;
        hasAnyAltText = true;
      }
    });

    if (!hasAnyAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning"
      );
      return;
    }

    submitAIAction(
      {
        action: "translateAllAltTextsForLocale",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle: selectedItem.title || "",
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
            // Into the overlay too: the language-switch effect rebuilds from the
            // (stale) item, so state alone vanished on the next switch.
            const written = overlayIndexWrites(
              result.translatedAltTexts as Record<string, string>,
              failedImages,
            );
            if (!localAltTextOverlayRef.current[requestedLocale]) {
              localAltTextOverlayRef.current[requestedLocale] = {};
            }
            Object.assign(localAltTextOverlayRef.current[requestedLocale], written);
            if (currentLanguageRef.current === requestedLocale && !selectedMarketIdRefAlt.current) {
              setImageAltTexts(prev => ({ ...prev, ...translated }));
              // Only the translated indices are saved; anything else stays a draft.
              setOriginalAltTexts(prev => ({ ...prev, ...translated }));
            }
            // The server already saved to Shopify and DB; reload so the item
            // (and the missing-translation marker) catch up.
            if (revalidatorRef.current.state === 'idle') {
              try {
                revalidatorRef.current.revalidate();
              } catch (error) {
                debugLog.revalidate(' Error during revalidation (ignored):', error);
              }
            }
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
  };

  const handleAcceptAltTextSuggestion = (imageIndex: number) => {
    const suggestion = altTextSuggestions[imageIndex];
    if (!suggestion || !selectedItemId) return;

    setImageAltTexts((prev) => ({ ...prev, [imageIndex]: suggestion }));
    clearAltTextSuggestion(suggestionScope, imageIndex);

    // Accepting an AI suggestion SAVES it — this image's alt only. The text
    // fields and the other images' typed alts stay drafts for their own Save.
    debugLog.altText('Accepting AI suggestion for image:', imageIndex, 'saving that alt only');
    submitOwnAltSave({
      itemId: selectedItemId,
      locale: currentLanguage,
      marketId: selectedMarketId,
      alts: { [imageIndex]: suggestion },
    });

    // Immediately update the in-memory item so the fallback display
    // (images[index]?.altText) shows the correct value even if imageAltTexts
    // state gets cleared during revalidation cycles. AFTER the save was built:
    // the "did the primary alt change" question reads the item's old value.
    const item = selectedItemRef.current;
    if (currentLanguage === primaryLocale) {
      if (item?.images?.[imageIndex]) {
        item.images[imageIndex].altText = suggestion;
      } else if (imageIndex === 0 && item?.featuredImage) {
        item.featuredImage.altText = suggestion;
      }
    }
  };

  const handleAcceptAndTranslateAltText = (imageIndex: number) => {
    const suggestion = altTextSuggestions[imageIndex];
    if (!suggestion || !selectedItemId) return;

    const item = selectedItemRef.current;
    if (!item) return;

    // Update the UI state
    setImageAltTexts((prev) => ({ ...prev, [imageIndex]: suggestion }));

    clearAltTextSuggestion(suggestionScope, imageIndex);

    // ========================================================================
    // FOREIGN LOCALE PATH
    // The accepted alt-text is in a foreign language `L`. Mirror the text-field
    // fix: keep it EXACTLY in `L`, translate it into the primary language and
    // save that as the base image alt-text (this field only, so no deletion of
    // existing foreign alt-text translations), and translate it into the OTHER
    // foreign locales (source = `L`). Do NOT overwrite the item's base altText
    // with the foreign value.
    // ========================================================================
    if (currentLanguage !== primaryLocale) {
      const L = currentLanguage;
      const requestItemId = selectedItemId;
      const targetOthers = enabledLanguages.filter(l => l !== primaryLocale && l !== L);

      // Persist the accepted foreign alt-text EXACTLY in `L` — this image's
      // alt only (globally, as this flow always has).
      const saveForeignExact = () => {
        submitOwnAltSave({
          itemId: requestItemId,
          locale: L,
          marketId: "",
          alts: { [imageIndex]: suggestion },
          fromTranslate: true,
          // Answered against the view: only while it is still `L` (global)
          // does this save stand for the field on screen.
          viewAltIndices:
            currentLanguageRef.current === L && !selectedMarketIdRefAlt.current ? [imageIndex] : [],
        });
      };

      // Translate the accepted foreign alt-text into the primary language.
      submitAIAction(
        {
          action: "translateAltText",
          itemId: requestItemId,
          productId: item.id,
          productTitle: item.title || "",
          imageIndex: String(imageIndex),
          sourceAltText: suggestion,
          targetLocale: primaryLocale,
          // Server uses `primaryLocale` purely as the SOURCE language.
          primaryLocale: L,
        },
        `altText_${imageIndex}`,
        (result) => {
          if (selectedItemIdRef.current !== requestItemId) return;
          const primaryTranslated = ((result.translatedAltText as string) || "").trim();

          // 1. Save the accepted foreign alt-text exactly in `L`.
          saveForeignExact();

          // 2. Save the primary base alt-text (this image only). It carries NO
          //    `changedAltTextIndices`, which is what keeps it out of the
          //    featured-alt §6.6 purge — that save would otherwise delete the
          //    foreign alt saved one line above and the ones step 3 is about to
          //    write (shopify-content.service.ts, `featuredAltChanged`).
          if (primaryTranslated) {
            // Do NOT set savedLocaleRef to primaryLocale. Save A (locale L) was
            // submitted immediately and this save is queued behind it; the
            // save-response effect reads the single shared savedLocaleRef, and
            // overwriting it to primary would both misprocess save A and write
            // the FOREIGN alt-text (held in imageAltTextsRef) into the primary
            // in-memory image (a leak). The server still persists this as the
            // primary base alt-text via the form `locale` field.
            // Same item as save A, which already claimed it. PARTIAL with no
            // alt index of the `L` view: it writes the PRIMARY alt, so nothing
            // on screen is saved by it.
            submitOwnAltSave({
              itemId: requestItemId,
              locale: primaryLocale,
              marketId: "",
              alts: { [imageIndex]: primaryTranslated },
              markChanged: false,
              fromTranslate: true,
              trackLocale: null,
              viewAltIndices: [],
            });
          }

          // 3. Translate into the OTHER foreign locales directly from `L`.
          if (targetOthers.length > 0) {
            submitAIAction(
              {
                action: "translateAltTextToAllLocales",
                itemId: requestItemId,
                productId: item.id,
                productTitle: item.title || "",
                imageIndex: String(imageIndex),
                ...mediaIdField(item.images?.[imageIndex]),
                sourceAltText: suggestion,
                targetLocales: JSON.stringify(targetOthers),
                primaryLocale: L,
              },
              `altText_${imageIndex}`,
              () => {
                if (revalidatorRef.current.state === 'idle') {
                  try { revalidatorRef.current.revalidate(); } catch {}
                }
              }
            );
          }
        },
        () => {
          // Translating into the primary language failed — still keep the
          // accepted foreign alt-text saved.
          if (selectedItemIdRef.current !== requestItemId) return;
          saveForeignExact();
        }
      );
      return;
    }

    // ========================================================================
    // PRIMARY LOCALE PATH (unchanged)
    // ========================================================================
    // Immediately update the in-memory item so the fallback display
    // (images[index]?.altText) shows the correct value even if imageAltTexts
    // state gets cleared during revalidation cycles.
    if (item.images?.[imageIndex]) {
      item.images[imageIndex].altText = suggestion;
    }

    // Check target locales first
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesEnabled || "No target languages enabled",
        "warning"
      );
      // No translations needed, just save this primary alt directly.
      submitOwnAltSave({
        itemId: selectedItemId,
        locale: primaryLocale,
        marketId: "",
        alts: { [imageIndex]: suggestion },
      });
      return;
    }



    debugLog.altText('Saving primary alt-text first, then will translate to all locales');

    // Step 1: Save the primary alt-text first — this image's alt only, and
    // without `changedAltTextIndices`: step 2 writes its translations, which a
    // purge of the same save would otherwise delete.
    submitOwnAltSave({
      itemId: selectedItemId,
      locale: primaryLocale,
      marketId: "",
      alts: { [imageIndex]: suggestion },
      markChanged: false,
    });

    // Step 2: Translate to all locales
    safeSubmit({
      action: "translateAltTextToAllLocales",
      productId: item.id,
      imageIndex: String(imageIndex),
      ...mediaIdField(item.images?.[imageIndex]),
      sourceAltText: suggestion,
      targetLocales: JSON.stringify(targetLocales)
    }, { method: "POST" });
  };

  const handleRejectAltTextSuggestion = useCallback((imageIndex: number) => {
    clearAltTextSuggestion(suggestionScope, imageIndex);
  }, [suggestionScope]);

  // Reset alt-text state when the selected item changes. AI suggestions are
  // NOT reset here any more: they are keyed by item + locale + market in the
  // global store, so another item's suggestions are simply out of scope —
  // and clearing on arrival would delete the very ones the merchant came back
  // for.
  useEffect(() => {
    setImageAltTexts({});
    setOriginalAltTexts({});
    localAltTextOverlayRef.current = {};
  }, [selectedItemId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load translated alt-texts when language changes — and once more after a
  // background re-translation was reloaded (`backgroundRefreshVersion`).
  const lastAltRefreshVersionRef = useRef(backgroundRefreshVersion);
  useEffect(() => {
    const item = selectedItemRef.current;
    const isBackgroundRefresh = lastAltRefreshVersionRef.current !== backgroundRefreshVersion;
    lastAltRefreshVersionRef.current = backgroundRefreshVersion;
    // What the merchant typed and has not saved, captured BEFORE the reset
    // below: the refresh only starts on a clean editor, but a keystroke can
    // land between that decision and this pass, and it must survive.
    const unsavedAltEdits: Record<number, string> = {};
    if (isBackgroundRefresh) {
      const current = imageAltTextsRef.current;
      const original = originalAltTextsRef.current;
      for (const [index, value] of Object.entries(current)) {
        if (value !== (original[Number(index)] ?? "")) unsavedAltEdits[Number(index)] = value;
      }
      // The server has just rewritten these languages; a staged overlay entry
      // would otherwise keep winning over the fresh loader value. The overlay
      // only ever holds values that were already saved (the refresh waits for
      // an idle fetcher), so the loader data carries them too.
      localAltTextOverlayRef.current = {};
    }
    if (!item) return;

    const allImages: ContentImage[] = item.images?.length > 0
      ? item.images
      : item.featuredImage ? [item.featuredImage] : [];
    if (allImages.length === 0) return;

    if (currentLanguage === primaryLocale) {
      // A background refresh re-translated FOREIGN languages only; the primary
      // view resolves from the item itself and its state holds nothing but the
      // merchant's own edits, which a reset here would throw away.
      if (isBackgroundRefresh) return;
      // Reset to primary locale alt-texts - fallback will use images[i].altText
      setImageAltTexts({});
      setOriginalAltTexts({});
      setFallbackAltTextIndices(new Set());
    } else {
      // Load translated alt-texts. When a market is selected, prefer the
      // market-specific value (overlay then DB); if absent, fall back to the
      // global value — mirroring the storefront + the main resolve() chain. When
      // no market is selected, this reduces to the original global-only lookup.
      const translatedAltTexts: Record<number, string> = {};
      // Indices showing a market-inherited (global) value — greyed out in the UI.
      const fallbackIndices = new Set<number>();
      const marketOverlay = selectedMarketId
        ? (localAltTextOverlayRef.current[buildLocaleKey(currentLanguage, selectedMarketId)] || {})
        : {};
      const globalOverlay = localAltTextOverlayRef.current[currentLanguage] || {};
      allImages.forEach((img: ContentImage, index: number) => {
        // 1. Market layer (overlay → DB)
        if (selectedMarketId) {
          if (marketOverlay[index] !== undefined) {
            translatedAltTexts[index] = marketOverlay[index];
            return;
          }
          const marketDb = img.altTextTranslations?.find(
            (t) => t.locale === currentLanguage && (t.marketId ?? "") === selectedMarketId
          );
          if (marketDb) {
            translatedAltTexts[index] = marketDb.altText;
            return;
          }
        }
        // 2. Global layer (overlay → DB). With a market selected this value is
        //    inherited from global → flag it as a fallback so the UI greys it.
        let globalVal: string | undefined;
        if (globalOverlay[index] !== undefined) {
          globalVal = globalOverlay[index];
        } else {
          const globalDb = img.altTextTranslations?.find(
            (t) => t.locale === currentLanguage && (t.marketId ?? "") === ""
          );
          if (globalDb) globalVal = globalDb.altText;
        }
        if (globalVal !== undefined) {
          translatedAltTexts[index] = globalVal;
          if (selectedMarketId && globalVal.trim() !== "") fallbackIndices.add(index);
        }
      });
      // The BASELINE is the server value; a preserved edit stays dirty against
      // it, so it can still be saved.
      setOriginalAltTexts({ ...translatedAltTexts });
      setImageAltTexts({ ...translatedAltTexts, ...unsavedAltEdits });
      setFallbackAltTextIndices(fallbackIndices);
    }
  }, [currentLanguage, selectedMarketId, selectedItemId, primaryLocale, backgroundRefreshVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    // State
    imageAltTexts,
    setImageAltTexts,
    fallbackAltTextIndices,
    altTextSuggestions,
    originalAltTexts,
    setOriginalAltTexts,
    imageAltTextsRef,
    originalAltTextsRef,
    pendingAltTextAutoSaveRef,
    // Exposed so a PRIMARY save can drop what the server just deleted: the
    // overlay is checked BEFORE the loaded item, so without this it keeps
    // rendering a foreign alt text that no longer exists for the rest of the
    // session — and a save from that view writes it back.
    localAltTextOverlayRef,
    selectedImageIndex,
    setSelectedImageIndex,
    // Handlers
    handleAltTextChange,
    handleGenerateAltText,
    handleGenerateAllAltTexts,
    handleAcceptAltText: handleAcceptAltTextSuggestion,
    handleRejectAltText: handleRejectAltTextSuggestion,
    handleCopyAltText,
    handleCopyAltTextToAllLocales,
    pendingCopyAltTextIndexRef,
    rollbackCopyAltText,
    discardCopyAltRecord,
    altBaselineSnapshot,
    getPendingCopyAltItemId,
    handleTranslateAltText,
    handleTranslateAltTextToAllLocales,
    handleTranslateAllAltTexts,
    handleTranslateAllAltTextsForLocale,
    handleAcceptAltTextSuggestion,
    handleAcceptAndTranslateAltText,
    handleRejectAltTextSuggestion,
    isPrimaryAltUnsaved,
    hasUnsavedPrimaryAlts,
  };
}
