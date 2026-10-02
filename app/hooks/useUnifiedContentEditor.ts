/**
 * Unified Content Editor Hook
 *
 * Based on the products page implementation with all bug fixes.
 * Provides a complete state management and handler system for content editing.
 */

import { isThemeContentType } from "~/utils/content-type-groups";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useBackgroundTaskRefresh } from "./useBackgroundTaskRefresh";
import { readRetranslationTaskIds } from "../services/translations/retranslation-tasks.shared";
import { useRevalidator } from "react-router";
import { getTranslatedValue } from "../utils/contentEditor.utils";
import { useEditorImageManagement } from "./useEditorImageManagement";
import { useEditorChangeDetection } from "./useEditorChangeDetection";
import { useItemFocus } from "./useFocusManagement";
import { useLatestRef } from "./useLatestRef";
import { useUiDataLoader, getItemFieldValue, buildLocaleKey, buildDeletedKey, preserveUnsavedEdits } from "./useUiDataLoader";
import type { PartialSave } from "./useUiDataLoader";
import { dropSavedFieldsFromFallbackSnapshot, type LoadedFallbackSnapshot } from "../services/editor/discard-fallback.shared";
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
  InfoBoxTone,
} from "../types/content-editor.types";
import { debugLog } from "../utils/debug";
import type { ValidationOverlays } from "../utils/field-validation.utils";
import { markRecentlySaved } from "../utils/translation-timing";
import { extractReadableName } from "../utils/templates-field-factory";
import { useTaskCount } from "../contexts/TaskCountContext";
import { translateErrorMessage } from "../utils/editor-error-messages";
import { readLastSelectedId } from "../utils/last-selected-item";
import { readLastContentLocale, pickRestoredLocale, resolveInitialLocale } from "../utils/last-content-locale";
import { buildRedirectMessage, redirectNoteOf } from "../utils/handle-redirect-message";
import { partialLocaleCounts } from "../services/translations/partial-result.shared";
import { isTranslatableFieldDefinition } from "../services/content-attributes.shared";
import { restrictAltBaseline, buildOwnSaveForm, isUnsavedPrimarySource, altValuesForSaveResponse, revertAltsWithoutPrimary, sentAltsFromForm, sentFieldsFromForm, saveAnswerViewMoved, type SentSaveScope } from "../services/editor/own-field-save.shared";
import { settleOwnSave, settleUnsentSave, backstopOwnSaves, hasOwnSaveInFlight, type OwnSaveInFlight } from "../services/editor/own-save-in-flight.shared";
import { unconfirmedClearedFieldSet, unconfirmedClearedOnlyKeys, keepFailedAltsDirty, unconfirmedFieldsMessage, hasPurgeUnconfirmedWarning, purgeWarningConcernsOtherFields } from "../services/editor/unconfirmed-cleared.shared";
import { useFieldHandlers } from "./useFieldHandlers";
import { appFetch, appFetchJson } from "../utils/app-fetch";
import { isMarkedDeleted, buildLocaleDeletedKey, dropLocaleMarks } from "../services/editor/deleted-translation-marks.shared";
import { CONTENT_EDITOR_ACTION_ENDPOINT, contentEditorActionPage, setContentEditorPage } from "../services/editor/content-action-endpoint.shared";
import {
  markOperationActive,
  markOperationCompleted,
  markOperationFailed,
  isOperationActive,
  taskOperationKey,
  taskShowsInView,
  TRANSLATE_RUN_DEADLINE_MS,
  reconcileWithServer,
  useLoadingFieldKeys as useGlobalLoadingFieldKeys,
  useCompletedResults,
  consumeCompletedResult,
} from "./useAIOperationsStore";
import {
  setFieldSuggestion,
  setAltTextSuggestion,
  useFieldSuggestions,
  type SuggestionScope,
} from "./useAISuggestionStore";

/**
 * Whether a "translate all" run blocks a save of (item, locale): a run writing
 * into that language, or ANY run of the item for the primary language (a
 * primary save purges or re-translates every language).
 */
export function ownSaveBlockedByRuns(
  runs: ReadonlyArray<{ itemId: string | null; locale: string }>,
  itemId: string | null,
  locale: string | null,
  primaryLocale: string,
): boolean {
  if (!itemId) return false;
  return runs.some((run) => run.itemId === itemId && (locale === primaryLocale || run.locale === "*" || run.locale === locale));
}

/** Whether a sent-request scope is a SAVE of `itemId`. */
function isSaveScopeOf(scope: SentSaveScope | null | undefined, itemId: string | null): boolean {
  const fields = scope?.sentFields;
  return !!itemId && fields?.action === "updateContent" && fields.itemId === itemId;
}

/** The translation keys of the fields a primary save's form named as changed. */
function changedTranslationKeysOf(
  sentFields: Record<string, string> | undefined,
  fieldDefinitions: Array<{ key: string; translationKey?: string }>,
): string[] {
  const raw = sentFields?.changedFields;
  if (!raw) return [];
  let changed: unknown;
  try { changed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(changed)) return [];
  return fieldDefinitions
    .filter((f) => changed.includes(f.key) && !!f.translationKey)
    .map((f) => f.translationKey as string);
}

interface TaskData {
  fieldType?: string | null;
  targetLocale?: string | null;
  type?: string | null;
}

export function useUnifiedContentEditor(props: UseContentEditorProps): UseContentEditorReturn {
  const { config, items, shopLocales, primaryLocale, fetcher, showInfoBox, t, onTranslateToAllLocalesComplete, onCopyToAllLocalesFailed, initialItemId, initialLocale } = props;
  // Markets for the "Translate & Adapt" market selector. Empty when the shop has
  // no extra markets or the read_markets scope is missing → selector stays hidden.
  const markets = props.markets ?? [];
  const { refresh: refreshTaskCount } = useTaskCount();
  const revalidator = useRevalidator();
  // IMPORTANT: useRevalidator() returns an unstable reference that changes on
  // every React Router state change (including Shopify Admin SDK analytics).
  // Using the object directly in effect deps causes infinite re-renders.
  // Always use this ref inside effects instead.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  // Read by requests that answer after the render they were sent from.
  // "Translate all" runs on their own requests (submitTranslateRun) that are
  // still out: a save they could race waits for them (see
  // `saveBlockedByTranslateRunRef` in useEditorAutoSave and the queue drain).
  const primaryLocaleRef = useLatestRef(primaryLocale);
  const translateRunsRef = useRef<Array<{ itemId: string | null; locale: string }>>([]);
  const ownSaveBlockedByRun = (itemId: string | null, locale: string | null): boolean =>
    ownSaveBlockedByRuns(translateRunsRef.current, itemId, locale, primaryLocaleRef.current);
  const [translateRunsVersion, setTranslateRunsVersion] = useState(0);
  // Held back: by a run writing into the save's language (a PRIMARY save by
  // any run of the item), or by a PRIMARY save of the item queued ahead of it
  // -- that one's purge (or re-translation) must not land after, and wipe, a
  // translation saved later. `beforeIndex` = the entry's own queue position
  // (the drain); a new save looks at the whole queue.
  const saveBlockedByTranslateRunRef = useRef((locale: string | null, itemId: string | null, beforeIndex?: number): boolean => {
    if (ownSaveBlockedByRun(itemId, locale)) return true;
    const queue = saveQueueRef.current;
    const limit = beforeIndex ?? queue.length;
    for (let j = 0; j < limit; j++) {
      if (queue[j].savedItemId === itemId && queue[j].savedLocale === primaryLocaleRef.current) return true;
    }
    return false;
  });
  /** An operation key of a run this client still awaits (reconcile must not
   *  drop it before the server's Task row exists). */
  const keepRunOperation = (itemId: string) => (fieldKey: string) =>
    translateRunsRef.current.some(
      (run) =>
        run.itemId === itemId &&
        (run.locale === "*" ? fieldKey === "__translateAll__" : fieldKey === `__translateAllForLocale__${run.locale}`),
    );
  const showInfoBoxRef = useLatestRef(showInfoBox);
  const tRef = useLatestRef(t);
  /**
   * THE rule for an AI/copy button's own save while a "translate all" run of
   * the item is out (the same rule `saveBlockedByTranslateRunRef` holds a
   * Save-bar save by). Every own-save caller asks `refuseOwnSave` at its very
   * START -- before any baseline, cache, overlay, mark, item mutation or
   * toast -- and changes nothing on a refusal (an AI result that already
   * arrived goes into the field as a plain draft). `safeSubmit` refusing it is
   * only the backstop (`ownSaveRunBackstop`).
   */
  const refuseOwnSave = (itemId: string | null, locale: string): boolean => {
    if (!ownSaveBlockedByRun(itemId, locale)) return false;
    const isPrimary = locale === primaryLocaleRef.current;
    showInfoBoxRef.current(
      isPrimary
        ? String(tRef.current?.common?.ownSaveRefusedWhileItemTranslating || "A translation of this item is still running \u2013 the change stays unsaved. Save it when the translation has finished.")
        : String(tRef.current?.common?.ownSaveRefusedWhileTranslating || "A translation into this language is still running \u2013 the change stays unsaved. Save it when the translation has finished."),
      "info",
    );
    return true;
  };
  /** A save waits for a "translate all" run: say so, or the merchant sees a
   *  spinner with no reason for minutes. */
  const onSaveHeldByRunRef = useRef(() => {
    showInfoBoxRef.current(
      String(tRef.current?.common?.saveWaitsForTranslation || "Waiting until the translation has finished \u2013 then it is saved."),
      "info",
    );
  });
  const configRef = useLatestRef(config);

  // ============================================================================
  // FOCUS MANAGEMENT (Accessibility)
  // ============================================================================

  const { firstFieldRef, setItemFocus } = useItemFocus(null);

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  // SSR-safe: initial state is always null. The restore effect below reads
  // localStorage on the client once `items` are available and picks the right
  // item (initialItemId > localStorage > items[0]). Reading localStorage in the
  // useState initializer would run during server render where it throws/returns
  // null, and that null would be reused on hydration — causing the auto-select
  // fallback to overwrite the persisted value before we ever got to read it.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [hasRestored, setHasRestored] = useState(false);
  // `shopLocales` comes from the route loader, so it is already populated on
  // mount — the deep-linked locale can be validated right here instead of via
  // a late-resolution effect (which would fight the user's first click).
  const [currentLanguage, setCurrentLanguage] = useState(() =>
    resolveInitialLocale(initialLocale, primaryLocale, shopLocales),
  );
  const currentLanguageRef = useLatestRef(currentLanguage);
  // Selected market for market-specific translations ("" = all markets / global).
  const [selectedMarketId, setSelectedMarketId] = useState<string>("");
  const [editableValues, setEditableValues] = useState<Record<string, string>>({});
  // AI suggestions live OUTSIDE this component (useAISuggestionStore): they
  // used to be `useState` here, so leaving the page — a main-nav tab, another
  // item — threw away an answer the merchant had already paid for and never
  // decided on. The scope is what makes that safe: a suggestion belongs to one
  // field of one item in one locale under one market, so coming back shows
  // exactly the ones that were pending, and no others.
  const suggestionScope = useMemo<SuggestionScope>(
    () => ({ resourceId: selectedItemId || "", locale: currentLanguage, marketId: selectedMarketId }),
    [selectedItemId, currentLanguage, selectedMarketId],
  );
  const suggestionScopeRef = useLatestRef(suggestionScope);
  // The scope the route-action fetcher was LAST submitted in. The handlers
  // below capture their own request scope in a closure; a fetcher response
  // has no closure to capture, so the scope is taken at submit time — the
  // merchant may have switched language while it was in flight, and the
  // answer belongs to the language they asked from.
  const fetcherScopeRef = useRef<SuggestionScope | null>(null);
  const aiSuggestions = useFieldSuggestions(suggestionScope);
  const [htmlModes, setHtmlModes] = useState<Record<string, 'html' | 'rendered'>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [enabledLanguages, setEnabledLanguages] = useState<string[]>(
    shopLocales.map((l) => l.locale)
  );
  // Track if we're in the middle of an accept-and-translate flow to prevent immediate deletion
  const [isAcceptAndTranslateFlow, setIsAcceptAndTranslateFlow] = useState(false);
  const isAcceptAndTranslateFlowRef = useLatestRef(isAcceptAndTranslateFlow);
  // Track if we're currently loading data to prevent false change detection.
  // selectedItemId starts null on mount (SSR-safe), but if items already
  // exist, the restore effect will pick one synchronously after first paint
  // and the data-loader effect will set this to true. Initialize true when
  // items are available so the brief window before restoration doesn't show
  // a stale "not loading" state on client-side mounts where the previous
  // implementation started true.
  const [isLoadingData, setIsLoadingData] = useState(items.length > 0);
  // Track save-in-progress for spinner — fetcher.state is unreliable due to React 18 batching
  const [isSaving, setIsSaving] = useState(false);
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
      baselineValuesRef,
      selectedMarketIdRef,
    },
    templateValuesVersion,
    setTemplateValuesVersion,
    baselineVersion,
    setBaselineVersion,
  } = dataLoader;

  // Keep the data loader's market ref in sync so resolve()/transitions see the
  // current market synchronously (updated on render, before any effect runs).
  selectedMarketIdRef.current = selectedMarketId;

  // Track which fields are showing fallback values (e.g., handle field showing primary locale value)
  // This happens when Shopify doesn't return a translation because it's identical to the primary value
  const [fallbackFields, setFallbackFields] = useState<Set<string>>(new Set());

  const fallbackFieldsRef = useLatestRef(fallbackFields);
  const loadedFallbackRef = useRef<LoadedFallbackSnapshot | null>(null);

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
        // appFetch: carries the session token (a bare fetch got the App
        // Bridge bounce page instead of JSON).
        const response = await appFetch(
          `/api/running-field-tasks?resourceId=${encodeURIComponent(selectedItemId)}`
        );
        if (!response.ok || cancelled) return;
        const data = await response.json();

        // What the server says is running, in ANY language: only those keys
        // survive the reconcile. A per-language run is its own key
        // (`taskOperationKey`), so it is never confused with another
        // language's or with "translate all".
        const mappedTasks: TaskData[] =
          (data.tasks as TaskData[] || []).filter((task) => !!taskOperationKey(task));
        const serverFieldKeys = new Set(mappedTasks.map((t) => taskOperationKey(t)!));
        // Only what belongs to the view on screen is SEEDED: a French field
        // translation must not spin (and block) that field in German.
        const lang = currentLanguageRef.current;
        const activeTasks = mappedTasks.filter((task) =>
          taskShowsInView(task, taskOperationKey(task)!, lang, primaryLocale),
        );

        // Seed any server-side tasks that aren't in the global store yet
        for (const task of activeTasks) {
          const fk = taskOperationKey(task)!;
          if (isOperationActive(selectedItemId, fk)) continue;
          const perLocale = fk.startsWith("__translateAllForLocale__");
          markOperationActive(
            selectedItemId,
            fk,
            perLocale ? "translateAllForLocale" : fk === "__translateAll__" ? "translateAll" : "server-task",
            perLocale ? task.targetLocale || undefined : undefined,
          );
        }

        // Clear global store entries that the server says are no longer running
        reconcileWithServer(selectedItemId, serverFieldKeys, keepRunOperation(selectedItemId));

        // Polled while ANY mapped task runs (another language's included):
        // its completion still has to bring the reload, only its spinner is
        // not seeded here.
        if (mappedTasks.length === 0 || cancelled) return;

        // Poll until all running tasks finish
        const pollUntilDone = async (remaining: Set<string>) => {
          if (cancelled || remaining.size === 0) return;
          await new Promise((res) => setTimeout(res, 2000));
          if (cancelled) return;

          try {
            const r2 = await appFetch(
              `/api/running-field-tasks?resourceId=${encodeURIComponent(selectedItemId)}`
            );
            if (!r2.ok || cancelled) return;
            const d2 = await r2.json();

            const stillRunning = new Set<string>(
              ((d2.tasks as TaskData[]) || [])
                .map((t) => taskOperationKey(t))
                .filter((k): k is string => !!k)
            );

            // Reconcile: clear anything the server says is done
            reconcileWithServer(selectedItemId, stillRunning, keepRunOperation(selectedItemId));

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
      // The locale/market the request was made from. Missing only for an
      // operation started before this was carried through — the scope the
      // merchant is in now is the best answer there, and the wrong one is
      // simply not shown rather than written anywhere.
      const resultScope: SuggestionScope = {
        resourceId: completed.resourceId,
        locale: result.scope?.locale ?? suggestionScopeRef.current.locale,
        marketId: result.scope?.marketId ?? suggestionScopeRef.current.marketId,
      };

      // Apply based on action type
      if (completed.action === "generateAIText" || completed.action === "formatAIText") {
        // Park AI suggestion for user to accept/reject
        const generatedContent = data.generatedContent as string;
        const fieldType = data.fieldType as string;
        if (generatedContent && fieldType) {
          setFieldSuggestion(resultScope, fieldType, generatedContent);
        }
      }
      // The keyword pass answers per field under `value`, and the alt-text
      // generator per image index. Both used to be consumed here and then
      // dropped on the floor — the merchant navigated away mid-request and the
      // answer they had paid for never appeared anywhere.
      if (completed.action === "insertKeyword") {
        const value = data.value as string;
        const fieldType = (data.fieldType as string) || completed.fieldKey;
        if (value && fieldType && !data.skipped) {
          setFieldSuggestion(resultScope, fieldType, value);
        }
      }
      if (completed.action === "generateAltText") {
        const altText = data.altText as string;
        const imageIndex = data.imageIndex as number | undefined;
        if (altText && typeof imageIndex === "number") {
          setAltTextSuggestion(resultScope, imageIndex, altText);
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
  // RESTORE SELECTION ON MOUNT (client-only, once)
  // Priority: initialItemId (URL param) > localStorage > items[0] fallback.
  // Runs exactly once per mount as soon as `items` is non-empty.
  //
  // Writes to localStorage are NOT made here — only handleItemSelect (the
  // user-action handler) persists. A restore-write or fallback-write would
  // mean any transient missing-from-list state (mid-resync, plan-cap, lazy
  // batch) clobbers the user's saved id when the disappear-effect below
  // re-selects items[0]. By keeping writes user-initiated, the saved id
  // survives transient list anomalies and only changes when the user
  // explicitly clicks something.
  // ============================================================================

  useEffect(() => {
    if (hasRestored) return;
    if (items.length === 0) return;

    if (initialItemId && items.find(i => i.id === initialItemId)) {
      setSelectedItemId(initialItemId);
      appliedInitialItemIdRef.current = initialItemId;
      setHasRestored(true);
      return;
    }

    const saved = readLastSelectedId(config.contentType);
    if (saved && items.find(i => i.id === saved)) {
      setSelectedItemId(saved);
      setHasRestored(true);
      return;
    }

    // Fallback: no usable stored or URL-provided ID — pick the first item.
    setSelectedItemId(items[0].id);
    setHasRestored(true);
  }, [hasRestored, items, initialItemId, config.contentType]);

  // ============================================================================
  // RESTORE THE WORKING LANGUAGE ON MOUNT (client-only, once)
  // Priority: ?locale= (handled in the useState initializer above) > the last
  // language the merchant SWITCHED to > the primary locale.
  //
  // Why an effect and not that initializer: localStorage does not exist during
  // the server render, so a value read there would be `null` on the server and
  // a locale on the client — a hydration mismatch. The item restore above
  // solves the same problem the same way.
  //
  // Only a locale the shop still PUBLISHES is restored. An empty `shopLocales`
  // means the lookup failed rather than "one language" (see CLAUDE.md), so it
  // restores nothing: opening in a language that may no longer be served is
  // the more expensive of the two errors. Nothing is written back here — the
  // language bar's own handler is the only writer.
  // ============================================================================

  const restoredLocaleRef = useRef(false);

  useEffect(() => {
    if (restoredLocaleRef.current) return;
    restoredLocaleRef.current = true;

    const restored = pickRestoredLocale({
      initialLocale,
      stored: readLastContentLocale(),
      primaryLocale,
      shopLocales,
    });
    if (restored) setCurrentLanguage(restored);
  }, [initialLocale, primaryLocale, shopLocales]);

  // ============================================================================
  // AUTO-SELECT FIRST ITEM if the selected one disappears (e.g. deleted, or
  // temporarily missing during a revalidation). Only runs after restoration
  // is complete. Does NOT touch localStorage — the saved id stays intact so
  // a transient absence doesn't permanently destroy the user's selection.
  // ============================================================================

  useEffect(() => {
    if (!hasRestored) return;
    if (items.length === 0) return;
    if (selectedItemId && items.find(i => i.id === selectedItemId)) return;
    setSelectedItemId(items[0].id);
  }, [hasRestored, items, selectedItemId]);

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
  // `t` reaches the builder because a DYNAMIC field's label and help text are
  // built here and nowhere else — the metaobject list hint used to be an
  // English literal in the config for exactly that reason, with no other place
  // to put it. Same optional-`t` shape `getSubtitle` / `getPrimaryField`
  // already carry, so a config that does not need it stays unchanged.
  const effectiveFieldDefinitions = useMemo(() => {
    if (config.dynamicFields && config.getFieldDefinitions && selectedItem) {
      return config.getFieldDefinitions(selectedItem, t);
    }
    return config.fieldDefinitions;
  }, [config.dynamicFields, config.getFieldDefinitions, config.fieldDefinitions, selectedItem, t]);

  const effectiveFieldDefinitionsRef = useLatestRef(effectiveFieldDefinitions);

  // A save that stored only part of what was typed names the fields by their
  // LABELS in the merchant's language (never by translation keys). Plain
  // function over the latest render's `t` and field definitions.
  const localizedUnconfirmedFields = (data: unknown): string => {
    const labels = (t.content?.fieldLabels ?? {}) as Record<string, string>;
    return unconfirmedFieldsMessage(
      data,
      (key) => labels[key] || effectiveFieldDefinitionsRef.current.find((f) => f.key === key)?.label || key,
      {
        unconfirmed: String(
          t.content?.unconfirmedFieldsWarning ||
            "Shopify did not confirm storing: {fields}. These fields were NOT saved - your text is still in the fields, please try again.",
        ),
        skipped: String(
          t.content?.skippedFieldsSamePrimary ||
            "Not saved: {fields} is identical to the main language. A translated URL needs a different value.",
        ),
      },
    );
  };

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

  // Unsaved-change guarding is handled by the native Shopify save bar
  // (confirmNavigation) at the point of locale/item switching in useFieldHandlers.

  // ============================================================================
  // LOAD ITEM DATA (when item or language changes)
  // ============================================================================

  // Track previous language to detect language changes
  const prevCurrentLanguageRef = useRef<string>(currentLanguage);
  // Tracks the market the data-loading effect last resolved for. A market switch
  // re-resolves all fields (same as a locale switch) without a server round-trip.
  const prevSelectedMarketIdRef = useRef<string>(selectedMarketId);

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
  // Market a save was SUBMITTED under (pinned at submit time, like savedLocaleRef).
  // The alt-text onSaveComplete mirror must tag rows with the submitted market —
  // NOT the live selectedMarketId, which may differ if the save was global (bulk /
  // Accept & Translate) or the user switched market mid-save.
  const savedMarketIdRef = useRef<string>("");

  // Ref to track the ITEM ID that was active when the save was initiated.
  // Allows response handlers to detect if the user navigated away before
  // the save response arrived and avoid applying stale state to the wrong item.
  const savedItemIdRef = useRef<string | null>(null);

  // FIFO queue for saves when the fetcher is already in-flight.
  const saveQueueRef = useRef<Array<{
    formData: FormData;
    options: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" };
    savedLocale: string | null;
    savedMarketId: string;
    savedItemId: string | null;
    partial: PartialSave | null;
    successToast: string | null;
  }>>([]);

  const editableValuesRef = useLatestRef(editableValues);

  // Ref to track whether a save operation is actually pending
  const isSavePendingRef = useRef(false);
  // Ref to suppress the generic "Changes saved" toast when triggered by translate action
  const isSaveFromTranslateRef = useRef(false);
  /** The fields a PARTIAL save carried (a single-field translate / Accept &
   *  Translate). The response handling then treats only these as saved: the
   *  overlay and the baseline must not absorb unsaved input in other fields. */
  const partialSaveRef = useRef<PartialSave | null>(null);
  /** The partial description of the save IN FLIGHT — bound per request by
   *  `safeSubmit` and the queue drain, consumed by that request's response. */
  const inFlightPartialRef = useRef<PartialSave | null>(null);
  /** Locale, market and alt texts of the save IN FLIGHT (full or partial),
   *  bound at submit time beside `inFlightPartialRef`. */
  const inFlightScopeRef = useRef<SentSaveScope | null>(null);

  /** The saves of the selected item that are out (in flight on the fetcher)
   *  or waiting in the queue, with the form fields each carries. */
  const savesOfItemOut = (itemId: string | null): Array<{ locale: string; marketId: string; fields: Record<string, string> }> => {
    if (!itemId) return [];
    const out: Array<{ locale: string; marketId: string; fields: Record<string, string> }> = [];
    // In flight = the fetcher is really carrying a request right now AND the
    // request it was handed last is a save of this item. Never read off
    // `isSavePendingRef`, which a refused, aborted or held save can leave set
    // while the scope still describes an earlier, answered request.
    const scope = inFlightScopeRef.current;
    const fetcherBusy = fetcherRef.current.state === "submitting" || justSubmittedRef.current;
    if (fetcherBusy && scope && isSaveScopeOf(scope, itemId)) {
      out.push({ locale: scope.locale, marketId: scope.marketId ?? "", fields: scope.sentFields ?? {} });
    }
    for (const entry of saveQueueRef.current) {
      if (entry.savedItemId !== itemId) continue;
      if (entry.formData.get("action") !== "updateContent") continue;
      out.push({
        locale: entry.savedLocale ?? "",
        marketId: entry.savedMarketId ?? "",
        fields: sentFieldsFromForm(entry.formData.entries()),
      });
    }
    return out;
  };

  /** The "deleted" marks a save that is out or queued stands behind (its
   *  answer settles them): a discard, a switch or a background refresh must
   *  not take them. A primary save stands behind the LAYER marks of the
   *  fields it carries, a foreign one behind its own locale marks. */
  const deletedMarksOfSavesOut = (): ReadonlySet<string> => {
    const keep = new Set<string>();
    for (const save of savesOfItemOut(selectedItemIdRef.current)) {
      for (const field of effectiveFieldDefinitionsRef.current) {
        if (!field.translationKey || !(field.key in save.fields)) continue;
        if (save.locale === primaryLocaleRef.current) keep.add(field.translationKey);
        else keep.add(buildLocaleDeletedKey(field.translationKey, save.marketId, save.locale));
      }
    }
    return keep;
  };

  /**
   * A "translate all" run (its own request) must not race a save of the same
   * item that is still out or queued: a "clear all" pressed a moment before
   * would land its removals AFTER the run's registrations and leave the
   * language empty on Shopify while the editor shows the AI text. Refused,
   * never queued -- the same rule as a switch during an own save.
   */
  const refuseTranslateRun = (itemId: string, locale: string): boolean => {
    const touches = (savedLocale: string) =>
      locale === "*" || savedLocale === locale || savedLocale === primaryLocaleRef.current;
    if (!savesOfItemOut(itemId).some((save) => touches(save.locale))) return false;
    showInfoBoxRef.current(
      String(tRef.current?.common?.translateWhileSaving || "Still saving \u2013 please wait a moment and then translate again."),
      "info",
    );
    return true;
  };
  /**
   * AI/copy buttons' own saves that have been submitted and not answered yet
   * (own-save-in-flight.shared.ts). The change detection reads it so the value
   * such a save is writing does not light the save bar as a draft — the owner's
   * rule is that those buttons SAVE, and a bar standing over a product save
   * for its whole round trip reads as "it did not save".
   */
  const [ownSavesInFlight, setOwnSavesInFlight] = useState<OwnSaveInFlight[]>([]);
  /** The answer to `partial` landed (or will never be applied): stop covering it. */
  const settleOwnSaveFor = useCallback((partial: PartialSave | null) => {
    if (!partial) return;
    setOwnSavesInFlight((prev) => settleOwnSave(prev, partial));
  }, []);
  /**
   * The cover above hides an own save from `hasChanges`, so the switch guards
   * (item, language, market) would not ask while one is on its way. They
   * REFUSE instead (own-save-in-flight.shared.ts, `hasOwnSaveInFlight`): read
   * through a ref so a click handler sees the list as it is NOW.
   */
  const ownSavesInFlightRef = useLatestRef(ownSavesInFlight);
  const isOwnSaveInFlight = useCallback(
    () => hasOwnSaveInFlight(ownSavesInFlightRef.current),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  /** Success text of a translate-and-save, STAGED by the caller right before
   *  `safeSubmit` and bound there to its own request (queue entry or in-flight
   *  slot), like `partialSaveRef`: a shared slot let an earlier unrelated save's
   *  answer take it. */
  const pendingAltTranslateToastRef = useRef<string | null>(null);
  const inFlightToastRef = useRef<string | null>(null);
  /** After a partial save the re-read that follows must keep unsaved input in
   *  the fields it did not carry (they were not sent, so the server has only
   *  their old values). Time-boxed, and dropped on any switch. */
  const preserveEditsUntilRef = useRef(0);
  // Fields whose save was NOT confirmed by Shopify: they stay dirty against a
  // restored baseline, so ANY reload of the same item/locale/market keeps their
  // typed text (not just one inside a time window). Dropped on a switch and on
  // the next save response.
  const unconfirmedKeptKeysRef = useRef<Set<string>>(new Set());
  // Ref to track the fieldKey of a pending copy save so we can clear its loading state on response
  const pendingCopyFieldKeyRef = useRef<string | null>(null);
  /** An AI/copy button's own save refused because a "translate all" run
   *  writes into its language (useEditorAutoSave.safeSubmit): it is not held
   *  (a held own save would refuse every switch for the whole run). The value
   *  stays in the field as a draft; a copy's spinner stops. */
  const onOwnSaveRefusedRef = useRef(() => {});
  onOwnSaveRefusedRef.current = () => {
    if (pendingCopyFieldKeyRef.current) {
      const itemId = pendingCopyFieldItemIdRef.current ?? savedItemIdRef.current ?? selectedItemIdRef.current;
      if (itemId) markOperationFailed(itemId, pendingCopyFieldKeyRef.current);
      pendingCopyFieldKeyRef.current = null;
      pendingCopyFieldItemIdRef.current = null;
      // The copy moved the field's baseline up front: undone, so the copied
      // text reads as the unsaved draft it is.
      rollbackCopyField({ keepVisible: true });
    }
    if (pendingCopyAltTextIndexRef.current !== null) {
      const itemId = getPendingCopyAltItemId() ?? selectedItemIdRef.current;
      if (itemId) markOperationFailed(itemId, `altText_${pendingCopyAltTextIndexRef.current}`);
      pendingCopyAltTextIndexRef.current = null;
      rollbackCopyAltText();
    }
    isSaveFromTranslateRef.current = false;
    showInfoBox(
      savedLocaleRef.current === primaryLocale
        ? String(t.common?.ownSaveRefusedWhileItemTranslating || "A translation of this item is still running \u2013 the change stays unsaved. Save it when the translation has finished.")
        : String(t.common?.ownSaveRefusedWhileTranslating || "A translation into this language is still running \u2013 the change stays unsaved. Save it when the translation has finished."),
      "info",
    );
  };
  // Item the in-flight field copy was started for (savedItemIdRef is nulled on item change).
  const pendingCopyFieldItemIdRef = useRef<string | null>(null);

  // Forwarding-Refs for functions defined later (Ref-Forwarding-Pattern for circular dep)
  const buildFieldsForSaveRef = useRef<(v: Record<string, string>, l: string) => Record<string, string>>(() => ({}));
  const safeSubmitRef = useRef<(data: Record<string, any>, opts?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }) => void>(() => {});
  const submitAIActionRef = useRef<(data: Record<string, string>, fieldKey: string, onSuccess?: (r: Record<string, unknown>) => void, onError?: (e: string) => void, options?: { suppressErrorBox?: boolean }) => void>(async () => {});

  /**
   * Bumped once per completed background refresh, for the parts of a page the
   * field resolver does not reach: the alt texts below (their own effect, keyed
   * on language/market/item) and the product page's options and metafields
   * (`useProductSubResources`, keyed on `itemId::locale::market`). None of those
   * keys moves on a revalidation, so without this the refreshed translations
   * would be fetched and never shown. Declared above the alt-text hook because
   * that hook reads it.
   */
  const [backgroundRefreshVersion, setBackgroundRefreshVersion] = useState(0);
  /**
   * Unsaved work this hook cannot see — the product page's option/metafield
   * edits and pending image-manager changes live in their own hooks, and
   * `hasChanges` below knows nothing of them. The page reports it here so the
   * background refresh waits for those too: a revalidation re-runs the loaders
   * those cards render from, and re-reading under an unsaved edit is exactly
   * the automation eating merchant input.
   */
  const [externalUnsavedChanges, setExternalUnsavedChanges] = useState(false);

  // ============================================================================
  // SUB-HOOK: useEditorAltText
  // ============================================================================

  const {
    imageAltTexts, setImageAltTexts,
    fallbackAltTextIndices,
    altTextSuggestions,
    originalAltTexts, setOriginalAltTexts,
    imageAltTextsRef, originalAltTextsRef,
    pendingAltTextAutoSaveRef, localAltTextOverlayRef,
    selectedImageIndex, setSelectedImageIndex,
    handleAltTextChange, handleGenerateAltText, handleGenerateAllAltTexts,
    handleAcceptAltText, handleRejectAltText,
    handleCopyAltText, handleCopyAltTextToAllLocales, pendingCopyAltTextIndexRef, rollbackCopyAltText, discardCopyAltRecord, altBaselineSnapshot, getPendingCopyAltItemId,
    handleTranslateAltText, handleTranslateAltTextToAllLocales,
    handleTranslateAllAltTexts, handleTranslateAllAltTextsForLocale,
    handleAcceptAltTextSuggestion, handleAcceptAndTranslateAltText,
    handleRejectAltTextSuggestion,
    isPrimaryAltUnsaved, hasUnsavedPrimaryAlts,
  } = useEditorAltText({
    refuseOwnSave,
    pendingAltTranslateToastRef,
    partialSaveRef,
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
    backgroundRefreshVersion,
    buildFieldsForSave: (v, l) => buildFieldsForSaveRef.current(v, l),
    safeSubmit: (data, opts) => safeSubmitRef.current(data, opts),
    savedItemIdRef,
    savedLocaleRef,
    savedMarketIdRef,
    isSavePendingRef,
    isSaveFromTranslateRef,
    revalidatorRef,
    submitAIAction: (data, fieldKey, onSuccess, onError) => submitAIActionRef.current(data, fieldKey, onSuccess, onError),
    showInfoBox,
    t,
    suggestionScope,
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
    baselineValuesRef,
    baselineVersion,
    ownSavesInFlight,
    selectedItemId,
    selectedMarketId,
  });

  // Drafts a run deadline gave back stay protected until the merchant saved
  // or discarded them, i.e. until the view is clean again -- never while a
  // load forces `hasChanges` false.
  useEffect(() => {
    if (!hasChanges && !isLoadingData) keptDraftViewRef.current = null;
  }, [hasChanges, isLoadingData]);

  // ============================================================================
  // BACKGROUND RE-TRANSLATION — the detached run this save started
  // ============================================================================
  //
  // With `autoTranslateExternalChanges` on, a primary save hands the foreign
  // languages to an AI run that takes seconds to minutes and finishes long
  // after the response (`reconcileAfterPrimarySave`). Nothing told this page
  // when, so the merchant sat in front of empty foreign fields for translations
  // that were already on their way. The save response carries the run's Task
  // id; `useBackgroundTaskRefresh` watches it and asks for ONE reload.
  //
  // It READS ONLY. No form is submitted, no value is written, and no comparison
  // baseline or undo history is touched — the whole mechanism is a revalidation
  // plus a re-resolve of the fields from the fresh loader data.

  /** A reload has been asked for and the revalidation is under way; the
   *  re-resolve happens once the loader data has actually landed. */
  const backgroundRefreshPendingRef = useRef(false);
  /** Read by the data-loading effect: every pass while this is set is a
   *  background refresh, not a ReloadButton press, and must not discard the
   *  merchant's caches wholesale or overwrite a field they are typing in. */
  const backgroundRefreshActiveRef = useRef(false);
  /** The `dataRefreshTrigger` value this refresh will bump to. A ReloadButton
   *  press bumps to a different one and keeps its own, wider semantics. */
  const backgroundRefreshTriggerRef = useRef<number | null>(null);
  /**
   * The runs this SESSION started that have not been seen finished — a union
   * across saves, exactly like the grid's. A merchant saves again while the
   * first run is still working, and the second save may start none at all; a
   * watch over only the newest list would drop the first one's ids and its
   * translations would land with nothing reloading the editor.
   */
  const [watchedTaskIds, setWatchedTaskIds] = useState<string[]>([]);
  const pendingRetranslationCount = watchedTaskIds.length;
  /**
   * Every response this editor's fetcher sees is offered here — one call rather
   * than one per action type, because a response with no task ids adds nothing
   * and a surface that started no run must not poll at all.
   */
  const trackRetranslationTasks = useCallback((response: unknown) => {
    const ids = readRetranslationTaskIds(response);
    if (ids.length === 0) return;
    setWatchedTaskIds((prev) => [...new Set([...prev, ...ids])]);
    // The shop-wide task badge polls on its own clock; a short run (one field
    // into a couple of languages) can start and finish between two polls and
    // never show as running at all. Ask now.
    refreshTaskCount();
  }, [refreshTaskCount]);

  // EVERY response this editor's fetcher sees is offered to the watcher — one
  // call rather than one per action type, because a response carrying no task
  // ids adds nothing and a surface that started no run must not poll at all.
  // Without this line the ids the save actions now return are simply discarded
  // and no reload ever happens, which is the whole mechanism.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    trackRetranslationTasks(fetcher.data);
  }, [fetcher.state, fetcher.data, trackRetranslationTasks]);

  /**
   * A reload the editor was not ready for is REMEMBERED, not dropped: the watch
   * reports every id exactly once, so a refusal that forgot it would lose the
   * reload for good.
   */
  const refreshOwedRef = useRef(false);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  useBackgroundTaskRefresh(watchedTaskIds, ({ settled, follow }) => {
    const done = new Set(settled);
    setWatchedTaskIds((prev) => [
      ...new Set([...prev.filter((id) => !done.has(id)), ...follow]),
    ]);
    // Per batch, not once at the end: a product's three repair groups finish
    // minutes apart, and holding the reload for the slowest would keep showing
    // empty fields for translations that landed long ago.
    if (settled.length > 0) {
      refreshOwedRef.current = true;
      setRefreshAttempt((n) => n + 1);
    }
  });

  /**
   * While the merchant has UNSAVED work the page may not be re-read at all.
   * This is the one rule that holds under every circumstance, and it is wider
   * than the dirty-field merge below on purpose: a staged translation for a
   * language that is not on screen lives only in the overlay refs, where no
   * merge can see it, so the safe answer is to wait until the editor is clean.
   * A save in flight is the same question one moment earlier — re-reading the
   * server mid-write shows the state before it.
   */
  // `isLoadingData` is in here because `hasChanges` is forced to FALSE while it
  // is true (useEditorChangeDetection) — so without it the deferral would read
  // a genuinely dirty editor as clean during exactly the window a reload is
  // most likely to be asked for.
  const canBackgroundRefresh =
    !hasChanges &&
    !externalUnsavedChanges &&
    !isLoadingData &&
    fetcher.state === "idle" &&
    revalidator.state === "idle";
  useEffect(() => {
    if (!refreshOwedRef.current) return;
    if (!canBackgroundRefresh) return;
    refreshOwedRef.current = false;
    backgroundRefreshPendingRef.current = true;
    // Armed HERE, not when the revalidation lands. Its fresh data re-runs the
    // data-loading effect on its own (the translation signal moves), and that
    // pass would otherwise run in normal mode: it would overwrite a keystroke
    // and install its own baseline, after which the merge below could only ever
    // find everything clean. Every pass from this moment until the trigger's
    // own preserves unsaved input.
    backgroundRefreshActiveRef.current = true;
    try {
      revalidatorRef.current.revalidate();
    } catch {
      // An AbortError from the Shopify admin interfering is not a failure of
      // this refresh — put the debt back and let the next change re-run this.
      backgroundRefreshPendingRef.current = false;
      backgroundRefreshActiveRef.current = false;
      refreshOwedRef.current = true;
    }
    // `canBackgroundRefresh` is what re-runs this once the merchant saves or
    // discards; the attempt counter is what re-runs it when a second batch
    // settles while the editor was already clean.
  }, [canBackgroundRefresh, refreshAttempt]);

  // The revalidation has landed. Force a re-resolve even on a surface whose
  // `item.translations` fingerprint did not move — a metaobject field, a theme
  // key, an option name and an alt text all live outside it, so the signals the
  // data-loading effect normally watches would never notice that the AI wrote
  // anything at all.
  useEffect(() => {
    if (revalidator.state !== "idle") return;
    if (!backgroundRefreshPendingRef.current) return;
    backgroundRefreshPendingRef.current = false;
    // The trigger value this refresh owns, taken from the setter itself so it
    // cannot disagree with what React stores. It is what tells the run this
    // causes apart from a ReloadButton press landing in the same window — the
    // two want opposite things from the caches.
    // The revalidation's own fresh translations may already have re-run the
    // data-loading effect once, in normal mode and with the stale overlays
    // still in place. That run settles at whatever the overlays say and this
    // one then corrects it — the visible cost is at most one frame, and both
    // runs start from an editor with nothing unsaved (the refresh is deferred
    // otherwise), so nothing of the merchant's is at stake in between.
    setDataRefreshTrigger((prev) => {
      backgroundRefreshTriggerRef.current = prev + 1;
      return prev + 1;
    });
    setBackgroundRefreshVersion((v) => v + 1);
  }, [revalidator.state]);

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
    saveBlockedByTranslateRunRef,
    onSaveHeldByRunRef,
    onOwnSaveRefusedRef,
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

  // Safety-net signal for primary content changes after revalidation.
  // Handles the case where translations are unchanged (e.g., both empty before and after)
  // but primary fields like title/description changed — without this, the data-loading
  // effect would never re-run after a reload because no other dep would change.
  const selectedItemPrimarySignal = useMemo(() => {
    if (!selectedItemId) return '';
    const item = items.find(i => i.id === selectedItemId);
    if (!item) return '';
    return `${item.title || ''}|${(item.descriptionHtml || '').length}|${item.handle || ''}`;
  }, [items, selectedItemId]);

  const prevSelectedItemPrimarySignalRef = useRef<string>('');

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
    // 5. Primary content changed after revalidation (safety net for empty-translation case)
    // NOTE: Use separate ref from image loading to avoid race condition
    const itemIdChanged = prevItemIdForDataLoadRef.current !== selectedItemId;
    const languageChanged = prevCurrentLanguageRef.current !== currentLanguage;
    const marketChanged = prevSelectedMarketIdRef.current !== selectedMarketId;
    const refreshTriggered = prevDataRefreshTriggerRef.current !== dataRefreshTrigger;
    const translationsArrived = prevTranslationSignalRef.current !== selectedItemTranslationSignal;
    const primaryContentChanged = prevSelectedItemPrimarySignalRef.current !== selectedItemPrimarySignal;

    if (!itemIdChanged && !languageChanged && !marketChanged && !refreshTriggered && !translationsArrived && !primaryContentChanged) {
      // Don't log on skip to reduce console spam
      return;
    }


    if (translationsArrived && !refreshTriggered && !languageChanged && !itemIdChanged) {
      debugLog.dataLoad(` Translations arrived for item (${prevTranslationSignalRef.current} → ${selectedItemTranslationSignal}) — re-resolving fields`);
    }

    // Update refs
    prevItemIdForDataLoadRef.current = selectedItemId;
    prevCurrentLanguageRef.current = currentLanguage;
    prevSelectedMarketIdRef.current = selectedMarketId;
    prevDataRefreshTriggerRef.current = dataRefreshTrigger;
    prevTranslationSignalRef.current = selectedItemTranslationSignal;
    prevSelectedItemPrimarySignalRef.current = selectedItemPrimarySignal;

    // A refresh this page asked for AFTER a background re-translation finished
    // is not a ReloadButton press, and the two differ in both directions.
    //
    // EVERY pass while the flag is set counts, not only the one the trigger
    // causes: the revalidation re-runs this effect on its own (its fresh
    // `item.translations` move the signal), and letting that pass run in normal
    // mode overwrote an unsaved keystroke and installed its own baseline —
    // after which the merge below could only ever find everything clean.
    //
    // The one pass that must NOT be reclassified is a ReloadButton press
    // landing in the same window: it bumps the trigger to a different value and
    // keeps its own, wider reset. The flag is retired by the trigger this
    // refresh owns.
    const isOwnTrigger =
      refreshTriggered && dataRefreshTrigger === backgroundRefreshTriggerRef.current;
    const isBackgroundRefresh =
      backgroundRefreshActiveRef.current && (isOwnTrigger || !refreshTriggered);
    if (isOwnTrigger || (refreshTriggered && !isBackgroundRefresh)) {
      backgroundRefreshActiveRef.current = false;
      backgroundRefreshTriggerRef.current = null;
    }

    if (refreshTriggered && !isBackgroundRefresh) {
      debugLog.dataLoad(' Data refresh triggered by ReloadButton');
      dataLoader.onRefresh(selectedItemId);

      // For templates, skip loading from stale item data after a reload.
      // The page-level reload effect (app.templates.tsx) fetches fresh data from the API
      // and updates editable values directly. Reading from item.translatableContent here
      // would use stale cached data and cause a race condition (stale values overwriting fresh).
      if (isThemeContentType(config.contentType)) {
        debugLog.dataLoad(' Templates refresh - skip stale data load, page-level effect handles update');
        return;
      }
    } else if (isBackgroundRefresh) {
      // Its OWN, narrower reset: the foreign overlays go (the server has just
      // rewritten those languages and would otherwise lose to a stale entry —
      // see `onBackgroundRetranslation`), the primary cache stays. Nothing was
      // reloaded from an API here either, so the theme early return above does
      // not apply: the loader data this re-resolves from IS the fresh data.
      debugLog.dataLoad(' Data refresh after a background re-translation');
      dataLoader.onBackgroundRetranslation(deletedMarksOfSavesOut());
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
      // Nor will it clear the busy flag: back on the old item it read as
      // saving for the rest of the session.
      setIsSaving(false);
      // Its response will never be applied here (the pending flag is gone), so
      // its partial description must not survive to be read by the next save.
      inFlightPartialRef.current = null;
      // Nor may any own save keep covering a field: its answer is dropped.
      setOwnSavesInFlight([]);
      inFlightToastRef.current = null;
      processedTranslateFieldRef.current = null;
      processedTranslateAltTextAllRef.current = null;
      // processedTranslateAllRef / processedTranslateAllForLocaleRef are NOT
      // reset: a translate-all answer is applied once, ever. Resetting them
      // let the answer still held in fetcher.data be re-applied (and its toast
      // shown again) the next time those effects re-ran on another item.
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
    // What Discard restores the fallback flags against (see
    // fallbackFieldsAfterDiscard): the inherited fields of THIS load and the
    // values they were resolved with.
    loadedFallbackRef.current = { fields: new Set(newFallbackFields), values: { ...newValues } };

    // Update the unified baseline and legacy refs via onDataLoaded.
    // This is the single authoritative update point — never update these refs
    // directly in save-response handlers (see "DO NOT REMOVE" comments below).
    //
    // The BASELINE is always the resolved SERVER values, even where a field on
    // screen keeps a different one below: the baseline is what change detection
    // compares against, so writing a preserved edit into it would mark that
    // edit as saved and the merchant could never save it again.
    // Captured BEFORE onDataLoaded overwrites it — it is the baseline the
    // merchant's current input is dirty against, and comparing against the one
    // this very call installs would find every field clean.
    // Only a pass that re-reads the SAME item/locale/market may carry input
    // over. A pass caused by a switch landing inside the refresh window is a
    // different set of fields: the merchant already answered the leave dialog
    // for what they typed, and merging it here would copy the old locale's (or
    // item's) text into the new one's fields as an unsaved edit the next save
    // writes.
    const switchedDuringRefresh = itemIdChanged || languageChanged || marketChanged;
    // A switch ends the window: the fields on screen now belong elsewhere.
    if (switchedDuringRefresh) {
      preserveEditsUntilRef.current = 0;
      unconfirmedKeptKeysRef.current = new Set();
      keptDraftViewRef.current = null;
    }
    // The re-read that follows a PARTIAL save (a single-field translate):
    // the fields that save did not carry may hold unsaved input, and the
    // server only has their old values — resolving in normal mode would
    // overwrite what the merchant typed. A ReloadButton press is excluded: it
    // is the merchant asking for exactly that reset.
    const preserveAfterPartialSave =
      !switchedDuringRefresh &&
      !(refreshTriggered && !isBackgroundRefresh) &&
      (Date.now() < preserveEditsUntilRef.current ||
        unconfirmedKeptKeysRef.current.size > 0 ||
        // Drafts a run deadline gave back (never sent): kept until saved or
        // discarded.
        (keptDraftViewRef.current !== null &&
          keptDraftViewRef.current.itemId === selectedItemId &&
          !saveAnswerViewMoved(keptDraftViewRef.current, { locale: currentLanguage, marketId: selectedMarketId ?? "" }, primaryLocale)) ||
        // A save of this item is out, or still waits in the queue (behind a
        // "translate all" run of its language). A reload landing meanwhile --
        // the run's, or the save's own arriving in the same render as its
        // answer, before the answer handler can extend the window above --
        // must not replace what the merchant typed: the save carries it (or,
        // for a save of ANOTHER view made before a switch, it is this view's
        // unsaved input).
        (isSavePendingRef.current && savedItemIdRef.current === selectedItemId) ||
        saveQueueRef.current.some(
          (entry) =>
            entry.savedItemId === selectedItemId &&
            !saveAnswerViewMoved(
              { locale: entry.savedLocale ?? "", marketId: entry.savedMarketId ?? "" },
              { locale: currentLanguage, marketId: selectedMarketId ?? "" },
              primaryLocale,
            ),
        ));
    const previousBaseline =
      (isBackgroundRefresh || preserveAfterPartialSave) && !switchedDuringRefresh
        ? { ...baselineValuesRef.current }
        : null;
    dataLoader.onDataLoaded(newValues);

    if (previousBaseline) {
      // Defence in depth for the one rule that holds under all circumstances:
      // a field the merchant has typed in and not saved keeps what they typed.
      // The refresh only runs while the editor is clean (see the deferral in
      // the background-refresh callback), so this normally changes nothing —
      // but a keystroke can land between that decision and this effect, and
      // losing it would be the automation quietly eating merchant input.
      const { values: merged, preservedKeys } = preserveUnsavedEdits(
        newValues,
        editableValuesRef.current,
        previousBaseline,
      );
      if (preservedKeys.length > 0) {
        debugLog.dataLoad(` Background refresh preserved ${preservedKeys.length} unsaved field(s)`);
      }
      setEditableValues(merged);
      return;
    }

    setEditableValues(newValues);
    // IMPORTANT: Deps are kept minimal to prevent unnecessary re-runs.
    // selectedItemTranslationSignal is stable (only changes when translation count changes)
    // so it won't cause extra re-runs during normal editing.
  }, [selectedItemId, currentLanguage, selectedMarketId, primaryLocale, config, dataRefreshTrigger, selectedItemTranslationSignal, selectedItemPrimarySignal]);

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
            if (isMarkedDeleted(deletedTranslationKeysRef.current, field.translationKey, "", currentLanguage)) {
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

  // Poll a fire-and-forget task until it reaches a terminal state.
  // Returns the parsed result (with `generatedAltTexts` when present) so the
  // existing onSuccess callbacks downstream can keep their original shape.
  const pollTaskUntilDone = useCallback(async (
    taskId: string,
  ): Promise<Record<string, unknown> | null> => {
    const maxAttempts = 600; // 600 × 1s = 10 min — matches TaskRecovery stuck threshold
    const intervalMs = 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(`/api/task-result?taskId=${encodeURIComponent(taskId)}`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }
        const data = await res.json();
        const task = data?.task;
        if (!task) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        if (task.status === "completed" || task.status === "failed") {
          let parsed: Record<string, unknown> = {};
          if (task.result) {
            try {
              parsed = JSON.parse(task.result);
            } catch {
              parsed = { rawResult: task.result };
            }
          }
          return {
            ...parsed,
            taskStatus: task.status,
            taskError: task.error ?? null,
            processed: task.processed,
            total: task.total,
            success: task.status === "completed",
          };
        }
      } catch {
        // Transient error — keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return null;
  }, []);

  // Submit AI action using fetch API directly to allow parallel requests
  // This enables multiple AI actions to run simultaneously on different fields.
  // Loading state is tracked in the global AI operations store so spinners
  // persist when the user navigates between items.
  const submitAIAction = useCallback(async (
    data: Record<string, string>,
    fieldKey: string,
    onSuccess?: (result: Record<string, unknown>) => void,
    onError?: (error: string) => void,
    /**
     * `suppressErrorBox` hands the failure to `onError` ALONE, without the red
     * banner. For an action the merchant TRIGGERED the banner is right — they
     * are waiting for an answer. For one the app started by itself, a critical
     * error appearing on top of a save they just watched succeed reads as "the
     * save broke", which it did not. The caller then says what actually failed,
     * in its own words and its own tone. Default off: every existing call site
     * keeps the banner it has today.
     */
    options?: { suppressErrorBox?: boolean }
  ) => {
    const itemId = selectedItemIdRef.current;
    if (!itemId) return;

    const action = data.action || "unknown";

    // Mark in global store (spinner visible immediately, survives navigation).
    // The scope goes in with it so an answer parked while the merchant is
    // elsewhere is applied to the locale/market it was ASKED from.
    markOperationActive(itemId, fieldKey, action, data.targetLocale, {
      locale: suggestionScopeRef.current.locale,
      marketId: suggestionScopeRef.current.marketId,
    });

    try {
      const formData = new FormData();
      // Add contentType for task tracking
      formData.append('contentType', config.contentType);
      Object.entries(data).forEach(([key, value]) => {
        formData.append(key, String(value));
      });

      // Use dedicated AI API route for all AI requests
      // This avoids page routes returning HTML instead of JSON and enables parallel requests
      // appFetchJson sends the App Bridge session token itself and retries
      // once on an auth bounce; a session that cannot be re-established
      // throws `sessionExpired`, which translateErrorMessage below phrases.
      const { data: firstResult } = await appFetchJson<Record<string, any>>('/api/ai', {
        method: 'POST',
        body: formData,
      });
      let result = firstResult;

      // Fire-and-forget actions (e.g. generateAllAltTexts) return only a taskId
      // and run the heavy work detached from this request. Poll the task table
      // until the worker finishes — the user can navigate away mid-poll without
      // affecting the background work.
      if (result?.success && result.taskId && !result.generatedAltTexts) {
        const polled = await pollTaskUntilDone(result.taskId);
        if (polled) {
          // Polled result authoritatively decides success — partial failures and
          // failed tasks come through as taskStatus: "failed".
          result = { ...result, ...polled };
        } else {
          // Polling timed out — surface as critical so the user isn't left
          // believing the operation succeeded silently.
          result = {
            ...result,
            success: false,
            error: t.tasks?.taskFailedGeneric || "Task did not complete in time — please retry.",
          };
        }
      }

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
          if (!options?.suppressErrorBox) {
            const translatedError = translateErrorMessage(errorMsg, t);
            showInfoBox(translatedError, "critical");
          }
        }
      }
    } catch (error) {
      markOperationFailed(itemId, fieldKey);
      if (selectedItemIdRef.current === itemId) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        onError?.(errorMessage);
        if (!options?.suppressErrorBox) {
          const translatedError = translateErrorMessage(errorMessage, t);
          showInfoBox(translatedError, "critical");
        }
      }
    }
  }, [showInfoBox, t, pollTaskUntilDone]);

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
        setFieldSuggestion(fetcherScopeRef.current ?? suggestionScopeRef.current, fieldType, generatedContent);
      }
      // Stuffing guard (PLAN_KEYWORDS_EXPANSION.md §3.2). NOTE: the PRIMARY
      // generate path is the raw-fetch submitAIAction flow — its warning
      // lives in useFieldHandlers' onSuccess. This fetcher branch only fires
      // for the unified-content action path, which doesn't set the flag
      // today; kept so the warning appears automatically if it ever does.
      if ((fetcher.data as { keywordStuffingWarning?: boolean }).keywordStuffingWarning) {
        showInfoBox(
          (t.seo as { keywordStuffingWarning?: string } | undefined)?.keywordStuffingWarning ||
            "The generated text still over-uses a tracked keyword — review it before accepting.",
          "warning"
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // "Translate all" (every language, or one) as its OWN request through the
  // editor JSON door, never on the shared fetcher: a run takes seconds to
  // minutes, and on the one fetcher every save queued behind it -- a "clear
  // all" pressed in another language sat there with the save bar up and every
  // switch asking about it until the AI had finished. The answer is handed to
  // the same response effects as a fetcher answer, with the item the request
  // was made for -- through a QUEUE, because two runs (two languages) can
  // answer before React renders once, and a single state slot kept only the
  // last. Each effect drains the answers of its own action. A page outside the
  // door's list keeps the fetcher (its HTML answer could not be read).
  const translateRunQueueRef = useRef<Array<{ data: FetcherData; itemId: string | null }>>([]);
  const [translateRunVersion, setTranslateRunVersion] = useState(0);
  const takeTranslateRunAnswers = (actionType: string) => {
    const mine = translateRunQueueRef.current.filter((entry) => (entry.data as { actionType?: string }).actionType === actionType);
    if (mine.length > 0) {
      translateRunQueueRef.current = translateRunQueueRef.current.filter((entry) => !mine.includes(entry));
    }
    return mine;
  };
  const translateRunRevalidatePendingRef = useRef(false);
  /** The view whose held save a run deadline turned back into drafts (see
   *  `dropSavesHeldByRun`); its reloads keep the typed text. */
  const keptDraftViewRef = useRef<{ itemId: string; locale: string; marketId: string } | null>(null);
  /** Aborts of the runs still out; the editor's unmount fires them. */
  const translateRunAbortsRef = useRef<Set<() => void>>(new Set());
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    const aborts = translateRunAbortsRef.current;
    return () => {
      unmountedRef.current = true;
      for (const abortRun of [...aborts]) abortRun();
    };
  }, []);
  /** A run past its deadline: the saves held behind IT (not behind another
   *  run still out) leave the queue unsent and become drafts again. */
  const dropSavesHeldByRun = (run: { itemId: string | null; locale: string }): number => {
    const others = translateRunsRef.current.filter((r) => r !== run);
    const heldByThis = (entry: (typeof saveQueueRef.current)[number]) => {
      if (entry.formData.get("action") !== "updateContent" || entry.savedItemId !== run.itemId) return false;
      const touches = (r: { locale: string }) =>
        entry.savedLocale === primaryLocaleRef.current || r.locale === "*" || r.locale === entry.savedLocale;
      return touches(run) && !others.some((r) => r.itemId === run.itemId && touches(r));
    };
    const droppedEntries = saveQueueRef.current.filter(heldByThis);
    // Their text was never sent: every reload until the merchant saves or
    // discards must keep it (the queue no longer says a save is coming).
    for (const entry of droppedEntries) {
      if (entry.savedItemId) {
        keptDraftViewRef.current = { itemId: entry.savedItemId, locale: entry.savedLocale ?? "", marketId: entry.savedMarketId ?? "" };
      }
    }
    saveQueueRef.current = saveQueueRef.current.filter((entry) => !heldByThis(entry));
    const dropped = droppedEntries.length;
    for (const entry of droppedEntries) {
      if (entry.savedLocale !== primaryLocaleRef.current || !entry.savedItemId) continue;
      // An unsent PRIMARY save: the purge it announced (layer marks) did not
      // happen, and its values are not "saved" -- only the draft remains.
      const fields = sentFieldsFromForm(entry.formData.entries());
      const changedKeys = changedTranslationKeysOf(fields, effectiveFieldDefinitionsRef.current);
      for (const tKey of changedKeys) deletedTranslationKeysRef.current.delete(tKey);
      const cache = savedPrimaryValuesRef.current[entry.savedItemId];
      if (cache) {
        let changed: unknown = [];
        try { changed = JSON.parse(fields.changedFields ?? "[]"); } catch { /* none */ }
        if (Array.isArray(changed)) for (const key of changed) delete cache[String(key)];
      }
    }
    if (dropped > 0) setIsSaving(false);
    return dropped;
  };
  const submitTranslateRun = useCallback((data: Record<string, string>, itemId: string | null) => {
    const page = typeof window !== "undefined" ? contentEditorActionPage(window.location.pathname) : null;
    // Theme content keeps the fetcher: its page (ThemeContentDomainPage) reads
    // the run's answer off `fetcher.data` into its own translation cache.
    if (!page || isThemeContentType(configRef.current.contentType)) {
      safeSubmitRef.current(data, { method: "POST" });
      return;
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(data)) form.append(key, String(value));
    setContentEditorPage(form, page);
    const run = { itemId, locale: data.action === "translateAllForLocale" ? String(data.targetLocale) : "*" };
    translateRunsRef.current = [...translateRunsRef.current, run];
    const stopSpinner = () => {
      if (!itemId) return;
      if (data.action === "translateAllForLocale") markOperationFailed(itemId, `__translateAllForLocale__${data.targetLocale}`);
      else markOperationFailed(itemId, "__translateAll__");
    };
    // A run that never answers must not hold the saves behind it for good.
    // Past the deadline the answer is given up -- but the SERVER may still be
    // writing (it loops over the languages with a long budget per AI call), so
    // the saves held behind it are NOT sent: a primary purge or a clear landing
    // now would be overwritten by the run's later registrations. They go back
    // to drafts (fields stay changed, the save bar stays) and the merchant is
    // told to save again in a moment. An unmount aborts too, silently.
    const controller = new AbortController();
    let abortReason: "deadline" | "unmount" | null = null;
    const abort = (reason: "deadline" | "unmount") => {
      if (abortReason) return;
      abortReason = reason;
      controller.abort();
    };
    const deadline = setTimeout(() => abort("deadline"), TRANSLATE_RUN_DEADLINE_MS);
    const onUnmount = () => abort("unmount");
    translateRunAbortsRef.current.add(onUnmount);
    void (async () => {
      let answer: FetcherData;
      try {
        const { data: body } = await appFetchJson<FetcherData>(CONTENT_EDITOR_ACTION_ENDPOINT, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        answer = body;
      } catch (error) {
        answer = { success: false, error: error instanceof Error ? error.message : String(error) } as FetcherData;
      } finally {
        clearTimeout(deadline);
        translateRunAbortsRef.current.delete(onUnmount);
      }
      stopSpinner();
      if (abortReason === "unmount" || unmountedRef.current) {
        // The page is gone: no message, no state. (The server carries on; a
        // later visit seeds the spinner from its Task row.)
        translateRunsRef.current = translateRunsRef.current.filter((r) => r !== run);
        return;
      }
      if (abortReason === "deadline") {
        const dropped = dropSavesHeldByRun(run);
        translateRunsRef.current = translateRunsRef.current.filter((r) => r !== run);
        setTranslateRunsVersion((v) => v + 1);
        showInfoBoxRef.current(
          dropped > 0
            ? String(tRef.current?.common?.translateRunTimedOutSaveKept || "The translation may still be running on the server. Your changes were not saved yet \u2013 please save again in a moment.")
            : String(tRef.current?.common?.translateRunTimedOut || "The translation is taking longer than expected. Reload the page later to see what was stored."),
          "warning",
        );
        if (revalidatorRef.current.state === "idle") {
          try { revalidatorRef.current.revalidate(); } catch { /* ignored */ }
        } else {
          translateRunRevalidatePendingRef.current = true;
        }
        return;
      }
      translateRunsRef.current = translateRunsRef.current.filter((r) => r !== run);
      // Saves that waited for this run may go now (queue drain).
      setTranslateRunsVersion((v) => v + 1);
      // A fetcher action revalidates by itself; this request does not -- in
      // EITHER outcome: a failed run may have stored some languages, and the
      // fresh rows move the locale markers and back the staged overlay.
      if (revalidatorRef.current.state === "idle") {
        try { revalidatorRef.current.revalidate(); } catch { /* ignored */ }
      } else {
        translateRunRevalidatePendingRef.current = true;
      }
      if (!answer || !answer.success) {
        // A failed run: the merchant is told. Never read as a save's answer --
        // it does not go near the fetcher.
        const message = String((answer as { error?: unknown } | null)?.error ?? "");
        showInfoBoxRef.current(translateErrorMessage(message, tRef.current), "critical");
        return;
      }
      const answeredAction = (answer as { actionType?: string }).actionType;
      if (answeredAction === "translateAll" || answeredAction === "translateAllForLocale") {
        translateRunQueueRef.current.push({ data: answer, itemId });
        setTranslateRunVersion((v) => v + 1);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (revalidator.state !== "idle" || !translateRunRevalidatePendingRef.current) return;
    translateRunRevalidatePendingRef.current = false;
    try { revalidatorRef.current.revalidate(); } catch { /* ignored */ }
  }, [revalidator.state]);

  // Handle translated field response (single field translation)
  // Auto-save immediately after receiving translation
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.actionType === "translateField") {
      const { fieldType, translatedValue, targetLocale } = fetcher.data as TranslatedValueResponse;

      // Clear any previous error for this field on success
      if (fieldType) {
        setFieldErrors(prev => {
          if (!prev[fieldType]) return prev;
          const next = { ...prev };
          delete next[fieldType];
          return next;
        });
      }

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
        // Keep the save's market scope in lock-step with the overlay fold done by
        // onTranslateFieldComplete above (which reads the same market ref).
        const saveMarketId = targetLocale !== primaryLocale ? selectedMarketIdRef.current : "";
        // ONLY the translated field: other fields may hold unsaved input.
        const formDataObj = buildOwnSaveForm({
          itemId: selectedItemId,
          locale: targetLocale,
          primaryLocale,
          marketId: saveMarketId,
          fields: translatedValue && translatedValue.trim() ? { [fieldType]: translatedValue } : {},
        });
        partialSaveRef.current = {
          locale: targetLocale,
          marketId: saveMarketId,
          values: { [fieldType]: translatedValue },
          altIndices: [],
        };

        savedLocaleRef.current = targetLocale;
        // Legacy translateField auto-save carries marketId when foreign (see above).
        savedMarketIdRef.current = targetLocale !== primaryLocale ? selectedMarketIdRef.current : "";
        // Claim the item, or both save-response effects fail their
        // `isSavedItemCurrent` guard and early-return: no onSaveComplete
        // overlay write, no revalidation (so the loader would keep serving the
        // pre-translation row), and every message that effect owns swallowed.
        // This legacy path is not reached today — `handleTranslateField` posts
        // through submitAIAction's own fetch, so this route-fetcher response
        // never fires — so the claim buys nothing until something posts
        // `translateField` here again. It is set anyway because the omission
        // is exactly what made the same code in useFieldHandlers a bug.
        savedItemIdRef.current = selectedItemId;
        isSavePendingRef.current = true;
        safeSubmit(formDataObj, { method: "POST" });
      }
    }
  }, [fetcher.data, selectedItemId, primaryLocale, effectiveFieldDefinitions, safeSubmit, buildFieldsForSave]);

  // Handle single alt-text generation (show as suggestion)
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.actionType === "generateAltText") {
      const { altText, imageIndex } = fetcher.data as AltTextResponse;
      setAltTextSuggestion(fetcherScopeRef.current ?? suggestionScopeRef.current, imageIndex, altText);
    }
  }, [fetcher.data]);

  // Handle translated alt-text response (auto-save)
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.actionType === "translateAltText") {
      const { translatedAltText, imageIndex } = fetcher.data as TranslatedAltTextResponse;
      debugLog.altText(' Setting translated alt-text for image', imageIndex, ':', translatedAltText);

      // This image's alt only — the save's own response moves its baseline;
      // other typed alts stay drafts.
      pendingAltTextAutoSaveRef.current = { [imageIndex]: translatedAltText };
      setImageAltTexts(prev => ({ ...prev, [imageIndex]: translatedAltText }));
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
          String(t.content?.altTextPartialLocales || "Alt-text for image {imageNumber} partially translated. Language(s) {failedLocales} could not be saved. Please try again or re-sync.")
            .replace("{imageNumber}", String((imageIndex || 0) + 1))
            .replace("{failedLocales}", failedList),
          "warning"
        );
      } else {
        showInfoBox(
          String(t.content?.altTextTranslatedToAllLocales || "Alt-text for image {imageNumber} translated to {count} language(s)")
            .replace("{imageNumber}", String((imageIndex || 0) + 1))
            .replace("{count}", String(targetLocales.length)),
          "success"
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

  // Execute pending alt-text auto-save ("generate all alt texts").
  //
  // It carries the GENERATED alt texts and nothing else: the text fields and
  // any alt the merchant typed by hand stay drafts for their own Save (an AI
  // button saves its own result immediately, and only it). On the primary
  // locale the generated indices whose text really changed travel as
  // `changedAltTextIndices`, the same signal a typed-and-saved alt sends — and
  // NO `changedFields`, because no text field was written.
  useEffect(() => {
    const pendingAltTexts = pendingAltTextAutoSaveRef.current;
    if (!pendingAltTexts || !selectedItemId) return;

    // Clear the pending save ref immediately to prevent re-execution
    pendingAltTextAutoSaveRef.current = null;
    if (Object.keys(pendingAltTexts).length === 0) return;
    // A run blocks this own save: the texts already in the fields stay drafts,
    // and nothing (no overlay drop, no save) happens.
    if (refuseOwnSave(selectedItemId, currentLanguage)) return;

    debugLog.altText(' Executing auto-save for alt-texts:', pendingAltTexts);

    const indices = Object.keys(pendingAltTexts).map(Number);
    const changedOnPrimary =
      currentLanguage === primaryLocale
        ? getChangedAltTextIndices().filter((i) => indices.includes(i))
        : [];
    const formDataObj = buildOwnSaveForm({
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
      // This bulk alt auto-save writes globally (no marketId in the form).
      marketId: "",
      altTexts: pendingAltTexts,
      changedAltTextIndices: changedOnPrimary,
      policyType: config.resourceType === "ShopPolicy" ? selectedItemRef.current?.type : undefined,
    });
    // The client's mirror of what the server will purge for those images.
    if (changedOnPrimary.length > 0) {
      for (const key of Object.keys(localAltTextOverlayRef.current)) {
        if (key === primaryLocale) continue;
        for (const index of changedOnPrimary) delete localAltTextOverlayRef.current[key][index];
      }
    }

    partialSaveRef.current = { locale: currentLanguage, marketId: selectedMarketIdRef.current, values: {}, altIndices: indices, altValues: { ...pendingAltTexts } };
    savedLocaleRef.current = currentLanguage;
    // ...so the mirror must tag the saved alt as global too.
    savedMarketIdRef.current = "";
    // Claim the item — see the identical note on the translateField auto-save
    // above. It matters most here: this path carries alt texts, so the
    // `failedAltTextIndices` warning is the one message a merchant must not
    // miss, and without the claim it never reaches them.
    savedItemIdRef.current = selectedItemId;
    isSavePendingRef.current = true;
    safeSubmit(formDataObj, { method: "POST" });
  }, [imageAltTexts, selectedItemId, currentLanguage, primaryLocale, safeSubmit, getChangedAltTextIndices]);

  // Handle "translateAll" response (translates to ALL enabled locales)
  useEffect(() => {
    const ANSWER_ACTION = "translateAll";
    // `fromQueue`: a drained queue entry is applied exactly once by
    // construction, and must not take the processed slot of the fetcher's
    // answer (which would then be re-applied on the next run).
    const handleAnswer = (answer: FetcherData | undefined, scopeItemId: string | null | undefined, fromQueue = false) => {
      if (answer?.success && answer.actionType === "translateAll") {
        // Prevent re-processing when effectiveFieldDefinitions change (e.g. after Remix revalidation)
        if (!fromQueue) {
          if (answer === processedTranslateAllRef.current) return;
          processedTranslateAllRef.current = answer;
        }

        // The item the request was made for (taken at submit time): the
        // merchant may have switched items while the AI worked.
        const requestItemId = scopeItemId || selectedItemIdRef.current;

        // Clear the global store spinner for translateAll
        if (requestItemId) {
          markOperationFailed(requestItemId, "__translateAll__");
        }
        // Another item's answer: the server stored it, and the overlay refs
        // belong to the item showing now -- staging it there would put item A's
        // translations into item B's fields.
        if (requestItemId !== selectedItemIdRef.current) return;

        const { translations, failedLocales } = answer as TranslationsResponse;
        {
          // Delegate ref mutations to transition method
          const translationsMap = translations as Record<string, Record<string, string>>;
          const result = dataLoader.onTranslateAllComplete(
            translationsMap,
            effectiveFieldDefinitions,
            currentLanguage,
            editableValues,
            // A market view shows that market's layer; the global answer is not
            // written into its fields (see onTranslateAllComplete).
            currentLanguage === primaryLocale ? "" : (selectedMarketIdRef.current ?? "")
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
          const rejected = (answer as TranslationsResponse).rejectedFields || {};
          const rejectedLocales = Object.keys(rejected);
          const skipped = (answer as TranslationsResponse).skippedFields || {};
          const skippedLocales = Object.keys(skipped);

          if (failed.length > 0 || rejectedLocales.length > 0 || skippedLocales.length > 0) {
            const messages: string[] = [];

            if (failed.length > 0) {
              const failedList = failed.join(", ");
              // One rule, one module: the map is SEEDED with every target locale,
              // so adding the failed list to its key count counted failures twice.
              const { succeeded: successCount, total: totalLocales } = partialLocaleCounts(
                translations as Record<string, unknown>,
                failed,
              );
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
              "warning"
            );
          } else {
            const localeCount = Object.keys(translations).length;
            showInfoBox(
              String(t.content?.translateAllSuccess || "Successfully translated to {count} language(s).")
                .replace("{count}", String(localeCount)),
              "success"
            );
          }
        }
      }
    };
    // The shared fetcher (a page outside the door's list) and the run's
    // own request (translateRunAnswer) answer the same way.
    handleAnswer(fetcher.data, fetcherScopeRef.current?.resourceId);
    for (const entry of takeTranslateRunAnswers(ANSWER_ACTION)) handleAnswer(entry.data, entry.itemId, true);
  }, [fetcher.data, translateRunVersion, currentLanguage, effectiveFieldDefinitions, config.contentType, showInfoBox, t]); // Use selectedItemRef instead of selectedItem

  // Handle "translateAllForLocale" response (translates to ONE specific locale)
  useEffect(() => {
    const ANSWER_ACTION = "translateAllForLocale";
    // `fromQueue`: a drained queue entry is applied exactly once by
    // construction, and must not take the processed slot of the fetcher's
    // answer (which would then be re-applied on the next run).
    const handleAnswer = (answer: FetcherData | undefined, scopeItemId: string | null | undefined, fromQueue = false) => {
      if (answer?.success && answer.actionType === "translateAllForLocale") {
        // Prevent re-processing when effectiveFieldDefinitions change (e.g. after Remix revalidation)
        if (!fromQueue) {
          if (answer === processedTranslateAllForLocaleRef.current) return;
          processedTranslateAllForLocaleRef.current = answer;
        }

        const { targetLocale, failedLocales } = answer as TranslationsResponse & { targetLocale: string };

        // See the translateAll effect: the item the request was made for.
        const requestItemId = scopeItemId || selectedItemIdRef.current;

        // Clear the global store spinner for translateAllForLocale
        if (requestItemId) {
          markOperationFailed(requestItemId, `__translateAllForLocale__${targetLocale}`);
        }
        // Another item's answer is never staged into the item showing now.
        if (requestItemId !== selectedItemIdRef.current) return;
        const translations = (answer as TranslationsResponse).translations as Record<string, string>;
        {
          // Delegate ref mutations to transition method
          const result = dataLoader.onTranslateAllForLocaleComplete(
            translations,
            effectiveFieldDefinitions,
            targetLocale,
            currentLanguage,
            editableValues,
            // The run wrote the GLOBAL layer; a market view is not touched (see
            // onTranslateAllForLocaleComplete).
            currentLanguage === primaryLocale ? "" : (selectedMarketIdRef.current ?? "")
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
          const rejected = (answer as TranslationsResponse).rejectedFields || {};
          const rejectedForLocale = rejected[targetLocale];
          const skipped = (answer as TranslationsResponse).skippedFields || {};
          const skippedForLocale = skipped[targetLocale];

          if (failed.length > 0 && failed.includes(targetLocale)) {
            showInfoBox(
              String(t.content?.translateLocaleError || "Translation to {locale} failed. Please try again.")
                .replace("{locale}", targetLocale),
              "warning"
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
              "warning"
            );
          } else {
            showInfoBox(
              // `t.common.translatedSuccessfully` existed in no bundle at all, so
              // this always rendered its English literal. Its three siblings
              // above are content/translateLocale* with a {locale} placeholder.
              String(t.content?.translateLocaleSuccess || "Successfully translated to {locale}.")
                .replace("{locale}", targetLocale),
              "success"
            );
          }
        }
      }
    };
    // The shared fetcher (a page outside the door's list) and the run's
    // own request (translateRunAnswer) answer the same way.
    handleAnswer(fetcher.data, fetcherScopeRef.current?.resourceId);
    for (const entry of takeTranslateRunAnswers(ANSWER_ACTION)) handleAnswer(entry.data, entry.itemId, true);
  }, [fetcher.data, translateRunVersion, currentLanguage, effectiveFieldDefinitions, showInfoBox, t, config.contentType]); // Use selectedItemRef instead of selectedItem

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
      // A partial save overlays exactly what it SENT — from its own values,
      // not the live view, which may meanwhile show another locale.
      const partial = inFlightPartialRef.current;
      // A FULL save answered after a language/market switch: the live values
      // are the new view's. What was saved is what the form carried.
      const sentScope = inFlightScopeRef.current;
      const viewMoved = !partial && saveAnswerViewMoved(
        sentScope,
        { locale: currentLanguageRef.current, marketId: selectedMarketIdRef.current ?? "" },
        primaryLocale,
      );
      const sentFieldValues: Record<string, string> = {};
      if (viewMoved) {
        for (const field of effectiveFieldDefinitions) {
          const value = sentScope?.sentFields?.[field.key];
          if (value !== undefined) sentFieldValues[field.key] = value;
        }
      }
      // A cleared field whose removal Shopify did NOT confirm still holds its
      // translation there: it is not accepted into the saved cache, so it keeps
      // its overlay and stays dirty for a retry.
      const unconfirmedCleared = unconfirmedClearedFieldSet(fetcher.data);
      unconfirmedKeptKeysRef.current = viewMoved ? new Set() : new Set(unconfirmedCleared);
      const onlyKeys = unconfirmedClearedOnlyKeys(
        partial ? new Set(Object.keys(partial.values)) : viewMoved ? new Set(Object.keys(sentFieldValues)) : null,
        effectiveFieldDefinitions.map((f) => f.key),
        unconfirmedCleared,
      );
      // A PRIMARY save purged the translations of the fields it CHANGED. A
      // "translate all" answer that landed while this save waited (it holds
      // primary saves back) dropped their layer marks and staged translations
      // of the OLD text; the marks go back here, so the primary branch below
      // drops those overlays in every locale and layer like any other purge.
      if (savedLocale === primaryLocale) {
        for (const tKey of changedTranslationKeysOf(sentScope?.sentFields, effectiveFieldDefinitions)) {
          deletedTranslationKeysRef.current.add(tKey);
        }
      }
      const result = dataLoader.onSaveComplete(
        savedLocale,
        partial ? { ...editableValues, ...partial.values } : viewMoved ? sentFieldValues : editableValues,
        effectiveFieldDefinitions,
        viewMoved ? undefined : fallbackFieldsRef.current,
        onlyKeys,
        savedMarketIdRef.current
      );
      // A full save answered after a switch: its marks on fields it did NOT
      // send (an empty or inherited field "clear all" marked) had nothing to
      // remove -- they go too, unless another save out still carries them.
      if (viewMoved && savedLocale !== primaryLocale) {
        dropLocaleMarks(deletedTranslationKeysRef.current, savedLocale, savedMarketIdRef.current ?? "", deletedMarksOfSavesOut());
      }

      // Image alt-text updates (not managed by dataLoader — separate concern).
      // A PARTIAL save stands only for the alt indices it carried (none for a
      // single-field save): an alt the merchant typed and has not saved must
      // not be mirrored as saved, or the next Save would not send it.
      const carriedAlts: Set<number> | null = partial ? new Set(partial.altIndices ?? []) : null;
      const altCarried = (index: number) => carriedAlts === null || carriedAlts.has(index);
      // What the save SENT for its carried indices — not what the field holds
      // now (the merchant may have kept typing while it was in flight).
      const sentAlts = viewMoved
        ? { ...(sentScope?.sentAlts ?? {}) }
        : altValuesForSaveResponse(imageAltTextsRef.current, partial);
      if (savedLocale === primaryLocale) {
        if (Object.keys(sentAlts).length > 0) {
          const primaryFailed: number[] = Array.isArray(fetcher.data?.failedAltTextIndices)
            ? fetcher.data.failedAltTextIndices
            : [];
          for (const [indexStr, altText] of Object.entries(sentAlts)) {
            const index = parseInt(indexStr, 10);
            if (!altCarried(index)) continue;
            if (item.images?.[index]) {
              item.images[index].altText = altText;
              debugLog.response(' Updated primary alt-text for image', index);
            } else if (index === 0 && item.featuredImage && !primaryFailed.includes(0)) {
              // A collection/article keeps its one image in `featuredImage`
              // (images: []). Mirrored here so the foreign featured-alt lock
              // ("no primary alt yet") lifts at once, not after revalidation.
              item.featuredImage.altText = altText;
              debugLog.response(' Updated primary featured-image alt-text');
            }
          }
        }
      } else {
        // Mirror the saved alt-text into the in-memory translations, scoped to
        // the market the save was SUBMITTED under (savedMarketIdRef, pinned at
        // submit time) — not the live market, which may differ for a global save
        // (bulk / Accept & Translate) or after a mid-save market switch.
        const savedMarketId = savedMarketIdRef.current;
        if (item.images && Object.keys(sentAlts).length > 0) {
          const mirrorFailed: number[] = Array.isArray(fetcher.data?.failedAltTextIndices)
            ? fetcher.data.failedAltTextIndices
            : [];
          for (const [indexStr, altText] of Object.entries(sentAlts)) {
            const index = parseInt(indexStr, 10);
            if (mirrorFailed.includes(index)) continue;
            if (!altCarried(index)) continue;
            if (item.images[index]) {
              if (!item.images[index].altTextTranslations) {
                item.images[index].altTextTranslations = [];
              }
              item.images[index].altTextTranslations = item.images[index].altTextTranslations.filter(
                (t: AltTextTranslation) => !(t.locale === savedLocale && (t.marketId ?? "") === savedMarketId)
              );
              item.images[index].altTextTranslations.push({
                locale: savedLocale,
                altText: altText,
                marketId: savedMarketId,
              });
              debugLog.response(' Updated alt-text translation for image', index, 'locale:', savedLocale, 'market:', savedMarketId || '(global)');
            }
          }
        }
      }

      // Update originalAltTexts immediately after saving to reset change detection
      // (a failed copy's index keeps its previous baseline, see altBaselineSnapshot)
      // and so does ANY failed alt (not only a copy): its text was not stored,
      // so it must stay dirty against the baseline it had before this save.
      // (Not when the view moved: the alt baselines on screen are the new view's.)
      if (!viewMoved) {
        const failedAlts: number[] = Array.isArray(fetcher.data.failedAltTextIndices) ? fetcher.data.failedAltTextIndices : [];
        setOriginalAltTexts(
          restrictAltBaseline(
            keepFailedAltsDirty(altBaselineSnapshot(failedAlts, sentAlts), failedAlts, sentAlts),
            partial ? (partial.altIndices ?? []) : null,
          ),
        );
      }
      debugLog.response(' Updated originalAltTexts:', { ...sentAlts });

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
      setIsSaving(false);
      // Consumed by exactly one response, whatever happens below — a stale set
      // would make the NEXT full save count as partial.
      const partial = inFlightPartialRef.current;
      inFlightPartialRef.current = null;
      // Taken now, beside `partial`: anything below that chains a new save
      // rebinds the in-flight slot.
      const answeredScope = inFlightScopeRef.current;
      // Answered: from here the field's baseline (moved below) decides.
      settleOwnSaveFor(partial);

      // Guard: check if the item that was saved is still the currently-selected item.
      const savedItemId = savedItemIdRef.current;
      const isSavedItemCurrent = savedItemId === selectedItemIdRef.current;
      savedItemIdRef.current = null; // Always clean up — we've processed this response
      // The purge warning must survive every early return below (item switch,
      // Accept & Translate): those used to drop it and the merchant never
      // learned that stale translations are still live.
      const purgeSourceData = fetcher.data;
      const purgeWarningText = hasPurgeUnconfirmedWarning(fetcher.data)
        ? String(t.content?.translationPurgeUnconfirmed || "The text was saved, but some translations of it could not be removed on Shopify and were kept. Please check them.")
        : "";

      // A copy ("Übertragen") save is settled by THIS response whichever item is
      // on screen now. Resolve it before the item-changed return: stale pending
      // refs would make the next unrelated save report as a copy and keep the
      // spinner alive. The server may answer success with failed alt indices —
      // that copy did not persist, so its optimistic value is rolled back.
      const copyFailedAlts: number[] = Array.isArray(fetcher.data.failedAltTextIndices)
        ? fetcher.data.failedAltTextIndices
        : [];
      // Taken BEFORE the rollback clears its pending record, and reused for the
      // later baseline write, so that write cannot override the rollback.
      const sentAltsForBaseline = altValuesForSaveResponse(imageAltTextsRef.current, partial);
      const altBaselineAfterCopy = altBaselineSnapshot(copyFailedAlts, sentAltsForBaseline);
      const copyFieldItemId = pendingCopyFieldItemIdRef.current ?? savedItemId;
      const copyAltItemId = getPendingCopyAltItemId() ?? savedItemId;
      pendingCopyFieldItemIdRef.current = null;
      // The single alt translate-and-save reports success HERE, once Shopify
      // confirmed the save, not when the AI answered.
      const altTranslateToast = inFlightToastRef.current;
      inFlightToastRef.current = null;
      let wasCopySave = !!pendingCopyFieldKeyRef.current || pendingCopyAltTextIndexRef.current !== null;
      let copyAltFailed = false;
      if (pendingCopyFieldKeyRef.current) {
        if (copyFieldItemId) markOperationFailed(copyFieldItemId, pendingCopyFieldKeyRef.current);
        pendingCopyFieldKeyRef.current = null;
        // The copy landed: its rollback record must not outlive it.
        discardCopyFieldRecord();
      }
      if (pendingCopyAltTextIndexRef.current !== null) {
        const copyIndex = pendingCopyAltTextIndexRef.current;
        if (copyAltItemId) markOperationFailed(copyAltItemId, `altText_${copyIndex}`);
        pendingCopyAltTextIndexRef.current = null;
        if (copyFailedAlts.includes(copyIndex)) {
          copyAltFailed = true;
          rollbackCopyAltText();
        } else {
          discardCopyAltRecord();
        }
      }
      if (copyAltFailed) wasCopySave = false; // reported as a failed copy, not "copied"

      if (!isSavedItemCurrent) {
        debugLog.response(' Item changed during save — skipping response application for wrong item');
        // The editor state belongs to another item now, but the warning is about
        // live data on Shopify: say it rather than lose it.
        if (purgeWarningText) showInfoBox(purgeWarningText, "warning");
        return;
      }

      // Update unified baseline to the saved values so hasChanges resets correctly.
      // The data-loading effect only fires when selectedItemTranslationSignal changes;
      // without this update, hasChanges stays true and navigation stays blocked after
      // saves that don't affect translation count (e.g. primary locale with no translations).
      // NOTE: Do NOT use savedLocaleRef here — it is cleared to null by the "Update item
      // object after saving" useEffect (which runs first, at line ~1376). Instead, detect
      // primary locale by checking for a savedPrimaryValuesRef snapshot (only set for primary saves).
      const baselineBeforeSave = baselineValuesRef.current;
      // A FULL save answered after a language/market switch describes a view
      // that is gone: the baselines on screen are the new view's, and a draft
      // typed there must stay a draft. The reload that follows this answer
      // keeps the new view's unsaved input (preserveEditsUntilRef).
      const answerViewMoved = !partial && saveAnswerViewMoved(
        answeredScope,
        { locale: currentLanguageRef.current, marketId: selectedMarketIdRef.current ?? "" },
        primaryLocale,
      );
      if (answerViewMoved) preserveEditsUntilRef.current = Date.now() + 30_000;
      if (!answerViewMoved) {
        const currentItemId = selectedItemIdRef.current;
        if (currentItemId) {
          const primarySnapshot = savedPrimaryValuesRef.current[currentItemId];
          // Only adopt the primary snapshot as the change-detection baseline when
          // the user is actually VIEWING the primary locale. The foreign-locale
          // Accept & Translate flow populates savedPrimaryValuesRef purely as a
          // display overlay while the user is on a foreign locale — using it as
          // the baseline there would wrongly flag the field dirty (the overlay
          // holds the primary value, but editableValues holds the foreign value).
          //
          // A PARTIAL save is checked FIRST: an accepted AI suggestion on the
          // primary locale merges only its own field into
          // savedPrimaryValuesRef, so adopting that snapshot wholesale would
          // leave every other field without a baseline (= dirty).
          if (partial) {
            // A partial save: only the fields it carried are now saved, and
            // only if their locale is still the one on screen; the rest keep
            // the baseline they are dirty against.
            if (
              currentLanguageRef.current === partial.locale &&
              selectedMarketIdRef.current === partial.marketId &&
              Object.keys(partial.values).length > 0
            ) {
              baselineValuesRef.current = { ...baselineValuesRef.current, ...partial.values };
              setBaselineVersion(v => v + 1);
              // The change-detection baselines too, so a later full Save does
              // not report this field as changed again (on the primary locale
              // that would purge — or re-translate — what this save started).
              // A field Shopify did not confirm stays out: it is kept dirty
              // below and has to be sent again by the next Save.
              const notConfirmed = unconfirmedClearedFieldSet(fetcher.data);
              const confirmedValues = Object.fromEntries(
                Object.entries(partial.values).filter(([key]) => !notConfirmed.has(key)),
              );
              originalLoadedValuesRef.current = { ...originalLoadedValuesRef.current, ...confirmedValues };
              // Stored now: Discard must not re-flag them as inherited.
              loadedFallbackRef.current = dropSavedFieldsFromFallbackSnapshot(
                loadedFallbackRef.current,
                Object.keys(confirmedValues),
              );
              if (isThemeContentType(config.contentType)) {
                originalTemplateValuesRef.current = { ...originalTemplateValuesRef.current, ...confirmedValues };
                setTemplateValuesVersion(v => v + 1);
              }
            }
          } else if (
            primarySnapshot &&
            Object.keys(primarySnapshot).length > 0 &&
            currentLanguageRef.current === primaryLocale
          ) {
            baselineValuesRef.current = { ...primarySnapshot };
            setBaselineVersion(v => v + 1);
          } else {
            baselineValuesRef.current = { ...editableValuesRef.current };
            setBaselineVersion(v => v + 1);
          }
          if (!partial) {
            // A full save stored every field that was no longer inherited
            // (the ones still inherited are not sent); a stored value is the
            // field's own now, so Discard must not re-flag it. An unconfirmed
            // clear stays out. A FOREIGN save sends only fields that differ
            // from their loaded value, so a field typed back to exactly the
            // inherited text was NOT stored and stays in the snapshot.
            const notStored = unconfirmedClearedFieldSet(fetcher.data);
            const isPrimaryView = currentLanguageRef.current === primaryLocale;
            const snapshot = loadedFallbackRef.current;
            loadedFallbackRef.current = dropSavedFieldsFromFallbackSnapshot(
              snapshot,
              [...(snapshot?.fields ?? [])].filter(
                (key) => !fallbackFieldsRef.current.has(key)
                  && !notStored.has(key)
                  && (isPrimaryView || editableValuesRef.current[key] !== snapshot?.values[key]),
              ),
            );
          }
          // Fields whose clear was not confirmed keep their PREVIOUS baseline,
          // so they still read as changed and the merchant can save again.
          const keptDirty = unconfirmedClearedFieldSet(fetcher.data);
          if (keptDirty.size > 0) {
            const restored = { ...baselineValuesRef.current };
            for (const key of keptDirty) {
              if (key in baselineBeforeSave) restored[key] = baselineBeforeSave[key];
              else delete restored[key];
            }
            baselineValuesRef.current = restored;
            setBaselineVersion(v => v + 1);
          }
        }
      }

      // PLAN §Phase 3.3 — computed BEFORE the branch below, because that branch
      // returns early. It is a primary save like any other, so it can carry a
      // handle change; leaving the note behind the return meant a FAILED
      // redirect after "Accept & Translate" was swallowed and the merchant went
      // on believing the old URL still resolved.
      const pendingRedirectMessage = buildRedirectMessage(redirectNoteOf(fetcher.data), t);

      // Check if there's a pending translation to start after this save
      if (pendingTranslationAfterSaveRef.current) {
        if (pendingRedirectMessage) {
          showInfoBox(
            pendingRedirectMessage.text,
            pendingRedirectMessage.tone
          );
        }
        const { fieldKey, sourceText, targetLocales, contextTitle, itemId } = pendingTranslationAfterSaveRef.current;
        pendingTranslationAfterSaveRef.current = null;

        debugLog.acceptAndTranslate(' Save completed, now starting translation');

        // For templates: Update originalTemplateValuesRef and unified baseline IMMEDIATELY
        // after save completes, before the translation starts. Otherwise isLoadingData flips
        // back to false (10ms timer) while the translation is still in-flight, and the stale
        // baseline causes hasFieldChanges to return true → save button flickers active.
        // THIS field only: the save carried nothing else, and any other field
        // may hold unsaved input that must stay dirty.
        if (isThemeContentType(config.contentType)) {
          const savedValue = editableValuesRef.current[fieldKey] ?? "";
          originalTemplateValuesRef.current = { ...originalTemplateValuesRef.current, [fieldKey]: savedValue };
          setTemplateValuesVersion(v => v + 1);
          baselineValuesRef.current = { ...baselineValuesRef.current, [fieldKey]: savedValue };
          setBaselineVersion(v => v + 1);
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
            if (selectedItemRef.current?.id !== itemId) {
              if (purgeWarningText) showInfoBox(purgeWarningText, "warning");
              return;
            }

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

              // Also update the component-managed translation cache (loadedTranslations
              // in ThemeContentDomainPage). That cache — NOT resolve()/localTranslationsRef —
              // is what the component's language-switch effect reads authoritatively and
              // pushes into the editor via setEditableValue. The direct "translate to all
              // locales" path updates it through this same callback; the deferred
              // Accept & Translate path must do the same, or foreign locales render empty
              // after switching to them (the values are on Shopify but never reach the UI).
              onTranslateToAllLocalesComplete?.(
                fieldKey,
                translations as Record<string, string>
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
                const counts = partialLocaleCounts(
                  translations as Record<string, unknown>,
                  failedFieldLocales,
                );
                messages.push(
                  String(t.content?.translatePartialLocales || "Translation partially completed: {successCount}/{totalCount} language(s) succeeded. Language(s) {failedLocales} failed.")
                    .replace("{successCount}", String(counts.succeeded))
                    .replace("{totalCount}", String(counts.total))
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

              if (purgeWarningText) messages.push(purgeWarningText);
              showInfoBox(
                messages.join(" "),
                "warning"
              );
            } else {
              const fieldLabel = resolveFieldLabel(fieldKey);
              const translatedText =
                t.common?.fieldTranslatedToLanguages
                  ?.replace("{fieldType}", fieldLabel)
                  .replace("{count}", String(Object.keys(translations).length))
                  || `${fieldLabel} translated to ${Object.keys(translations).length} language(s)`;
              // Every language of THIS field was re-translated, which overwrote
              // the stale translations the purge could not remove: only a
              // warning about other fields/keys is still true.
              const stillWarn = purgeWarningText && purgeWarningConcernsOtherFields(purgeSourceData, fieldKey);
              showInfoBox(
                stillWarn ? `${translatedText} ${purgeWarningText}` : translatedText,
                stillWarn ? "warning" : "success"
              );
            }

            // Reset the accept-and-translate flow flag after translations are complete
            setIsAcceptAndTranslateFlow(false);

            // For templates: Update original values and unified baseline so hasChanges becomes false
            if (isThemeContentType(config.contentType)) {
              // Update with the translated value if we're viewing a foreign locale,
              // OR with the current editableValues for the primary locale (the accepted
              // AI suggestion was saved but the baseline was never updated because the
              // early `return` at the end of this block skips the normal post-save path).
              let newTemplateBaseline: Record<string, string> | null = null;
              if (translations[currentLanguage]) {
                newTemplateBaseline = {
                  ...originalTemplateValuesRef.current,
                  [fieldKey]: translations[currentLanguage]
                };
              } else if (currentLanguage === primaryLocale) {
                // Primary locale: the accepted field was saved — that field
                // only; any other field may still hold an unsaved draft.
                newTemplateBaseline = {
                  ...originalTemplateValuesRef.current,
                  [fieldKey]: editableValuesRef.current[fieldKey] ?? "",
                };
              }
              if (newTemplateBaseline) {
                originalTemplateValuesRef.current = newTemplateBaseline;
                baselineValuesRef.current = { ...baselineValuesRef.current, [fieldKey]: newTemplateBaseline[fieldKey] ?? "" };
                setBaselineVersion(v => v + 1);
              }
              setTemplateValuesVersion(v => v + 1);
            }

            setIsLoadingData(true);
            // Trigger revalidation so Remix fetches fresh item.translations from Shopify.
            // The 10ms loading-cleanup timer will wait for this revalidation to finish
            // before clearing isLoadingData, ensuring buttons only stop pulsing once
            // the server has confirmed the saved translations.
            try { revalidatorRef.current.revalidate(); } catch {}
          },
          (errorMessage) => {
            // The translation failed, the save did not: the purge warning is
            // still true and must not vanish behind the error.
            setIsAcceptAndTranslateFlow(false);
            showInfoBox(
              [translateErrorMessage(errorMessage, t), purgeWarningText].filter(Boolean).join(" "),
              "critical",
            );
          },
          { suppressErrorBox: true },
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

      // PLAN §Phase 3.3 — the handle changed, so the old URL either got a
      // redirect or did not. Both outcomes are news: the merchant cannot see
      // from the editor whether their existing links still work. The wording
      // lives in ONE helper because this response is handled in two places.
      const redirectMessage = pendingRedirectMessage;

      // One box, one outcome — the redirect line is APPENDED to whichever
      // message the save itself produced instead of competing with it, so a
      // failed alt-text write is never replaced by redirect news.
      const withRedirect = (text: string, tone: InfoBoxTone): [string, InfoBoxTone] => {
        if (!redirectMessage) return [text, tone];
        // A failed redirect outranks a plain success: something the merchant
        // has to act on beats "saved".
        const merged = redirectMessage.tone === "warning" || tone === "warning" ? "warning" : tone;
        return [`${text} ${redirectMessage.text}`, merged];
      };

      // A server warning (a collection rule the server kept, a DB mirror that
      // failed) is APPENDED rather than replaced by the alt-text message: a
      // merchant who edits attributes and alt-text in one save would otherwise
      // hear only about the images and never learn the rest did not land.
      const ruleWarnings = (t.content?.ruleWarnings ?? {}) as Record<string, string>;
      const ruleWarningCode =
        "ruleWarning" in fetcher.data ? String(fetcher.data.ruleWarning ?? "") : "";
      // §Phase 3.1 — codes from the attribute path (today: a rule-based
      // membership the picker asked to remove and the server kept). A LIST,
      // because more than one can be true of the same save.
      const attributeWarnings = (t.content?.attributeWarnings ?? {}) as Record<string, string>;
      const rawAttributeWarnings = (fetcher.data as unknown as Record<string, unknown>).attributeWarnings;
      const attributeWarningCodes: string[] = Array.isArray(rawAttributeWarnings)
        ? (rawAttributeWarnings as string[])
        : [];
      const serverWarning =
        // A CODE from the rule or attribute path (localized here), or a plain
        // string from the older warning paths. All end up in the same box, and
        // codes are joined rather than one silently winning.
        [
          ruleWarningCode && (ruleWarnings[ruleWarningCode] || ruleWarningCode),
          ...attributeWarningCodes.map((code) => attributeWarnings[code] || code),
          localizedUnconfirmedFields(fetcher.data),
          // One box for the save: the purge warning REPLACES the plain "saved"
          // toast (the host page used to show both).
          purgeWarningText,
          "warning" in fetcher.data && fetcher.data.warning ? String(fetcher.data.warning) : "",
        ]
          .filter(Boolean)
          .join(" ");

      // The failed alts that CANNOT be saved yet: their image has no alt text in
      // the main language, so Shopify offers nothing to translate. "Please try
      // again" would send the merchant round in a circle; they need to fill in
      // the main language first.
      const rawNoPrimary = (fetcher.data as unknown as Record<string, unknown>).altTextNoPrimaryIndices;
      const altNoPrimary: number[] = Array.isArray(rawNoPrimary)
        ? (rawNoPrimary as number[]).filter((i) => failedAltTextIndices.includes(i))
        : [];
      // The featured image itself was not found any more: kept as a failed
      // draft (a reload sorts it out), but with its own sentence -- "enter a
      // main-language alt first" would be the wrong advice.
      const rawNoImage = (fetcher.data as unknown as Record<string, unknown>).altTextNoImageIndices;
      const altNoImage: number[] = Array.isArray(rawNoImage)
        ? (rawNoImage as number[]).filter((i) => failedAltTextIndices.includes(i) && !altNoPrimary.includes(i))
        : [];
      const noImageMessage = altNoImage.length > 0
        ? String(
            t.content?.altTextImageMissing ||
              "The alt text of image {failedImages} was not saved: the image could no longer be found on Shopify. Reload the item and check that the image still exists.",
          ).replace("{failedImages}", altNoImage.map((i) => i + 1).join(", "))
        : "";
      if (altNoPrimary.length > 0) {
        const otherFailed = failedAltTextIndices.filter((i: number) => !altNoPrimary.includes(i) && !altNoImage.includes(i));
        const noPrimaryMessage = String(
          t.content?.altTextNeedsPrimary ||
            "The alt text of image {failedImages} was not saved: that image has no alt text in the main language yet. Enter and save one there first; then it can be translated.",
        ).replace("{failedImages}", altNoPrimary.map((i) => i + 1).join(", "));
        const otherMessage = otherFailed.length > 0
          ? String(
              config.contentType === "products"
                ? t.content?.altTextSavePartialImages ||
                    "Changes saved, but alt-text for image(s) {failedImages} could not be saved to Shopify. Please sync the product again."
                : t.content?.altTextSavePartialItem ||
                    "Changes saved, but the alt text of the image ({failedImages}) could not be saved to Shopify. Please try again.",
            ).replace("{failedImages}", otherFailed.map((i: number) => i + 1).join(", "))
          : "";
        const text = [noPrimaryMessage, noImageMessage, otherMessage, serverWarning].filter(Boolean).join(" ");
        showInfoBox(...withRedirect(text, "warning"));
        // Not kept as a draft, unlike every other failed alt: no retry can store
        // it until the main language has an alt text, so a draft here would
        // hold the save bar open with nothing the Save button could ever do.
        // The field goes back to what this language holds; the message says why.
        // Only where the answer still describes the screen: the same locale and
        // market as the save, and only fields still holding what was SENT
        // (a newer draft typed while the save was in flight is left alone).
        if (savedItemId === selectedItemIdRef.current) {
          const baseline = originalAltTextsRef.current;
          const scope = answeredScope;
          const viewLocale = currentLanguageRef.current;
          const view = { locale: viewLocale, marketId: viewLocale === primaryLocale ? "" : (selectedMarketIdRef.current ?? "") };
          setImageAltTexts((prev) =>
            revertAltsWithoutPrimary({ current: prev, baseline, indices: altNoPrimary, scope, view }).next,
          );
        }
      } else if (altNoImage.length > 0 && altNoImage.length === failedAltTextIndices.length) {
        showInfoBox(...withRedirect(serverWarning ? `${noImageMessage} ${serverWarning}` : noImageMessage, "warning"));
      } else if (failedAltTextIndices.length > 0) {
        const failedList = failedAltTextIndices.map((i: number) => i + 1).join(", ");
        // "Sync the product again" is product advice: a collection's or an
        // article's featured image has no product to sync, so those pages get
        // the neutral sentence.
        const altMessage = String(
          config.contentType === "products"
            ? t.content?.altTextSavePartialImages ||
                "Changes saved, but alt-text for image(s) {failedImages} could not be saved to Shopify. Please sync the product again."
            : t.content?.altTextSavePartialItem ||
                "Changes saved, but the alt text of the image ({failedImages}) could not be saved to Shopify. Please try again.",
        ).replace("{failedImages}", failedList);
        showInfoBox(...withRedirect(serverWarning ? `${altMessage} ${serverWarning}` : altMessage, "warning"));
      } else if (serverWarning) {
        // Server returned success but with a warning (e.g. Shopify saved, DB cache failed)
        showInfoBox(...withRedirect(serverWarning, "warning"));
      } else if (wasCopySave) {
        // Copy ("Übertragen") confirmed persisted to Shopify.
        const [text, tone] = withRedirect(
          String(t.common?.copiedToShopify || "Successfully transferred to Shopify"),
          "success",
        );
        showInfoBox(text, tone);
      } else if (altTranslateToast) {
        const [text, tone] = withRedirect(altTranslateToast, "success");
        showInfoBox(text, tone);
      } else if (!wasTranslateSave) {
        const [text, tone] = withRedirect(
          String(t.common?.changesSaved || "Changes saved successfully!"),
          "success",
        );
        showInfoBox(text, tone);
      } else if (redirectMessage) {
        // A translate-triggered save shows no message of its own — but the
        // redirect outcome still has to reach the merchant.
        showInfoBox(
          redirectMessage.text,
          redirectMessage.tone
        );
      }

      // Update original alt-texts to match current values (so hasChanges becomes false)
      // -- of the view the save was made from only.
      if (!answerViewMoved) {
        setOriginalAltTexts(
          restrictAltBaseline(
            keepFailedAltsDirty(altBaselineAfterCopy, copyFailedAlts, sentAltsForBaseline),
            partial ? (partial.altIndices ?? []) : null,
          ),
        );
      }

      // For templates: Do NOT eagerly update originalTemplateValuesRef here.
      // Using the current editableValues would incorrectly bake in any manual edits
      // the user made after the save was submitted, making hasChanges=false and
      // blocking subsequent saves. The data loading effect (after revalidation) sets
      // originalTemplateValuesRef from resolve() which is always correct.
      // The isLoadingData=true guard in templateHasFieldChanges covers the gap.
      if (isThemeContentType(config.contentType)) {
        // For foreign locale saves: update localTranslationsRef so isFieldTranslated
        // and hasLocaleMissingTranslations return correct results IMMEDIATELY —
        // without waiting for revalidation. No item mutation needed; resolve()
        // reads localTranslationsRef with higher priority than item.translations.
        const savedLocale = savedLocaleRef.current;
        if (savedLocale && savedLocale !== primaryLocale) {
          // Fold the market the save was submitted under into the overlay key,
          // exactly like resolve()/onSaveComplete. Without this a market-scoped
          // save writes under the plain (global) locale key, leaking the market
          // value into the global layer (and it survives revalidation).
          const savedLocaleKey = buildLocaleKey(savedLocale, savedMarketIdRef.current);
          effectiveFieldDefinitions.forEach((field) => {
            const value = editableValues[field.key];
            const tKey = field.translationKey;

            // Update localTranslationsRef for isFieldTranslated
            if (!localTranslationsRef.current[tKey]) {
              localTranslationsRef.current[tKey] = {};
            }
            if (value && value.trim()) {
              localTranslationsRef.current[tKey][savedLocaleKey] = value;
            } else {
              delete localTranslationsRef.current[tKey][savedLocaleKey];
            }
          });
        }
      }

      // For metaobjects: Do NOT eagerly update originalLoadedValuesRef with current
      // editableValues — same reason as templates above. The data loading effect
      // sets it correctly after revalidation. isLoadingData=true covers the gap.

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
      inFlightToastRef.current = null;
      // Refused: the value was NOT stored, so it reads as a draft again (its
      // baseline never moved) and the Save button can send it.
      settleOwnSaveFor(inFlightPartialRef.current);
      inFlightPartialRef.current = null;
      setIsSaving(false);

      // Clear a copy ("Übertragen") spinner on failure too — otherwise the field's
      // buttons keep spinning forever after a failed Shopify save.
      // Keyed on the item the copy was SAVED for, not the one on screen now.
      if (pendingCopyFieldKeyRef.current) {
        const failedFieldItemId = pendingCopyFieldItemIdRef.current ?? savedItemIdRef.current;
        if (failedFieldItemId) markOperationFailed(failedFieldItemId, pendingCopyFieldKeyRef.current);
        pendingCopyFieldKeyRef.current = null;
        pendingCopyFieldItemIdRef.current = null;
        // Nothing was saved: the overlay value, baselines and visible value
        // the copy wrote up front go back to what Shopify holds.
        rollbackCopyField();
      }
      if (pendingCopyAltTextIndexRef.current !== null) {
        const failedAltItemId = getPendingCopyAltItemId() ?? savedItemIdRef.current;
        if (failedAltItemId) {
          markOperationFailed(failedAltItemId, `altText_${pendingCopyAltTextIndexRef.current}`);
        }
        pendingCopyAltTextIndexRef.current = null;
        rollbackCopyAltText();
      }

      const isSavedItemCurrent = savedItemIdRef.current === selectedItemIdRef.current;
      savedItemIdRef.current = null;

      if (isSavedItemCurrent) {
        const translatedError =
          localizedUnconfirmedFields(fetcher.data) ||
          translateErrorMessage(String(fetcher.data.error || ""), t);
        showInfoBox(translatedError, "critical");
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
      settleOwnSaveFor(inFlightPartialRef.current);
      inFlightPartialRef.current = null;
      isSaveFromTranslateRef.current = false;
      inFlightToastRef.current = null;
      setIsSaving(false);

      // A refused copy must not leave its spinner behind either.
      // Keyed on the item the copy was SAVED for, not the one on screen now.
      if (pendingCopyFieldKeyRef.current) {
        const failedFieldItemId = pendingCopyFieldItemIdRef.current ?? savedItemIdRef.current;
        if (failedFieldItemId) markOperationFailed(failedFieldItemId, pendingCopyFieldKeyRef.current);
        pendingCopyFieldKeyRef.current = null;
        pendingCopyFieldItemIdRef.current = null;
        // Nothing was saved: the overlay value, baselines and visible value
        // the copy wrote up front go back to what Shopify holds.
        rollbackCopyField();
      }
      if (pendingCopyAltTextIndexRef.current !== null) {
        const failedAltItemId = getPendingCopyAltItemId() ?? savedItemIdRef.current;
        if (failedAltItemId) {
          markOperationFailed(failedAltItemId, `altText_${pendingCopyAltTextIndexRef.current}`);
        }
        pendingCopyAltTextIndexRef.current = null;
        rollbackCopyAltText();
      }

      const isSavedItemCurrent = savedItemIdRef.current === selectedItemIdRef.current;
      savedItemIdRef.current = null;

      if (isSavedItemCurrent) {
        const errorKey = String((fetcher.data as { errorKey?: string }).errorKey);
        const errorMessage =
          (t.content as Record<string, string>)?.[errorKey] ||
          errorKey;
        showInfoBox(errorMessage, "critical");

        // Auto-restore empty fields to their original values (discard empty edits)
        if (isThemeContentType(config.contentType) && originalTemplateValuesRef.current) {
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
    } else if (
      fetcher.data &&
      !fetcher.data.success &&
      !('error' in fetcher.data) &&
      !('errorKey' in fetcher.data) &&
      isSavePendingRef.current &&
      ((fetcher.data as { actionType?: string }).actionType ?? "updateContent") === "updateContent"
    ) {
      // A refusal that names neither an error nor a key: still the save's
      // answer. Left alone, the pending flag stuck and refused every later
      // "translate all" as racing a save that had long ended.
      processedSaveResponseRef.current = fetcher.data;
      isSavePendingRef.current = false;
      settleOwnSaveFor(inFlightPartialRef.current);
      inFlightPartialRef.current = null;
      isSaveFromTranslateRef.current = false;
      inFlightToastRef.current = null;
      setIsSaving(false);
      // A copy that was refused stops its spinner and gives back what it
      // wrote up front, exactly like the error branches above.
      if (pendingCopyFieldKeyRef.current) {
        const failedFieldItemId = pendingCopyFieldItemIdRef.current ?? savedItemIdRef.current;
        if (failedFieldItemId) markOperationFailed(failedFieldItemId, pendingCopyFieldKeyRef.current);
        pendingCopyFieldKeyRef.current = null;
        pendingCopyFieldItemIdRef.current = null;
        rollbackCopyField();
      }
      if (pendingCopyAltTextIndexRef.current !== null) {
        const failedAltItemId = getPendingCopyAltItemId() ?? savedItemIdRef.current;
        if (failedAltItemId) markOperationFailed(failedAltItemId, `altText_${pendingCopyAltTextIndexRef.current}`);
        pendingCopyAltTextIndexRef.current = null;
        rollbackCopyAltText();
      }
      if (savedItemIdRef.current === selectedItemIdRef.current) {
        showInfoBox(translateErrorMessage("", t), "critical");
      }
      savedItemIdRef.current = null;
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

    const actionType = (fetcher.data as { actionType?: string }).actionType;
    const fieldType = (fetcher.data as { fieldType?: string }).fieldType;
    const errorMsg = String(fetcher.data.error || "");

    // For single-field translation errors: show the error inside the field instead of a banner
    if ((actionType === "translateField" || actionType === "translateFieldToAllLocales") && fieldType) {
      setFieldErrors(prev => ({ ...prev, [fieldType]: errorMsg }));
      return;
    }

    const translatedError = translateErrorMessage(errorMsg, t);
    showInfoBox(translatedError, "critical");
  }, [fetcher.data, showInfoBox, t]);

  // Clear justSubmittedRef when fetcher picks up the request (state leaves 'idle')
  // or when it returns to idle (request completed). This ensures the synchronous
  // double-submit guard in safeSubmit only blocks within the same tick.
  useEffect(() => {
    justSubmittedRef.current = false;
    // A submission going out IS the request scope for whatever comes back on
    // this fetcher — read here rather than when the answer lands, since the
    // merchant can switch item or language in between.
    if (fetcher.state === "submitting") fetcherScopeRef.current = suggestionScopeRef.current;
  }, [fetcher.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // Backstop for the own-save cover: the fetcher went idle with nothing
  // queued, so no own save is on its way any more. An answer the handlers
  // above did not recognise (or a request that never answered) must not leave
  // a field reading "saved" for good. Runs BEFORE the queue effect below, which
  // empties the queue as it submits — a queued own save stays covered.
  // A save submitted in THIS effect flush (a response handler above that
  // chains the next own save, e.g. Accept & Translate) still reads "idle"
  // here: its entry is kept — `justSubmittedRef` is true until the microtask
  // after the submit, i.e. exactly for the rest of this flush.
  useEffect(() => {
    if (fetcher.state !== "idle" || saveQueueRef.current.length > 0) return;
    const justSubmitted = justSubmittedRef.current ? inFlightPartialRef.current : null;
    setOwnSavesInFlight((prev) => backstopOwnSaves(prev, justSubmitted));
  }, [fetcher.state]);

  // Process queued saves when the fetcher becomes idle.
  // IMPORTANT: This effect MUST run AFTER the response handler effects above,
  // which read savedLocaleRef.current to process the completed save's response.
  // React runs effects in definition order, so placing this after ensures the
  // response handler clears savedLocaleRef before we overwrite it for the next queued save.
  useEffect(() => {
    if (fetcher.state === 'idle' && saveQueueRef.current.length > 0) {
      // The first save nothing holds back (a "translate all" run into its
      // language -- any run for a primary save -- or a primary save of the
      // same item ahead of it); saves of one language keep their order.
      const index = saveQueueRef.current.findIndex(
        (entry, position) =>
          entry.formData.get("action") !== "updateContent" ||
          !saveBlockedByTranslateRunRef.current(entry.savedLocale ?? null, entry.savedItemId ?? null, position),
      );
      if (index < 0) return;
      const [next] = saveQueueRef.current.splice(index, 1);
      debugLog.submit(' Processing queued save, locale:', next.savedLocale, ', item:', next.savedItemId, ', remaining in queue:', saveQueueRef.current.length);

      // Restore metadata for this queued save
      savedLocaleRef.current = next.savedLocale;
      savedMarketIdRef.current = next.savedMarketId;
      savedItemIdRef.current = next.savedItemId;
      inFlightPartialRef.current = next.partial;
      inFlightToastRef.current = next.successToast;
      inFlightScopeRef.current = {
        locale: next.savedLocale ?? "",
        marketId: next.savedMarketId ?? "",
        sentAlts: sentAltsFromForm(next.formData.get("imageAltTexts")),
        sentFields: sentFieldsFromForm(next.formData.entries()),
      };
      isSavePendingRef.current = true;
      // A save held behind a "translate all" run: another view's answer may
      // have reset the busy flag meanwhile.
      setIsSaving(true);

      try {
        fetcherRef.current.submit(next.formData, next.options);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          debugLog.submit(' AbortError on queued save (ignored)');
          // No answer will come: nothing may keep reading as saving.
          isSavePendingRef.current = false;
          setIsSaving(false);
        } else {
          // The queued request never left: settle exactly what the direct
          // submit's catch settles (useEditorAutoSave.safeSubmit), or its
          // own-save entry, the in-flight slots and the pending flag stick.
          settleUnsentSave({
            partial: next.partial,
            successToast: next.successToast,
            setOwnSavesInFlight,
            inFlightPartialRef,
            inFlightToastRef,
            inFlightScopeRef,
            isSavePendingRef,
          });
          throw error;
        }
      }
    }
  }, [fetcher.state, translateRunsVersion]);


  // ============================================================================
  // DERIVED STATE: isSavingCurrentItem
  // Must be computed BEFORE useFieldHandlers which uses it for navigation guards.
  // Derived from what is TRUE now, never from a flag a lost answer can leave
  // set (`isSaving` alone stuck after an item switch and an aborted queued
  // submit): the fetcher carrying a save of THIS item -- "submitting", and
  // "loading" too, the render in which its answer lands before the response
  // effect has moved the baseline (counting it idle there flickered the dirty
  // state on) -- or a save of this item waiting in the queue (held behind a
  // "translate all" run of its language).
  // ============================================================================
  const isSavingCurrentItem =
    !!selectedItemId &&
    ((fetcher.state !== "idle" &&
      (isSaveScopeOf(inFlightScopeRef.current, selectedItemId) || (isSaving && savedItemIdRef.current === selectedItemId))) ||
      saveQueueRef.current.some(
        (entry) => entry.savedItemId === selectedItemId && entry.formData.get("action") === "updateContent",
      ));

  // ============================================================================
  // FIELD EVENT HANDLERS (extracted to useFieldHandlers)
  // ============================================================================

  const {
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
  } = useFieldHandlers({
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
    originalAltTextsRef,
    localAltTextOverlayRef,
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
    refuseOwnSave,
    refuseTranslateRun,
    deletedMarksOfSavesOut,
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
  });

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  const isFieldTranslated = (fieldKey: string): boolean => {
    if (!selectedItem) return false;
    const field = effectiveFieldDefinitions.find((f) => f.key === fieldKey);
    if (!field) return false;

    // Market-aware: a market override may exist without a global row, so fold the
    // selected market into every lookup (mirrors resolve()). marketId "" keeps the
    // plain global keys, so global behaviour is unchanged.
    const marketId = selectedMarketId;

    // Phase 4: Check deletedTranslationKeysRef FIRST — if a field was cleared,
    // it should appear untranslated even if item.translations still has old data.
    if (isMarkedDeleted(deletedTranslationKeysRef.current, field.translationKey, marketId, currentLanguage)) {
      return false;
    }

    // Check localTranslationsRef (from translateFieldToAllLocales / saves)
    // This ensures immediate UI feedback before revalidation completes
    const localeKey = buildLocaleKey(currentLanguage, marketId);
    const localValue = localTranslationsRef.current[field.translationKey]?.[localeKey];
    if (localValue) {
      return true;
    }

    // Market-specific DB row (marketTranslations), if any for the selected market.
    if (marketId && selectedItem.marketTranslations?.[marketId]?.[field.translationKey]?.[currentLanguage]) {
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

  const isPrimaryFieldUnsaved = (fieldKey: string): boolean =>
    !isLoadingData &&
    isUnsavedPrimarySource({
      currentLanguage,
      primaryLocale,
      value: editableValues[fieldKey],
      baseline: baselineValuesRef.current[fieldKey],
    });

  /** Any primary draft the whole-item "Translate all" would take as its
   *  source (a translatable field or an alt text) — the button waits for Save. */
  const hasUnsavedTranslateAllSource = (): boolean =>
    currentLanguage === primaryLocale &&
    (effectiveFieldDefinitions.some((f) => isTranslatableFieldDefinition(f) && isPrimaryFieldUnsaved(f.key)) ||
      hasUnsavedPrimaryAlts());

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
    if (isThemeContentType(config.contentType)) {
      originalTemplateValuesRef.current = { ...values };
      originalLoadedValuesRef.current = { ...values };
      baselineValuesRef.current = { ...values };
      setTemplateValuesVersion(v => v + 1);
      setBaselineVersion(v => v + 1);
    }
  };

  // Atomically replace ALL editable values and original values for templates after a reload.
  // This avoids race conditions from 25+ individual setEditableValue calls and ensures
  // editableValues and originalLoadedValuesRef are updated in a single React batch.
  const reloadTemplateValues = useCallback((values: Record<string, string>) => {
    if (!isThemeContentType(config.contentType)) return;
    debugLog.dataLoad(' reloadTemplateValues - atomic update with', Object.keys(values).length, 'fields');
    setEditableValues(values);
    originalTemplateValuesRef.current = { ...values };
    originalLoadedValuesRef.current = { ...values };
    baselineValuesRef.current = { ...values };
    // Mark initial load as successful so retry mechanism doesn't interfere
    initialLoadSuccessfulRef.current = true;
    retryCountRef.current = 0;
    setTemplateValuesVersion(v => v + 1);
    setBaselineVersion(v => v + 1);
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
    selectedMarketId,
    markets,
    editableValues,
    aiSuggestions,
    htmlModes,
    hasChanges,
    enabledLanguages,
    imageAltTexts,
    fallbackAltTextIndices,
    altTextSuggestions,
    isClearAllModalOpen,
    isInitialDataReady,
    isLoadingData,
    isLoadingImages,
    fallbackFields,
    loadingFieldKeys,
    selectedImageIndex,
    images: selectedItem?.images || [],
    featuredImage: selectedItem?.featuredImage || null,
    isSavingCurrentItem,
    fieldErrors,
  };

  const handlers: EditorHandlers = {
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
    handleAltTextChange,
    handleGenerateAltText,
    handleGenerateAllAltTexts,
    handleCopyAltText,
    handleCopyAltTextToAllLocales,
    handleTranslateAltText,
    handleTranslateAltTextToAllLocales,
    handleTranslateAllAltTexts,
    handleTranslateAllAltTextsForLocale,
    handleAcceptAltTextSuggestion,
    handleAcceptAndTranslateAltText,
    handleRejectAltTextSuggestion,
    setSelectedImageIndex,
  };

  // Helper function to check if a specific field is currently loading
  const isFieldLoading = useCallback((fieldKey: string, action?: string) => {
    // Check if this exact field key is in the loading set
    return loadingFieldKeys.has(fieldKey);
  }, [loadingFieldKeys]);

  const getValidationOverlays = useCallback((): ValidationOverlays => ({
    savedPrimaryValues: selectedItem?.id
      ? savedPrimaryValuesRef.current[selectedItem.id]
      : undefined,
    localTranslations: localTranslationsRef.current,
    deletedKeys: deletedTranslationKeysRef.current,
  }), [selectedItem?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    handlers,
    selectedItem: selectedItem || null,
    helpers: {
      getFieldBackgroundColor,
      isFieldTranslated,
      getEditableValue,
      setEditableValue,
      setOriginalTemplateValues,
      reloadTemplateValues,
      triggerDataRefresh,
      isFieldLoading,
      getValidationOverlays,
      validationVersion: baselineVersion,
      /**
       * Save-first gating: the PRIMARY value a copy/translate-to-all button
       * would take as its source is an unsaved draft. Such a button is
       * disabled until it is saved — its write into every language would be
       * purged by that later Save. Always false on a foreign locale.
       */
      isPrimaryFieldUnsaved,
      isPrimaryAltUnsaved,
      hasUnsavedPrimaryAlts,
      hasUnsavedTranslateAllSource,
      /** An AI/copy button's own save is on its way: a view switch is refused
       *  (with a message) until it is answered. */
      isOwnSaveInFlight,
      /**
       * Hand a save response from a fetcher this hook does NOT own to the ONE
       * background-task watcher. The product page's sub-resource save is the
       * case that needs it: it runs on its own fetcher (deliberately — a shared
       * one would let one response prune the other's bookkeeping), so its
       * re-translation task ids would otherwise never be watched by anything.
       * A response without ids is ignored, so it is always safe to call.
       */
      trackRetranslationTasks,
      /** Watched runs that have not finished — for a quiet "still writing the
       *  translations" hint. Nothing is required to render it. */
      pendingRetranslationCount,
      /** Bumped once per completed background refresh — for a card this hook
       *  does not resolve and that has to re-read on its own. */
      backgroundRefreshVersion,
      /** Report unsaved work held OUTSIDE this hook (see `externalUnsavedChanges`). */
      setExternalUnsavedChanges,
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
