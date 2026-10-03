/**
 * useProductSubResources - State management for product option & metafield translations
 *
 * Data flow (same pattern as main product translations):
 * 1. DB pre-load: Loader reads ContentTranslation from DB → item.subResourceTranslations
 *    → Hook reads synchronously for instant display
 * 2. Shopify fetch: Hook triggers fetcher POST → server loads from Shopify for any missing
 *    → merges into state (catches translations from Translate & Adapt)
 *
 * Manages:
 * - Reading pre-loaded translations from item data (DB pipeline)
 * - Fetching from Shopify for translations not yet in DB
 * - Tracking local edits
 * - Saving changes to Shopify + DB
 * - AI translation per sub-resource
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useFetcher } from "react-router";
import type { FetcherWithComponents } from "react-router";
import {
  markSubResourceActive,
  markSubResourceCompleted,
  useTranslatingSubResourceIds,
} from "./useAIOperationsStore";
import type { OptionTranslation } from "../components/unified/OptionsField";
import type { TranslatableContentItem, TranslationStrings } from "../types/content-editor.types";
import { translateErrorMessage } from "../utils/editor-error-messages";
import { buildLocaleKey, LOCALE_MARKET_SEP } from "./useUiDataLoader";
import { runPerLocaleSavesDetailed, copyOutcomeMessage } from "../services/editor/per-locale-saves.shared";
import { subResourceOutcome } from "../services/editor/sub-resource-outcome.shared";
import { useLatestRef } from "./useLatestRef";
import { postJsonSave, rollbackSubResourceCopy } from "../services/editor/sub-resource-copy.shared";
import {
  hasPendingSubResourceChanges,
  unconfirmedPurgeOf,
  withoutIds,
  type SubResourcePendingState,
} from "../services/editor/sub-resource-pending.shared";
import {
  changedIdsOfPrimarySave,
  dropOverlayForPrimaryChange,
  overlayKeepingOnly,
  answerWithoutDirty,
  dropGlobalStagedFor,
  pruneOverlayStamps,
  pruneExpiredOverlay,
  recordConfirmedForeignSave,
  stampOverlay,
  type OverlayStamps,
  stageTranslateAnswer,
  translateAnswerPlan,
  updateKeepIds,
  savedIdsAfterPartialSave,
  type TranslateTarget,
} from "../services/editor/sub-resource-overlay.shared";
import { CONTENT_EDITOR_ACTION_ENDPOINT, setContentEditorPage } from "../services/editor/content-action-endpoint.shared";
import {
  applyStagedMetafieldClears,
  applyStagedOptionClears,
  buildClearAllSubResourcePayload,
  confirmedClearIds,
  settleClearAll,
  stageClearAll,
  subResourceSaveRacesRun,
} from "../services/editor/sub-resource-clear.shared";
import { retirePurgedMarketResources } from "~/services/editor/sub-resource-market-purge.shared";

/**
 * Where this hook's plain-`fetch` requests go. NOT `/app/products`: that is a
 * page route, and a plain POST to it is answered with the rendered HTML
 * document, so the JSON this hook reads never arrives -- every successful
 * translate then reported "failed". It is the one content-editor door; each
 * request names `/app/products` as its page (see api.content-editor-action.tsx).
 */
const SUB_RESOURCE_ENDPOINT = CONTENT_EDITOR_ACTION_ENDPOINT;

/** Response shape from sub-resource API actions */
interface SubResourceFetcherData {
  success: boolean;
  actionType?: string;
  translations?: Record<string, Record<string, string>>;
  /** translate-to-all-locales: the CONFIRMED values, locale -> resource -> key. */
  localeTranslations?: Record<string, Record<string, Record<string, string>>>;
  fieldId?: string;
  failedResources?: string[];
  savedResources?: string[];
  failedLocales?: string[];
  translatedLocales?: string[];
  /** Resource ids whose key has no digest at Shopify: not writable, not a failure. */
  notTranslatable?: string[];
  failedOptions?: string[];
  failedMetafields?: string[];
  /** Failure CODES from the option write paths; the client owns the wording. */
  optionWarnings?: string[];
  /** Create / delete / reorder failures, which carry no option id. */
  structuralFailures?: number;
  removedOptionIds?: string[];
  /** The server's sentence (or the plan refusal's code "gated") when `success` is false. */
  error?: string;
  /** Ids of detached repairs a save started, offered even when the save failed. */
  retranslationTaskIds?: string[];
  /** Sub-resources whose MARKET overrides the primary save's purge CONFIRMED removed. */
  marketPurgedResourceIds?: string[];
}

// ============================================================================
// Concurrent requests -- module scope on purpose
// ============================================================================
//
// A merchant can press several translate buttons in a row (an option's name,
// three of its values, two metafields, "translate all"). Every one of those is
// its OWN plain `fetch` with its own answer and its own spinner -- never a
// `useFetcher`, whose second `submit()` aborts the first request on the
// client: the first answer is then never read (its value never shows, although
// Shopify stored it) and its spinner hangs until the store's ten-minute timeout.
//
// The spinner store is keyed by (item, field), and two requests can hold the
// same key at once ("translate all" marks every field, and an individual
// button of one of those fields may already be running). A request that ends
// may only take down a spinner nobody else still holds, so the marks are
// COUNTED. Module scope, not a ref: the store outlives the hook, and a request
// started by one mount settles its count whichever mount is current.
const spinnerHolds = new Map<string, number>();

export function beginSubResourceSpinner(itemId: string, fieldId: string, action: string): void {
  const key = `${itemId}::${fieldId}`;
  spinnerHolds.set(key, (spinnerHolds.get(key) ?? 0) + 1);
  markSubResourceActive(itemId, fieldId, action);
}

export function endSubResourceSpinner(itemId: string, fieldId: string): void {
  const key = `${itemId}::${fieldId}`;
  const left = (spinnerHolds.get(key) ?? 1) - 1;
  if (left > 0) {
    spinnerHolds.set(key, left);
    return;
  }
  spinnerHolds.delete(key);
  markSubResourceCompleted(itemId, fieldId);
}

/** Test seam: forget every counted hold. */
export function __resetSubResourceSpinnerHolds(): void {
  spinnerHolds.clear();
}

/**
 * One request to the content editor's JSON door. Never throws: a network
 * failure, a non-JSON body (a proxy page, a 502) and an empty body all come
 * back as `null`, which every caller treats as a failed request -- the spinner
 * is settled by the caller's `finally` either way.
 */
async function postSubResourceRequest(fd: FormData): Promise<SubResourceFetcherData | null> {
  try {
    const resp = await fetch(SUB_RESOURCE_ENDPOINT, {
      method: "POST",
      body: setContentEditorPage(fd, "/app/products"),
    });
    const data = (await resp.json().catch(() => null)) as SubResourceFetcherData | null;
    if (!data || typeof data !== "object") return null;
    // A 4xx/5xx JSON body that forgot to say `success: false` is still a failure.
    if (resp.ok === false && data.success !== false) return { ...data, success: false };
    return data;
  } catch {
    return null;
  }
}

/**
 * Merges a translations map ({ resourceId: { key: value } }) into the option
 * state, FIELD BY FIELD: a value the map carries replaces that one field, a
 * field it does not carry keeps what is there. Several answers land in any
 * order, each naming only its own fields, so replacing an option's whole entry
 * (or dropping a value because the option had no entry yet) lost the answers
 * that came first.
 */
export function mergeOptionTranslations(
  prev: Record<string, OptionTranslation>,
  item: Pick<TranslatableContentItem, "options"> | null | undefined,
  translations: Record<string, Record<string, string>>,
): Record<string, OptionTranslation> {
  let next = prev;
  for (const opt of item?.options || []) {
    const nameValue = translations[opt.id]?.name;
    const valueHits: Array<[number, string]> = [];
    opt.values.forEach((v, i) => {
      const value = v.id ? translations[v.id]?.name : undefined;
      if (value) valueHits.push([i, value]);
    });
    if (!nameValue && valueHits.length === 0) continue;
    const existing = next[opt.id] ?? { name: "", values: opt.values.map(() => "") };
    const values = [...existing.values];
    for (const [i, value] of valueHits) values[i] = value;
    if (next === prev) next = { ...prev };
    next[opt.id] = { ...existing, name: nameValue || existing.name, values };
  }
  return next;
}

/** The metafield half of `mergeOptionTranslations`. */
export function mergeMetafieldTranslations(
  prev: Record<string, string>,
  item: Pick<TranslatableContentItem, "metafields"> | null | undefined,
  translations: Record<string, Record<string, string>>,
): Record<string, string> {
  let next = prev;
  for (const mf of item?.metafields || []) {
    const value = translations[mf.id]?.value;
    if (!value) continue;
    if (next === prev) next = { ...prev };
    next[mf.id] = value;
  }
  return next;
}

/** What a single-option "Copy" wrote up front, carried by ITS own request. */
interface CopyRecord {
  itemId: string;
  locale: string;
  marketId: string;
  overlayKey: string;
  resourceId: string;
  value: string;
  previous: string | undefined;
}

/** How long a translate answer stays protected from a reload's overlay reset. */
const RECENT_TRANSLATE_KEEP_MS = 2 * 60 * 1000;

export interface SubResourceState {
  /** Option translations keyed by option GID → { name, values[] } */
  optionTranslations: Record<string, OptionTranslation>;
  /** Metafield translations keyed by metafield GID → translated value */
  metafieldTranslations: Record<string, string>;
  /** Primary locale option edits keyed by option GID → { name, values[] } */
  primaryOptionEdits: Record<string, { name: string; values: string[] }>;
  /** Pending structural edits, so the card can render them before the save. */
  optionValuesToAdd: Record<string, string[]>;
  /** Metaobject entries queued on a LINKED option: its values are entries, not
   *  free text, so they are added by naming the entry. */
  optionLinkedValuesToAdd: Record<string, Array<{ id: string; name: string }>>;
  optionValuesToDelete: Record<string, string[]>;
  optionsToCreate: Array<{ name: string; values: string[] }>;
  optionsToDelete: string[];
  /** Values in their dragged order, per option id. */
  optionValueOrder: Record<string, string[]>;
  /** Incremented on every landed save. The variants card drops its cached
   *  variant counts on it — a save that added a value moved the matrix. */
  savedNonce: number;
  /**
   * Options whose primary text may not be translated right now: the merchant
   * changed the option (a renamed name or value, a value added or removed) and
   * has not saved, or saved and the item has not been reloaded yet. The
   * translate request sends the CACHED text as its source, so translating in
   * either window translates the text the merchant just replaced.
   */
  optionTranslationBlockedIds: Set<string>;
  /** Primary locale metafield edits keyed by metafield GID → value */
  primaryMetafieldEdits: Record<string, string>;
  /** Set of field IDs currently being translated (e.g. "optId:name", "optId:value:0") */
  translatingFieldIds: Set<string>;
  /**
   * Resource GIDs (option / option-value / metafield) whose displayed value is
   * inherited from the global value while a non-global market is selected. The
   * UI greys these out + italic, like the main fields' fallbackFields. Keyed by
   * resourceId: opt.id (name), val.id (value), mf.id (metafield value).
   */
  fallbackResourceIds: Set<string>;
  /** Whether there are unsaved changes */
  hasChanges: boolean;
  /**
   * Set by the products page: a PRIMARY draft outside the content fields that
   * the whole-item "Translate all" would translate from its saved value and the
   * later Save would purge — an edited metafield, or an alt text drafted in the
   * image manager. (Edited OPTIONS are already left out of that run, see
   * `optionTranslationBlockedIds`.) The button waits for Save while it is true.
   */
  translateAllSaveFirst?: boolean;
  /**
   * Translations written by a copy / translate and not yet in the loaded item,
   * `{ locale: { resourceId: { key: value } } }` (market-folded keys for market
   * layers). Read-only for callers; `overlayVersion` changes when it does.
   */
  localOverlay: Record<string, Record<string, Record<string, string>>>;
  overlayVersion: number;
  /** Whether translations are loading from Shopify */
  isLoading: boolean;
  /** Whether sub-resources are currently being saved */
  isSaving: boolean;
}

export interface SubResourceHandlers {
  handleOptionNameChange: (optionId: string, value: string) => void;
  handleOptionValueChange: (optionId: string, valueIndex: number, value: string) => void;
  handleMetafieldChange: (metafieldId: string, value: string) => void;
  handlePrimaryOptionNameChange: (optionId: string, value: string) => void;
  handlePrimaryOptionValuesChange: (optionId: string, values: string[]) => void;
  /** A value the merchant added. Shopify assigns its GID on save. */
  handleAddOptionValue: (optionId: string, name: string) => void;
  /** Queue a metaobject entry on a LINKED option. */
  handleAddLinkedOptionValue: (optionId: string, entry: { id: string; name: string }) => void;
  /** Drop a queued metaobject entry again, by its GID. */
  handleRemoveLinkedOptionValue: (optionId: string, entryId: string) => void;
  /** A value the merchant removed. An empty `valueId` means it was only added
   *  locally, so `addedIndex` says which pending entry to drop. */
  handleRemoveOptionValue: (optionId: string, valueId: string, addedIndex?: number) => void;
  /** Rename a value that exists only locally, by its index in the pending list. */
  handleEditPendingValue: (optionId: string, index: number, name: string) => void;
  handleCreateOption: (name: string, values: string[]) => void;
  /** Drops a not-yet-saved option again. Nothing was written, so nothing is
   *  lost — without it a mistyped option could only be undone by discarding
   *  every other pending edit with it. */
  handleCancelCreateOption: (index: number) => void;
  handleDeleteOption: (optionId: string) => void;
  handleReorderOptions: (orderedIds: string[]) => void;
  /** Values in their new order, for one option. Their order decides which
   *  variant the storefront shows first. */
  handleReorderOptionValues: (optionId: string, orderedValueIds: string[]) => void;
  handlePrimaryMetafieldChange: (metafieldId: string, value: string) => void;
  translateOption: (optionId: string) => void;
  translateOptionField: (optionId: string, fieldType: "name" | "value", valueIndex?: number) => void;
  copyOptionField: (optionId: string, fieldType: "name" | "value", valueIndex?: number) => void;
  copyOptionFieldToAllLocales: (optionId: string, fieldType: "name" | "value", valueIndex?: number) => void;
  /** Copies an option's name and (unless linked) every value into all foreign
   *  locales, verbatim — the whole-option twin of `copyOptionFieldToAllLocales`. */
  copyOptionToAllLocales: (optionId: string) => void;
  translateMetafield: (metafieldId: string) => void;
  translateAllSubResources: () => void;
  translateAllSubResourcesToAllLocales: () => void;
  saveSubResources: () => void;
  /**
   * The sub-resource half of the editor's "clear all" in a FOREIGN locale:
   * removes every option name, option value and metafield translation of the
   * viewed layer (selected market, else global). Echo-verified on the server;
   * the fields are emptied at once and a removal that fails is put back.
   */
  clearAllForLocale: () => void;
  /** Whether a "translate all" of the options & metafields is writing INTO
   *  `locale` of `itemId` now (its own language, or every language). */
  isTranslateAllRunning: (itemId: string, locale: string) => boolean;
  /** Whether a save of the card (its "clear all", or the options & metafields
   *  save) is out for `itemId` in `locale` ("*" = any language; a PRIMARY
   *  save counts for every language): a "translate all" must not race it. */
  isSaveInFlight: (itemId: string, locale: string) => boolean;
  resetChanges: () => void;
  resetForReload: () => void;
  /**
   * Re-read the translations of the CURRENT item/locale/market from the item
   * the loader just delivered — for a background re-translation that finished.
   * Unlike `resetForReload` it resets nothing: a pending option, a reorder or
   * a typed translation is the merchant's, so with anything unsaved it does
   * nothing at all, and the page's refresh is held back anyway until those
   * changes are saved or discarded.
   */
  refreshTranslations: () => void;
}

// Only MESSAGE strings — the box has no title (see InfoBoxContext), so the
// `saveFailed` / `validationError` / `success` headings this used to carry
// have no reader and are gone rather than passed and dropped.
interface UseProductSubResourcesStrings {
  optionsSavedSuccess?: string;
  /** "Translation saved for all languages" -- the primary-locale translate of an option. */
  optionTranslatedAll?: string;
  /** A primary save that could not confirm the removal of stale foreign translations. */
  translationPurgeUnconfirmed?: string;
  /** Fallback when a sub-resource translate fails without a server message. */
  translateFailed?: string;
  /** "Copied" / "Copying failed for: {locales}" -- the copy to all languages reports per locale. */
  copied?: string;
  copyFailedLocales?: string;
  /** Shown instead of the locale list when the plan gate refused the copy. */
  upgradeRequired?: string;
  saveFailedOptions?: string;
  /** "{count} field(s) could not be saved in Shopify." */
  translateSubResourcesFailed?: string;
  /** "Translation partially completed: {successCount}/{totalCount} ... {failedLocales} failed." */
  translatePartialLocales?: string;
  /** "This field cannot be translated in Shopify." */
  subResourceNotTranslatable?: string;
  saveFailedItems?: string;
  /** Generic answer to a request that failed as a whole (no per-item lists). */
  subResourcesRequestFailed?: string;
  optionNameEmpty?: string;
  optionValuesEmpty?: string;
  metafieldValuesEmpty?: string;
  /** One per `OptionWriteWarning` code, e.g. `optionWarning_optionLastOne`.
   *  Indexed rather than listed: the server owns the code list, and a missing
   *  entry drops that reason instead of printing an English one. */
  [optionWarning: `optionWarning_${string}`]: string | undefined;
}

interface UseProductSubResourcesProps {
  selectedItem: TranslatableContentItem | null;
  currentLanguage: string;
  primaryLocale: string;
  /** Selected market ("" = global). Sub-resource values resolve/save per market. */
  selectedMarketId?: string;
  /** Enabled shop locales — needed for copy-to-all-locales */
  enabledLanguages?: string[];
  /** @deprecated No longer used — hook creates its own fetcher to avoid shared-fetcher race conditions */
  fetcher?: FetcherWithComponents<any>;
  revalidator?: { revalidate: () => void; state: string };
  /**
   * Every response of this hook's OWN fetcher, handed to the editor's single
   * background-task watcher.
   *
   * The sub-resource save starts its own detached re-translation (a product's
   * options, option values and metafields are one group and one Task row), and
   * this fetcher is deliberately separate from the editor's — so without this
   * the one surface whose translations have neither a webhook nor a sync would
   * be the only one nothing ever waited for.
   */
  onSaveResponse?: (response: unknown) => void;
  showInfoBox?: (message: string, tone?: "success" | "info" | "warning" | "critical") => void;
  strings?: UseProductSubResourcesStrings;
}

/**
 * Helper: Build option + metafield translation state from a flat translations map.
 * Used for both DB pre-loaded data and Shopify fetcher responses.
 *
 * @param item - The selected product item
 * @param translations - Map of resourceId → { key: value } (e.g. { "gid://...Option/123": { name: "Farbe" } })
 */
function buildFromTranslationsMap(
  item: TranslatableContentItem | null,
  translations: Record<string, Record<string, string>>,
): {
  optionTranslations: Record<string, OptionTranslation>;
  metafieldTranslations: Record<string, string>;
} {
  const optionTranslations: Record<string, OptionTranslation> = {};
  const metafieldTranslations: Record<string, string> = {};

  if (!item) return { optionTranslations, metafieldTranslations };

  for (const opt of item.options || []) {
    const optTrans = translations[opt.id];
    const optName = optTrans?.name || "";

    const valueTranslations: string[] = opt.values.map(val => {
      if (!val.id) return "";
      const valTrans = translations[val.id];
      return valTrans?.name || "";
    });

    optionTranslations[opt.id] = { name: optName, values: valueTranslations };
  }

  for (const mf of item.metafields || []) {
    const mfTrans = translations[mf.id];
    metafieldTranslations[mf.id] = mfTrans?.value || "";
  }

  return { optionTranslations, metafieldTranslations };
}

/**
 * Convert DB pre-loaded subResourceTranslations (array format per resource) into
 * the flat map { resourceId: { key: value } } for the given locale, resolving the
 * market dimension: a market-specific value (marketId === selectedMarketId) wins
 * over the global value (marketId ""); when a market is selected and only a global
 * value exists, that global value is the inherited fallback and its resourceId is
 * added to `fallbackResourceIds` so the UI can grey it out.
 */
export function dbPreloadToMap(
  subResourceTranslations: Record<string, Array<{ key: string; value: string; locale: string; marketId?: string }>> | undefined,
  locale: string,
  selectedMarketId: string,
  /** Resources whose market rows a confirmed purge removed on Shopify (the item
   *  still carries them until it is re-read): their market layer reads as empty. */
  hiddenMarketResourceIds?: { has(resourceId: string): boolean },
): { map: Record<string, Record<string, string>>; fallbackResourceIds: Set<string> } {
  const map: Record<string, Record<string, string>> = {};
  const fallbackResourceIds = new Set<string>();
  if (!subResourceTranslations) return { map, fallbackResourceIds };

  for (const [resourceId, records] of Object.entries(subResourceTranslations)) {
    const globalByKey: Record<string, string> = {};
    const marketByKey: Record<string, string> = {};
    for (const r of records) {
      if (r.locale !== locale) continue;
      const rMarket = r.marketId ?? "";
      if (rMarket === "") globalByKey[r.key] = r.value;
      else if (selectedMarketId && rMarket === selectedMarketId && !hiddenMarketResourceIds?.has(resourceId)) {
        marketByKey[r.key] = r.value;
      }
    }
    const keys = new Set([...Object.keys(globalByKey), ...Object.keys(marketByKey)]);
    for (const key of keys) {
      const hasMarket = marketByKey[key] !== undefined;
      const value = hasMarket ? marketByKey[key] : globalByKey[key];
      if (value === undefined) continue;
      if (!map[resourceId]) map[resourceId] = {};
      map[resourceId][key] = value;
      // Market selected, no market override, showing a non-empty global value → inherited.
      if (selectedMarketId && !hasMarket && (globalByKey[key] ?? "") !== "") {
        fallbackResourceIds.add(resourceId);
      }
    }
  }
  return { map, fallbackResourceIds };
}

export function useProductSubResources({
  selectedItem,
  currentLanguage,
  primaryLocale,
  selectedMarketId = "",
  enabledLanguages = [],
  revalidator,
  onSaveResponse,
  showInfoBox,
  strings = {},
}: UseProductSubResourcesProps): { state: SubResourceState; handlers: SubResourceHandlers } {
  // Translation state (for foreign locales)
  const [optionTranslations, setOptionTranslations] = useState<Record<string, OptionTranslation>>({});
  const [metafieldTranslations, setMetafieldTranslations] = useState<Record<string, string>>({});
  // Resource GIDs currently showing an inherited (global) value in a market context.
  const [fallbackResourceIds, setFallbackResourceIds] = useState<Set<string>>(new Set());
  // Track which resources the user actually modified (to avoid sending unchanged pre-loaded translations)
  const [dirtyOptionIds, setDirtyOptionIds] = useState<Set<string>>(new Set());
  const [dirtyOptionValueIds, setDirtyOptionValueIds] = useState<Set<string>>(new Set());
  const [dirtyMetafieldIds, setDirtyMetafieldIds] = useState<Set<string>>(new Set());

  // Primary locale editing state
  const [primaryOptionEdits, setPrimaryOptionEdits] = useState<Record<string, { name: string; values: string[] }>>({});
  const [primaryMetafieldEdits, setPrimaryMetafieldEdits] = useState<Record<string, string>>({});
  /** True from a landed save of the options until the reload that follows it
   *  has finished — see `optionTranslationBlockedIds`. */
  const [awaitingOptionReload, setAwaitingOptionReload] = useState(false);

  // Shared state
  // translatingFieldIds is now derived from the global AI operations store
  // so spinners persist across item navigation.
  const translatingFieldIds = useTranslatingSubResourceIds(selectedItem?.id || "");
  const [hasChanges, setHasChanges] = useState(false);
  // A translate/copy answer says nothing about the rest of the card: what is
  // still pending stays pending, so the flag is RECOMPUTED, never forced off.
  const syncHasChanges = useCallback(() => {
    const pending = pendingStateRef.current;
    setHasChanges(pending ? hasPendingSubResourceChanges(pending) : false);
  }, []);
  const [isLoading, setIsLoading] = useState(false);

  // Own fetcher for the Shopify load (Phase 2) and the save bar's save -- the
  // two requests of which there is only ever one at a time. Must NOT be shared
  // with the main editor (its safeSubmit queue vs. direct submit here). Every
  // translate and every copy goes through its OWN plain fetch instead (see
  // `postSubResourceRequest`): a second `submit()` on one fetcher aborts the
  // first, and the merchant presses those buttons several at a time.
  const fetcher = useFetcher<any>();

  // Track which item+locale combo we've loaded for
  const loadedForRef = useRef<string>("");
  // Track the last processed fetcher response to avoid re-processing
  const lastProcessedDataRef = useRef<any>(null);
  // Resources a translate answer was staged for, and when. A reload that lands
  // shortly after may have been READ before that write (several translates
  // run at once, and the loader of one can overtake the mirror write of
  // another), so its overlay reset keeps them for a while -- the staged value
  // is a translation Shopify echoed, never a guess.
  const recentlyStagedRef = useRef<Map<string, number>>(new Map());
  // When each overlay entry was staged (per layer key + resource), and when
  // the loaded item last changed. Together they END an entry's life: once it
  // is older than the keep window and the item was loaded after it, the item
  // carries the write and the entry would only shadow newer server values
  // (see `pruneExpiredOverlay`).
  const overlayStampsRef = useRef<OverlayStamps>(new Map());
  const itemLoadedAtRef = useRef(0);
  // The view a Phase-2 load was submitted for (and the ids it asked), so its
  // answer is applied only while that view still shows. `deferredLoadRef`
  // holds a load that could not go out (the shared fetcher was busy with a
  // save, or a save aborted it) until the fetcher is idle again.
  const pendingLoadRef = useRef<(TranslateTarget & { resourceIds: string[] }) | null>(null);
  const deferredLoadRef = useRef<(TranslateTarget & { resourceIds: string[] }) | null>(null);
  // A reload asked for while the revalidator was busy: the run in flight may
  // have read before the write that asked for it, so another one follows.
  const pendingRevalidateRef = useRef(false);
  // The latest pending sets, for response handlers that run from effects.
  const pendingStateRef = useRef<SubResourcePendingState | null>(null);
  const [overlayVersion, setOverlayVersion] = useState(0);
  const touchOverlay = useCallback(() => setOverlayVersion((v) => v + 1), []);
  // Resources whose stale foreign translations a primary save could not remove:
  // they are still live, so the refresh must not wipe their staged values.
  const keepOverlayIdsRef = useRef<Set<string>>(new Set());
  // Sub-resources whose market rows a confirmed primary purge removed; hidden
  // until the re-read item stops carrying them (sub-resource-market-purge.shared).
  const marketPurgedIdsRef = useRef<Map<string, unknown>>(new Map());
  // What a reload's overlay reset must keep: the unconfirmed-purge ids above,
  // plus every resource a translate answer was staged for in the last two
  // minutes (see `recentlyStagedRef`). The merged set is used for the reset
  // ONLY -- the primary-save bookkeeping works on `keepOverlayIdsRef` itself.
  const overlayResetKeepIds = (): Set<string> => {
    const keep = new Set(keepOverlayIdsRef.current);
    const now = Date.now();
    for (const [id, at] of recentlyStagedRef.current) {
      if (now - at <= RECENT_TRANSLATE_KEEP_MS) keep.add(id);
      else recentlyStagedRef.current.delete(id);
    }
    return keep;
  };
  // What the last foreign save / primary save SENT, so the answer can settle
  // the overlay for exactly those resources (the answer does not echo values).
  const pendingForeignSaveRef = useRef<{
    localeKey: string;
    marketLayer?: boolean;
    values: Record<string, Record<string, string>>;
  } | null>(null);
  const pendingPrimarySaveIdsRef = useRef<string[]>([]);
  // What the primary save SENT, so a partial failure can still settle the saved subset.
  const pendingPrimarySaveSentRef = useRef<{ options: Record<string, any>; metafields: Record<string, unknown> } | null>(null);
  // The item/language/market a translate was REQUESTED for; its answer is
  // staged there, never into whatever is showing when it arrives.
  const translateAllTargetRef = useRef<TranslateTarget | null>(null);
  // Per-locale overlay for copy operations — eliminates stale window on locale switch
  // structure: { locale: { resourceId: { fieldKey: value } } }
  const localSubResourceOverlayRef = useRef<Record<string, Record<string, Record<string, string>>>>({});
  // Track item ID to clear overlay when switching items
  const lastOverlayItemIdRef = useRef<string | null>(null);

  const isPrimaryLocale = currentLanguage === primaryLocale;
  const itemId = selectedItem?.id;
  const currentViewRef = useLatestRef({ itemId, locale: currentLanguage, marketId: selectedMarketId });
  const revalidatorRef = useLatestRef(revalidator);

  /** Stamps overlay entries of one layer as staged now (see `overlayStampsRef`). */
  const stampStaged = useCallback((layerKey: string, resourceIds: Iterable<string>) => {
    stampOverlay(overlayStampsRef.current, layerKey, resourceIds, Date.now());
  }, []);

  /** Drops staged entries the loaded item has caught up with. */
  const pruneOverlay = useCallback(() => {
    if (
      pruneExpiredOverlay(localSubResourceOverlayRef.current, overlayStampsRef.current, {
        now: Date.now(),
        itemLoadedAt: itemLoadedAtRef.current,
        maxAgeMs: RECENT_TRANSLATE_KEEP_MS,
        keepIds: keepOverlayIdsRef.current,
      })
    ) {
      touchOverlay();
    }
  }, [touchOverlay]);

  /**
   * Reload the item now, or -- while a reload is already running, which may
   * have read before the write that asks for this one -- right after it.
   * Skipping it then (the old `state === "idle"` guard) left the loaded item
   * carrying a removed market row until something else happened to reload.
   */
  const requestRevalidate = useCallback(() => {
    const r = revalidatorRef.current;
    if (!r) return;
    if (r.state === "idle") r.revalidate();
    else pendingRevalidateRef.current = true;
  }, [revalidatorRef]);

  // Stable sub-resource IDs (only recompute when item changes)
  const subResourceIds = useMemo((): string[] => {
    if (!selectedItem) return [];
    const ids: string[] = [];
    for (const opt of selectedItem.options || []) {
      ids.push(opt.id);
      if (!opt.isLinked) {
        for (const val of opt.values) {
          if (val.id) ids.push(val.id);
        }
      }
    }
    for (const mf of selectedItem.metafields || []) {
      ids.push(mf.id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  /**
   * Phase 1 + Phase 2 of the load, for the current item/locale/market. Shared
   * by the load effect and the background refresh so the two cannot come to
   * resolve a translation differently.
   */
  const readTranslationsFromItem = (fetchMissing = true) => {
    if (!itemId) return;
    // Phase 1: DB pre-load — read from item.subResourceTranslations (instant,
    // synchronous), resolving market → global and flagging inherited resources.
    const { map: dbMap, fallbackResourceIds: dbFallback } =
      dbPreloadToMap(selectedItem?.subResourceTranslations, currentLanguage, selectedMarketId, marketPurgedIdsRef.current);

    // Merge overlay (from copy operations) on top of DB data. Overlay is
    // market-folded so a market override doesn't leak into the global view.
    // Entries the item has caught up with go first: they would only shadow it.
    pruneOverlay();
    const overlayKey = buildLocaleKey(currentLanguage, selectedMarketId);
    const overlayForLocale = localSubResourceOverlayRef.current[overlayKey] || {};
    const mergedMap = { ...dbMap };
    const fallbackIds = new Set(dbFallback);
    for (const [resourceId, fields] of Object.entries(overlayForLocale)) {
      mergedMap[resourceId] = { ...(mergedMap[resourceId] || {}), ...fields };
      // An overlay entry is a market-specific staged value → no longer inherited.
      fallbackIds.delete(resourceId);
    }

    const { optionTranslations: dbOpts, metafieldTranslations: dbMfs } =
      buildFromTranslationsMap(selectedItem, mergedMap);

    setOptionTranslations(dbOpts);
    setMetafieldTranslations(dbMfs);
    setFallbackResourceIds(fallbackIds);

    // Phase 2: Fetch from Shopify for any sub-resources missing from DB.
    // This catches translations made via Translate & Adapt or partial syncs.
    const missingFromDb = subResourceIds.filter(id => !dbMap[id]);

    if (missingFromDb.length > 0 && fetchMissing) {
      submitPhase2Load({ itemId, locale: currentLanguage, marketId: selectedMarketId, resourceIds: missingFromDb });
    } else {
      setIsLoading(false);
    }
  };

  /**
   * Phase 2 on the shared fetcher, TAGGED with the view it was asked for. Never
   * submitted while a save bar's save is in flight (a second `submit()` would
   * abort it): it is deferred until the fetcher is idle again.
   */
  const submitPhase2Load = (load: TranslateTarget & { resourceIds: string[] }) => {
    if (fetcher.state !== "idle") {
      deferredLoadRef.current = load;
      setIsLoading(true);
      return;
    }
    deferredLoadRef.current = null;
    pendingLoadRef.current = load;
    setIsLoading(true);
    fetcher.submit(
      {
        action: "loadSubResourceTranslations",
        locale: load.locale,
        resourceIds: JSON.stringify(load.resourceIds),
        itemId: load.itemId,
      },
      { method: "POST", action: "/app/products" }
    );
  };

  // When the loaded item last changed (a reload delivers a new object). Runs
  // before the load effect below, so a re-read sees the new stamp.
  useEffect(() => {
    itemLoadedAtRef.current = Date.now();
    retirePurgedMarketResources(marketPurgedIdsRef.current, selectedItem);
  }, [selectedItem]);

  // ============================================================================
  // LOAD — Two-phase: DB pre-load (instant) + Shopify fetch (supplement)
  // ============================================================================
  useEffect(() => {
    // Market is part of the load key: switching market re-resolves values.
    const loadKey = `${itemId}::${currentLanguage}::${selectedMarketId}`;
    if (loadedForRef.current === loadKey) return;

    // Reset state — unsaved edits belong to the previous item/locale/market.
    setHasChanges(false);
    setDirtyOptionIds(new Set());
    setDirtyOptionValueIds(new Set());
    setDirtyMetafieldIds(new Set());
    // The structural lists too, and this half is not cosmetic: the save skips
    // an option id it cannot find on the current item, but `optionsToCreate`
    // carries NO id at all -- so a pending "add Material" left over from
    // product A would be created on product B, multiplying B's variant matrix
    // with `variantStrategy: CREATE`.
    setOptionValuesToAdd({});
    setOptionLinkedValuesToAdd({});
    setOptionValuesToDelete({});
    setOptionsToCreate([]);
    setOptionsToDelete([]);
    setOptionOrder(null);
    setOptionValueOrder({});
    // And the primary text edits: `hasChanges` goes above, so an edit left
    // here had no save bar any more, yet came back on returning to the same
    // product -- shown in the card and locking its translate button behind a
    // "save first" nothing could satisfy.
    setPrimaryOptionEdits({});
    // Note: translatingFieldIds is now in the global AI operations store
    // and should NOT be cleared on item change — it's resource-specific.

    loadedForRef.current = loadKey;

    // Clear overlay when switching to a different item (data is item-specific)
    if (lastOverlayItemIdRef.current !== itemId) {
      lastOverlayItemIdRef.current = itemId || null;
      localSubResourceOverlayRef.current = {};
      marketPurgedIdsRef.current = new Map();
      // The kept ids belong to the previous item's live translations.
      keepOverlayIdsRef.current = new Set();
      recentlyStagedRef.current = new Map();
      overlayStampsRef.current = new Map();
      pendingForeignSaveRef.current = null;
      pendingPrimarySaveIdsRef.current = [];
      pendingPrimarySaveSentRef.current = null;
    }

    if (!itemId || isPrimaryLocale || subResourceIds.length === 0) {
      setOptionTranslations({});
      setMetafieldTranslations({});
      setFallbackResourceIds(new Set());
      setIsLoading(false);
      return;
    }

    readTranslationsFromItem();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetcher is hook-internal and stable
  }, [itemId, currentLanguage, selectedMarketId, isPrimaryLocale, subResourceIds, selectedItem]);

  const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    if (refreshVersion === 0) return;
    // Unsaved input wins, always. The page does not start a background refresh
    // while this card is dirty, but an edit can land between that decision and
    // this pass.
    if (hasChanges) return;
    // A different item/locale/market is the load effect's job, with its full
    // reset; this pass only re-reads what is already on screen.
    if (loadedForRef.current !== `${itemId}::${currentLanguage}::${selectedMarketId}`) return;
    if (!itemId || isPrimaryLocale || subResourceIds.length === 0) return;
    // The server has just rewritten these languages; a staged copy would
    // otherwise keep winning over the fresh loader value. The overlay only ever
    // holds values that were already saved, which the fresh item carries too --
    // except a translate answer from the last moments, which the loader may
    // have read before its write (see `overlayResetKeepIds`).
    localSubResourceOverlayRef.current = overlayKeepingOnly(
      localSubResourceOverlayRef.current,
      overlayResetKeepIds(),
    );
    pruneOverlayStamps(overlayStampsRef.current, localSubResourceOverlayRef.current);
    touchOverlay();
    // Phase 2 goes through the SAME fetcher as a save; while it is busy the
    // Shopify supplement is deferred until it is idle (`submitPhase2Load`).
    readTranslationsFromItem();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the bump alone; reads the render it runs in
  }, [refreshVersion]);

  const refreshTranslations = useCallback(() => {
    setRefreshVersion((v) => v + 1);
  }, []);

  // A request that failed as a whole, from either fetcher. The plan refusal
  // arrives as the code "gated" and goes through the editor's one translator so
  // it reads as the upgrade message; a managed-AI refusal already carries a
  // localised sentence. A save that failed still hands its task ids (a repair
  // some other resource of the same save may have started) to the watcher.
  const reportFailedRequest = (data: SubResourceFetcherData) => {
    const raw = typeof data.error === "string" ? data.error : "";
    const translated = raw
      ? translateErrorMessage(raw, {
          content: { upgradeRequired: strings.upgradeRequired },
          errors: {},
        } as unknown as TranslationStrings)
      : "";
    const isSave = data.actionType === "savePrimarySubResources" || data.actionType === "saveSubResourceTranslations";
    const fallback = isSave
      ? strings.subResourcesRequestFailed || "Saving failed. Your edits are kept - please try again."
      : strings.translateFailed || strings.subResourcesRequestFailed || "Translation failed";
    showInfoBox?.(translated || fallback, "critical");
    if (Array.isArray(data.retranslationTaskIds) && data.retranslationTaskIds.length > 0) {
      onSaveResponse?.(data);
    }
  };

  // Stage a translate answer in the overlay: the server saved it, but the
  // loaded item does not carry it until a reload, and a locale switch (or the
  // "missing translation" marker on the primary tab) would read the old item.
  // Global layer only: the translate writes no market override.
  // The answer goes under the language it was REQUESTED for (`target`, captured
  // at submit), and is applied to the visible state only while that is still
  // what shows. Returns the plan so the caller can skip its own state update.
  const stageTranslations = (
    translations: Record<string, Record<string, string>> | undefined | null,
    target: TranslateTarget | null,
  ): "apply" | "stage" | "skip" => {
    const plan = translateAnswerPlan(target, currentViewRef.current);
    // A translate writes the global layer, so it is staged under the global key
    // for a market target too (the plan never applies it visibly there).
    if (plan === "skip" || !target || !translations) return plan;
    const layerKey = buildLocaleKey(target.locale, "");
    if (stageTranslateAnswer(localSubResourceOverlayRef.current, layerKey, translations)) {
      const now = Date.now();
      for (const resourceId of Object.keys(translations)) recentlyStagedRef.current.set(resourceId, now);
      stampStaged(layerKey, Object.keys(translations));
      touchOverlay();
    }
    return plan;
  };

  // Takes back what a single-option Copy wrote up front (its save failed).
  // The record travels with ITS request: several copies can be out at once.
  const rollbackCopy = (c: CopyRecord) => {
    const overlay = localSubResourceOverlayRef.current;
    rollbackSubResourceCopy(overlay, [c.overlayKey], [{ resourceId: c.resourceId, value: c.value }]);
    if (c.previous !== undefined) {
      ((overlay[c.overlayKey] ??= {})[c.resourceId] ??= {})["name"] = c.previous;
    }
    pruneOverlayStamps(overlayStampsRef.current, localSubResourceOverlayRef.current);
    touchOverlay();
  };

  // Puts the STORED value back for resources whose foreign save failed, in the
  // view that is showing (empty where no translation existed).
  const restoreFailedResources = (failedResources: readonly string[]) => {
    if (!selectedItem || failedResources.length === 0) return;
    const { map: dbMap } = dbPreloadToMap(selectedItem.subResourceTranslations, currentLanguage, selectedMarketId, marketPurgedIdsRef.current);
    setOptionTranslations(prev => {
      const restored = { ...prev };
      for (const resourceId of failedResources) {
        const option = selectedItem.options?.find(o => o.id === resourceId);
        if (option) {
          const originalName = dbMap[resourceId]?.name || "";
          restored[resourceId] = restored[resourceId]
            ? { ...restored[resourceId], name: originalName }
            : { name: originalName, values: [] };
        }
        for (const opt of selectedItem.options || []) {
          const valueIndex = opt.values.findIndex(v => v.id === resourceId);
          if (valueIndex !== -1 && restored[opt.id]) {
            const newValues = [...restored[opt.id].values];
            newValues[valueIndex] = dbMap[resourceId]?.name || "";
            restored[opt.id] = { ...restored[opt.id], values: newValues };
          }
        }
      }
      return restored;
    });
    setMetafieldTranslations(prev => {
      const restored = { ...prev };
      for (const resourceId of failedResources) {
        if (selectedItem.metafields?.some(m => m.id === resourceId)) {
          restored[resourceId] = dbMap[resourceId]?.value || "";
        }
      }
      return restored;
    });
  };

  // The copy's resource is settled (saved, or reverted): only IT leaves the
  // dirty sets, and the save bar stays for whatever else is still pending.
  const settleCopiedResource = (resourceId: string) => {
    const pending = pendingStateRef.current;
    const next = {
      dirtyOptionIds: withoutIds(pending?.dirtyOptionIds ?? new Set<string>(), [resourceId]),
      dirtyOptionValueIds: withoutIds(pending?.dirtyOptionValueIds ?? new Set<string>(), [resourceId]),
      dirtyMetafieldIds: withoutIds(pending?.dirtyMetafieldIds ?? new Set<string>(), [resourceId]),
    };
    setDirtyOptionIds(next.dirtyOptionIds);
    setDirtyOptionValueIds(next.dirtyOptionValueIds);
    setDirtyMetafieldIds(next.dirtyMetafieldIds);
    setHasChanges(pending ? hasPendingSubResourceChanges({ ...pending, ...next }) : false);
  };

  // ============================================================================
  // Handle fetcher responses (load + translate + save)
  // ============================================================================
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    const data = fetcher.data as SubResourceFetcherData;

    // Skip if we've already processed this exact response
    if (data === lastProcessedDataRef.current) return;
    lastProcessedDataRef.current = data;

    if (!data.success) {
      // The fetcher serves one request at a time, so ANY failed answer ends a
      // load that may have been in flight - including one with no `actionType`
      // (a plan refusal, a proxy error), which used to leave `isLoading` stuck.
      setIsLoading(false);
      if (data.actionType === "loadSubResourceTranslations") {
        pendingLoadRef.current = null;
        return;
      }
      // A request that failed as a whole (server error, plan refusal, managed
      // AI refusal). It used to return silently: the spinner of a copy or a
      // translate hung until the store's ten-minute timeout and the merchant
      // heard nothing. Edits stay PENDING (nothing here touches the dirty sets
      // or `hasChanges`) so the save can simply be pressed again.
      reportFailedRequest(data);
      pendingForeignSaveRef.current = null;
      pendingPrimarySaveIdsRef.current = [];
      pendingPrimarySaveSentRef.current = null;
      // No translate or copy spinner is touched here: none of them rides on
      // this fetcher any more, and a failed SAVE used to take down the
      // spinners of translates that were still running beside it.
      return;
    }

    // Phase 2 complete: merge Shopify data into state
    if (data.actionType === "loadSubResourceTranslations") {
      // Applied ONLY to the view it was asked for: a load answer that lands
      // after a language/market/item switch carries another layer's values
      // (Phase 2 reads per locale), and merging it here showed them as this
      // view's translations -- and a save would then have written them.
      const load = pendingLoadRef.current;
      pendingLoadRef.current = null;
      if (!deferredLoadRef.current) setIsLoading(false);
      const viewMatches =
        !!load &&
        load.itemId === itemId &&
        load.locale === currentLanguage &&
        load.marketId === selectedMarketId;
      if (!viewMatches) return;
      const translations = (data.translations || {}) as Record<string, Record<string, string>>;
      // Entries the item has caught up with must not be merged back on top.
      pruneOverlay();
      if (selectedItem) {
        // Merge FIELD BY FIELD: Shopify data overrides DB data (Shopify is
        // fresher) where it carries a value, and the overlay goes back on top
        // -- it holds translate answers that may have landed while this load
        // was in flight, which a read taken before their write cannot know
        // about. Replacing an option's whole entry here (the old merge) blanked
        // those answers' values on screen although Shopify had stored them.
        const overlayForView =
          localSubResourceOverlayRef.current[buildLocaleKey(currentLanguage, selectedMarketId)] || {};
        setOptionTranslations(prev =>
          // A staged EMPTY value (a confirmed or in-flight "clear all") is
          // applied last: the merges skip empties, so a read taken before the
          // removal would otherwise put the cleared value back.
          applyStagedOptionClears(
            mergeOptionTranslations(mergeOptionTranslations(prev, selectedItem, translations || {}), selectedItem, overlayForView),
            selectedItem,
            overlayForView,
          ),
        );
        setMetafieldTranslations(prev =>
          applyStagedMetafieldClears(
            mergeMetafieldTranslations(mergeMetafieldTranslations(prev, selectedItem, translations || {}), selectedItem, overlayForView),
            overlayForView,
          ),
        );

        // Phase-2 returns GLOBAL values (server reads marketId ""). In a market
        // context these are inherited fallbacks, not market overrides — flag the
        // resources so they render greyed, matching Phase-1's dbPreloadToMap.
        if (selectedMarketId) {
          setFallbackResourceIds(prev => {
            const next = new Set(prev);
            for (const [resourceId, kv] of Object.entries(translations)) {
              const val = kv.name ?? kv.value;
              if (val && val !== "") next.add(resourceId);
            }
            return next;
          });
        }
      }
      // Unsaved edits made while this load was in flight are still unsaved.
      syncHasChanges();
    }

    if (data.actionType === "saveSubResourceTranslations") {
      // Only the save bar's foreign save arrives here: a single-option Copy
      // has its own request (see `copyOptionField`).
      const failedResources = data.failedResources || [];

      // What the merchant just saved is the truth for those resources: write the
      // confirmed values into the overlay (failed and untranslatable ones
      // excluded), or an earlier staged translate keeps shadowing them.
      const sentSave = pendingForeignSaveRef.current;
      pendingForeignSaveRef.current = null;
      if (sentSave) {
        if (
          recordConfirmedForeignSave(
            localSubResourceOverlayRef.current,
            sentSave.localeKey,
            sentSave.values,
            failedResources,
            data.notTranslatable || [],
            { marketLayer: !!sentSave.marketLayer, savedIds: Array.isArray(data.savedResources) ? data.savedResources : null },
          )
        ) {
          stampStaged(sentSave.localeKey, Object.keys(sentSave.values));
          touchOverlay();
        }
        // A confirmed removal of a MARKET override leaves the market inheriting
        // the global value, but the loaded item still carries the removed market
        // row and would resurface it on the next locale/market switch: re-read.
        const removedMarketOverride =
          !!sentSave.marketLayer &&
          Object.entries(sentSave.values).some(
            ([resourceId, fields]) =>
              !failedResources.includes(resourceId) &&
              Object.values(fields || {}).some((value) => value === ""),
          );
        if (removedMarketOverride) requestRevalidate();
      }

      if (failedResources.length > 0) {
        // Some resources failed - show error and restore original values for failed resources
        if (showInfoBox) {
          showInfoBox(
            (strings.saveFailedOptions || "Failed to save {count} option(s). Changes have been reverted to original values.").replace("{count}", String(failedResources.length)),
            "critical"
          );
        }
        restoreFailedResources(failedResources);
        setHasChanges(false);
      } else if ((data.notTranslatable || []).length > 0) {
        // Not a refused write: Shopify exposes no digest for the field, so it
        // cannot be translated there. Nothing is reverted (the typed value is
        // the merchant's) and nothing is claimed as saved.
        const outcome = subResourceOutcome(data, strings);
        if (outcome) showInfoBox?.(outcome.text, outcome.tone);
        setHasChanges(false);
        // The rest of the save landed; leaving the dirty sets armed re-sent the
        // untranslatable field on every later save and repeated the warning.
        setDirtyOptionIds(new Set());
        setDirtyOptionValueIds(new Set());
        setDirtyMetafieldIds(new Set());
      } else {
        // All saved successfully
        if (showInfoBox) {
          showInfoBox(strings.optionsSavedSuccess || "Options and metafields saved successfully", "success");
        }
        setHasChanges(false);
        setDirtyOptionIds(new Set());
        setDirtyOptionValueIds(new Set());
        setDirtyMetafieldIds(new Set());
      }
    }

    if (data.actionType === "savePrimarySubResources") {
      // Offered whatever the outcome: a save can fail for one option and still
      // have started the repair for the others.
      onSaveResponse?.(data);
      // The save's purge removed these resources' MARKET overrides on Shopify;
      // the loaded item carries the old rows until it is re-read.
      if (Array.isArray(data.marketPurgedResourceIds)) {
        for (const id of data.marketPurgedResourceIds) marketPurgedIdsRef.current.set(String(id), selectedItem);
      }
      const failedOptions = data.failedOptions || [];
      const failedMetafields = data.failedMetafields || [];
      // Create, delete and reorder failures have no id to report under, so
      // counting only the two id-lists made every one of them read as a
      // success -- green toast, pending lists cleared, merchant's edit gone.
      const structuralFailures = data.structuralFailures || 0;
      const totalFailed = failedOptions.length + failedMetafields.length + structuralFailures;

      if (totalFailed > 0) {
        // The part that WAS saved still moved its source text: settle the
        // overlay for it exactly like a full success.
        const sentPrimary = pendingPrimarySaveSentRef.current;
        pendingPrimarySaveSentRef.current = null;
        const partialPurge = unconfirmedPurgeOf(data as { warnings?: unknown; unconfirmedPurge?: unknown });
        const partialSavedIds = sentPrimary
          ? savedIdsAfterPartialSave(sentPrimary.options, sentPrimary.metafields, failedOptions, failedMetafields)
          : [];
        updateKeepIds(keepOverlayIdsRef.current, partialSavedIds, partialPurge.resourceIds);
        if (dropOverlayForPrimaryChange(localSubResourceOverlayRef.current, partialSavedIds, keepOverlayIdsRef.current)) {
          touchOverlay();
        }
        pruneOverlayStamps(overlayStampsRef.current, localSubResourceOverlayRef.current);
        // The part that WAS saved moved its text and purged its overrides too:
        // re-read, so the item stops carrying them.
        if (partialSavedIds.length > 0 || (data.marketPurgedResourceIds ?? []).length > 0) requestRevalidate();
        // Some resources failed - show error and restore original values
        if (showInfoBox) {
          // The warning codes carry the only specific reason there is (the
          // last option cannot go, an empty name, an unconfirmed write), and
          // the generic count alone leaves the merchant guessing.
          const reasons = [...new Set(data.optionWarnings || [])]
            .map((code) => strings[`optionWarning_${code}`] || "")
            .filter(Boolean)
            .join(" ");
          showInfoBox(
            [
              (strings.saveFailedItems || "Failed to save {count} item(s). Changes have been reverted to original values.").replace("{count}", String(totalFailed)),
              reasons,
              partialPurge.unconfirmed
                ? strings.translationPurgeUnconfirmed ||
                  "The text was saved, but some translations of it could not be removed on Shopify and were kept. Please check them."
                : "",
            ].filter(Boolean).join(" "),
            "critical"
          );
        }

        // Restore original values for failed resources from selectedItem
        if (selectedItem) {
          setPrimaryOptionEdits(prev => {
            const restored = { ...prev };

            for (const optionId of failedOptions) {
              // Remove the failed edit to restore original value
              delete restored[optionId];
            }

            return restored;
          });

          setPrimaryMetafieldEdits(prev => {
            const restored = { ...prev };

            for (const metafieldId of failedMetafields) {
              // Remove the failed edit to restore original value
              delete restored[metafieldId];
            }

            return restored;
          });
        }

        // The structural lists go too. Left armed while `hasChanges` is
        // cleared, the card would keep showing a deletion as applied with no
        // save bar to undo it -- and the next unrelated edit would re-fire the
        // whole queue. Reverting is what the message already promises.
        setOptionValuesToAdd({});
        setOptionLinkedValuesToAdd({});
        setOptionValuesToDelete({});
        setOptionsToCreate([]);
        setOptionsToDelete([]);
        setOptionOrder(null);
        setOptionValueOrder({});
        setSavedNonce((n) => n + 1);
        pendingPrimarySaveIdsRef.current = [];
        pendingPrimarySaveSentRef.current = null;

        setHasChanges(false);
      } else {
        // Saved -- but removing the now-stale foreign translations may not have
        // been confirmed on Shopify. Those are still LIVE: say so, and keep what
        // the card holds for them instead of treating them as gone.
        const purge = unconfirmedPurgeOf(data as { warnings?: unknown; unconfirmedPurge?: unknown });
        // The source text of these resources moved: every language's staged
        // value for them is stale, except where the removal was not confirmed.
        const savedIds = pendingPrimarySaveIdsRef.current;
        pendingPrimarySaveIdsRef.current = [];
        pendingPrimarySaveSentRef.current = null;
        updateKeepIds(keepOverlayIdsRef.current, savedIds, purge.resourceIds);
        if (dropOverlayForPrimaryChange(localSubResourceOverlayRef.current, savedIds, keepOverlayIdsRef.current)) {
          touchOverlay();
        }
        pruneOverlayStamps(overlayStampsRef.current, localSubResourceOverlayRef.current);
        if (showInfoBox) {
          if (purge.unconfirmed) {
            showInfoBox(
              strings.translationPurgeUnconfirmed ||
                "The text was saved, but some translations of it could not be removed on Shopify and were kept. Please check them.",
              "warning",
            );
          } else {
            showInfoBox(strings.optionsSavedSuccess || "Options and metafields saved successfully", "success");
          }
        }
        setHasChanges(false);
        // Clear primary edits after successful save
        setPrimaryOptionEdits({});
        // The matrix-changing lists too: a discarded delete that survives the
        // save would fire again on the next one.
        setOptionValuesToAdd({});
        setOptionLinkedValuesToAdd({});
        setOptionValuesToDelete({});
        setOptionsToCreate([]);
        setOptionsToDelete([]);
        setOptionOrder(null);
        setOptionValueOrder({});
        setSavedNonce((n) => n + 1);

        setPrimaryMetafieldEdits({});

        // Trigger revalidation to reload fresh data from DB/Shopify
        // This ensures new option value GIDs and updated values are loaded
        if (revalidator) {
          // Until it lands, the item still carries the text from BEFORE the
          // save, and that is what a translate would send as its source. Only
          // a PRIMARY save moves that text; a foreign one changes nothing a
          // translate reads.
          if (isPrimaryLocale) setAwaitingOptionReload(true);
          // Queued behind a running reload (which may have read before this
          // write) instead of skipped.
          requestRevalidate();
        }
      }
    }
  }, [fetcher.state, fetcher.data, selectedItem, selectedMarketId, currentLanguage]);

  // A Phase-2 load that waited for the save bar's save (or was aborted by it)
  // goes out once the fetcher is idle -- for the view it was asked for only.
  // Declared AFTER the answer effect: both read the same render, so the save's
  // answer is processed before this submit replaces `fetcher.data`.
  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const load = deferredLoadRef.current;
    if (!load) return;
    deferredLoadRef.current = null;
    const view = currentViewRef.current;
    if (view.itemId !== load.itemId || view.locale !== load.locale || view.marketId !== load.marketId) {
      setIsLoading(false);
      return;
    }
    submitPhase2Load(load);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- submitPhase2Load reads the render it runs in
  }, [fetcher.state]);

  // ============================================================================
  // Handlers
  // ============================================================================

  // Editing a field makes it a real market override → no longer inherited.
  const clearFallback = useCallback((resourceId: string) => {
    setFallbackResourceIds(prev => {
      if (!prev.has(resourceId)) return prev;
      const next = new Set(prev);
      next.delete(resourceId);
      return next;
    });
  }, []);

  const handleOptionNameChange = useCallback((optionId: string, value: string) => {
    setOptionTranslations(prev => ({
      ...prev,
      [optionId]: { ...prev[optionId], name: value, values: prev[optionId]?.values || [] },
    }));
    setDirtyOptionIds(prev => new Set(prev).add(optionId));
    clearFallback(optionId);
    setHasChanges(true);
  }, [clearFallback]);

  const handleOptionValueChange = useCallback((optionId: string, valueIndex: number, value: string) => {
    setOptionTranslations(prev => {
      const existing = prev[optionId] || { name: "", values: [] };
      const newValues = [...existing.values];
      newValues[valueIndex] = value;
      return { ...prev, [optionId]: { ...existing, values: newValues } };
    });
    setDirtyOptionValueIds(prev => {
      const opt = selectedItem?.options?.find(o => o.id === optionId);
      if (opt?.values[valueIndex]?.id) {
        const next = new Set(prev);
        next.add(opt.values[valueIndex].id);
        return next;
      }
      return prev;
    });
    const valId = selectedItem?.options?.find(o => o.id === optionId)?.values[valueIndex]?.id;
    if (valId) clearFallback(valId);
    setHasChanges(true);
  }, [selectedItem, clearFallback]);

  const handleMetafieldChange = useCallback((metafieldId: string, value: string) => {
    setMetafieldTranslations(prev => ({ ...prev, [metafieldId]: value }));
    setDirtyMetafieldIds(prev => new Set(prev).add(metafieldId));
    clearFallback(metafieldId);
    setHasChanges(true);
  }, [clearFallback]);

  // ============================================================================
  // Primary Locale Handlers
  // ============================================================================

  /**
   * Option values the merchant ADDED, per option id. Names only: Shopify
   * assigns the GID, and the echo is what tells us which one.
   */
  const [optionValuesToAdd, setOptionValuesToAdd] = useState<Record<string, string[]>>({});
  /** Metaobject entries queued on a LINKED option, by option id. The name is
   *  carried alongside the GID only so the card can render the pending add;
   *  the SAVE sends the GID, and Shopify takes the name from the entry. */
  const [optionLinkedValuesToAdd, setOptionLinkedValuesToAdd] = useState<
    Record<string, Array<{ id: string; name: string }>>
  >({});
  /** Value GIDs the merchant removed — and with them, their variants. */
  const [optionValuesToDelete, setOptionValuesToDelete] = useState<Record<string, string[]>>({});
  /** Whole options to create, in the order the merchant added them. */
  const [optionsToCreate, setOptionsToCreate] = useState<Array<{ name: string; values: string[] }>>([]);
  /** Whole options to remove. */
  const [optionsToDelete, setOptionsToDelete] = useState<string[]>([]);
  /** The option ids in the order the merchant dragged them into, or null while
   *  nothing has been dragged — an unchanged order must not be written. */
  const [optionOrder, setOptionOrder] = useState<string[] | null>(null);
  /** Value GIDs in their new order, per option id. Empty while nothing has
   *  been dragged — an unchanged order must not be written. */
  const [optionValueOrder, setOptionValueOrder] = useState<Record<string, string[]>>({});
  /** Bumped on every landed save — see `SubResourceState.savedNonce`. */
  const [savedNonce, setSavedNonce] = useState(0);
  pendingStateRef.current = {
    dirtyOptionIds,
    dirtyOptionValueIds,
    dirtyMetafieldIds,
    primaryOptionEdits,
    primaryMetafieldEdits,
    optionValuesToAdd,
    optionLinkedValuesToAdd,
    optionValuesToDelete,
    optionsToCreate,
    optionsToDelete,
    optionOrder,
    optionValueOrder,
  };

  const handleAddLinkedOptionValue = useCallback(
    (optionId: string, entry: { id: string; name: string }) => {
      setOptionLinkedValuesToAdd((prev) => {
        const list = prev[optionId] ?? [];
        // Adding the same entry twice would ask Shopify for a duplicate value,
        // which it refuses — and the refusal would take the merchant's other
        // edits on that option with it.
        if (list.some((e) => e.id === entry.id)) return prev;
        return { ...prev, [optionId]: [...list, entry] };
      });
      setHasChanges(true);
    },
    [],
  );

  const handleRemoveLinkedOptionValue = useCallback((optionId: string, entryId: string) => {
    setOptionLinkedValuesToAdd((prev) => ({
      ...prev,
      [optionId]: (prev[optionId] ?? []).filter((e) => e.id !== entryId),
    }));
    setHasChanges(true);
  }, []);

  const handleAddOptionValue = useCallback((optionId: string, name: string) => {
    const clean = name.trim();
    if (!clean) return;
    setOptionValuesToAdd((prev) => ({ ...prev, [optionId]: [...(prev[optionId] ?? []), clean] }));
    setHasChanges(true);
  }, []);

  /** `valueId` empty ⇒ an entry that was only added locally, so it just goes
   *  off the pending list rather than being queued for deletion. */
  const handleRemoveOptionValue = useCallback((optionId: string, valueId: string, addedIndex?: number) => {
    if (!valueId) {
      setOptionValuesToAdd((prev) => ({
        ...prev,
        [optionId]: (prev[optionId] ?? []).filter((_, i) => i !== addedIndex),
      }));
      setHasChanges(true);
      return;
    }
    setOptionValuesToDelete((prev) => ({ ...prev, [optionId]: [...(prev[optionId] ?? []), valueId] }));
    setHasChanges(true);
  }, []);

  /** Rename a value that only exists locally. Its own handler because
   *  remove-then-add would move it to the end of the list, and the input the
   *  merchant is typing into would jump out from under the cursor. */
  const handleEditPendingValue = useCallback((optionId: string, index: number, name: string) => {
    setOptionValuesToAdd((prev) => {
      const list = [...(prev[optionId] ?? [])];
      if (index < 0 || index >= list.length) return prev;
      list[index] = name;
      return { ...prev, [optionId]: list };
    });
    setHasChanges(true);
  }, []);

  const handleCreateOption = useCallback((name: string, values: string[]) => {
    setOptionsToCreate((prev) => [...prev, { name, values }]);
    setHasChanges(true);
  }, []);

  const handleCancelCreateOption = useCallback((index: number) => {
    setOptionsToCreate((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleDeleteOption = useCallback((optionId: string) => {
    setOptionsToDelete((prev) => (prev.includes(optionId) ? prev : [...prev, optionId]));
    setHasChanges(true);
  }, []);

  const handleReorderOptions = useCallback((orderedIds: string[]) => {
    setOptionOrder(orderedIds);
    setHasChanges(true);
  }, []);

  const handleReorderOptionValues = useCallback((optionId: string, orderedValueIds: string[]) => {
    setOptionValueOrder((prev) => ({ ...prev, [optionId]: orderedValueIds }));
    setHasChanges(true);
  }, []);

  const handlePrimaryOptionNameChange = useCallback((optionId: string, value: string) => {
    setPrimaryOptionEdits(prev => {
      // If this option hasn't been edited yet, get the original values from selectedItem
      const originalOption = selectedItem?.options?.find(o => o.id === optionId);
      const originalValues = originalOption?.values.map(v => v.name) || [];

      return {
        ...prev,
        [optionId]: {
          name: value,
          values: prev[optionId]?.values || originalValues,
        },
      };
    });
    setHasChanges(true);
  }, [selectedItem]);

  const handlePrimaryOptionValuesChange = useCallback((optionId: string, values: string[]) => {
    setPrimaryOptionEdits(prev => {
      // If this option hasn't been edited yet, get the original name from selectedItem
      const originalOption = selectedItem?.options?.find(o => o.id === optionId);
      const originalName = originalOption?.name || "";

      return {
        ...prev,
        [optionId]: {
          name: prev[optionId]?.name || originalName,
          values,
        },
      };
    });
    setHasChanges(true);
  }, [selectedItem]);

  const handlePrimaryMetafieldChange = useCallback((metafieldId: string, value: string) => {
    setPrimaryMetafieldEdits(prev => ({ ...prev, [metafieldId]: value }));
    setHasChanges(true);
  }, []);

  // The reload a landed save started has finished: whatever it brought back is
  // the text Shopify holds now, so the options may be translated again. Keyed
  // on the TRANSITION, because the save sets the flag while the revalidator is
  // still idle.
  const revalidatorState = revalidator?.state ?? "idle";
  const previousRevalidatorStateRef = useRef(revalidatorState);
  useEffect(() => {
    const previous = previousRevalidatorStateRef.current;
    previousRevalidatorStateRef.current = revalidatorState;
    if (previous !== "idle" && revalidatorState === "idle") {
      setAwaitingOptionReload(false);
    }
    // A reload asked for while one was running (`requestRevalidate`).
    if (revalidatorState === "idle" && pendingRevalidateRef.current) {
      pendingRevalidateRef.current = false;
      revalidatorRef.current?.revalidate();
    }
  }, [revalidatorState, revalidatorRef]);

  // Two more ways out, because a lock nothing releases is worse than the bug
  // it prevents: the item the reload brings back is a NEW object (if React
  // batched "loading" and "idle" into one commit, the transition above is
  // never seen), and a bound on how long the reload may take at all.
  const itemWhenAwaitingRef = useRef<typeof selectedItem>(null);
  useEffect(() => {
    if (!awaitingOptionReload) {
      itemWhenAwaitingRef.current = null;
      return;
    }
    if (itemWhenAwaitingRef.current === null) {
      itemWhenAwaitingRef.current = selectedItem;
    } else if (itemWhenAwaitingRef.current !== selectedItem) {
      setAwaitingOptionReload(false);
    }
  }, [awaitingOptionReload, selectedItem]);
  useEffect(() => {
    if (!awaitingOptionReload) return;
    const timer = setTimeout(() => setAwaitingOptionReload(false), 20_000);
    return () => clearTimeout(timer);
  }, [awaitingOptionReload]);

  /**
   * See `SubResourceState.optionTranslationBlockedIds`. Every translate entry
   * point builds its source from `selectedItem` — the text as it was LOADED —
   * and the server translates exactly what it is sent, so an option that does
   * not read the same on screen as in the cache must not be translated. Any
   * pending change counts, structural ones included: a value added but not
   * saved has no id and would be left out, one removed would be translated.
   */
  const optionTranslationBlockedIds = useMemo((): Set<string> => {
    const blocked = new Set<string>();
    for (const opt of selectedItem?.options || []) {
      if (awaitingOptionReload) {
        blocked.add(opt.id);
        continue;
      }
      const edit = primaryOptionEdits[opt.id];
      const textChanged = !!edit && (
        edit.name !== opt.name ||
        opt.values.some((v, i) => (edit.values[i] ?? v.name) !== v.name)
      );
      if (
        textChanged ||
        (optionValuesToAdd[opt.id]?.length ?? 0) > 0 ||
        (optionLinkedValuesToAdd[opt.id]?.length ?? 0) > 0 ||
        (optionValuesToDelete[opt.id]?.length ?? 0) > 0
      ) {
        blocked.add(opt.id);
      }
    }
    return blocked;
  }, [selectedItem, awaitingOptionReload, primaryOptionEdits, optionValuesToAdd, optionLinkedValuesToAdd, optionValuesToDelete]);

  const buildSourceData = useCallback((filterOptionId?: string, filterMetafieldId?: string) => {
    if (!selectedItem) return [];

    const sourceData: Array<{ resourceId: string; resourceType: string; key: string; value: string; label: string }> = [];

    for (const opt of selectedItem.options || []) {
      if (filterOptionId && opt.id !== filterOptionId) continue;
      // Its cached text is not the text on screen — see the set above. A
      // translate-all leaves it out rather than translating the old wording.
      if (optionTranslationBlockedIds.has(opt.id)) continue;
      sourceData.push({
        resourceId: opt.id,
        resourceType: "ProductOption",
        key: "name",
        value: opt.name,
        label: `Option: ${opt.name}`,
      });
      if (!opt.isLinked) {
        for (const val of opt.values) {
          if (!val.id) continue;
          sourceData.push({
            resourceId: val.id,
            resourceType: "ProductOptionValue",
            key: "name",
            value: val.name,
            label: `Value: ${val.name}`,
          });
        }
      }
    }

    if (!filterOptionId) {
      for (const mf of selectedItem.metafields || []) {
        if (filterMetafieldId && mf.id !== filterMetafieldId) continue;
        sourceData.push({
          resourceId: mf.id,
          resourceType: "Metafield",
          key: "value",
          value: mf.value,
          label: `${mf.namespace}.${mf.key}`,
        });
      }
    }

    return sourceData;
  }, [selectedItem, optionTranslationBlockedIds]);

  // Merge a translations map ({ resourceId: { key: value } }) into option/metafield
  // state, field by field (see `mergeOptionTranslations`).
  const applyTranslationsToState = useCallback((
    item: TranslatableContentItem,
    translations: Record<string, Record<string, string>>,
  ) => {
    setOptionTranslations(prev => mergeOptionTranslations(prev, item, translations));
    setMetafieldTranslations(prev => mergeMetafieldTranslations(prev, item, translations));
  }, []);

  // Drops the staged GLOBAL entries of these resources, with their stamps and
  // keep marks: a primary translate-to-all just wrote newer global
  // translations for them than anything the overlay holds. A market layer is
  // not touched (the run writes no market override), and neither is a locale
  // or resource the answer reports as failed (nothing newer exists there).
  const dropStagedFor = (
    resourceIds: readonly string[],
    failed: { failedLocales?: readonly string[]; failedResources?: readonly string[] } = {},
  ) => {
    const failedResources = new Set(failed.failedResources ?? []);
    for (const id of resourceIds) {
      if (failedResources.has(id)) continue;
      recentlyStagedRef.current.delete(id);
      keepOverlayIdsRef.current.delete(id);
    }
    if (
      dropGlobalStagedFor(localSubResourceOverlayRef.current, overlayStampsRef.current, resourceIds, {
        isGlobalLayerKey: (key) => !key.includes(LOCALE_MARKET_SEP),
        failedLocales: failed.failedLocales,
        failedResources: failed.failedResources,
      })
    ) {
      touchOverlay();
    }
  };

  // The caller passes `strings` as a fresh object every render; read it through
  // a ref so the callbacks below are not rebuilt each time.
  const stringsRef = useLatestRef(strings);
  // The answer handlers read the render that is CURRENT when the answer lands
  // (the view, the overlay, the pending sets), never the one the button was
  // pressed in -- several requests are out at once and land in any order.
  const answerHandlersRef = useLatestRef({
    item: selectedItem,
    readTranslationsFromItem,
    applyTranslationsToState,
    setFallbackResourceIds,
    touchOverlay,
    stageTranslations,
    reportFailedRequest,
    rollbackCopy,
    restoreFailedResources,
    settleCopiedResource,
    syncHasChanges,
    revalidator,
    requestRevalidate,
    dropStagedFor,
    showInfoBox,
  });

  // Run ONE translate request -- a single field, an option, a metafield, or
  // "translate all" -- with its own lifecycle. Each request:
  //   - is its own plain `fetch` (never the shared fetcher, whose next
  //     `submit()` would abort this one and lose its answer);
  //   - stages its answer under the item/language it was ASKED for and puts it
  //     on screen only while that is still what shows, merged field by field
  //     so an earlier answer is never overwritten by a later one;
  //   - settles exactly the spinners IT holds, in `finally`: on success, on a
  //     refusal, on a network failure, and also after the page moved on.
  const runTranslateRequest = useCallback(async (opts: {
    itemId: string;
    item: TranslatableContentItem;
    fieldIds: string[];
    form: FormData;
    requested: TranslateTarget | null;
    /** The primary-locale translate of ONE field says it landed (nothing shows). */
    confirmPrimary: boolean;
    revalidateAfter: boolean;
    /** Resources whose staged overlay entries a successful answer supersedes. */
    dropOverlayIds?: string[];
  }) => {
    try {
      const data = await postSubResourceRequest(opts.form);
      const h = answerHandlersRef.current;
      if (!data || data.success === false) {
        // A refused or failed translate is said, never swallowed: the server's
        // sentence as is (a managed-AI refusal is already localised), the plan
        // refusal's code "gated" mapped to the upgrade message.
        h.reportFailedRequest(data ?? { success: false, actionType: String(opts.form.get("action") ?? "") });
        return;
      }
      const answer = (data.translations || {}) as Record<string, Record<string, string>>;
      if (h.stageTranslations(answer, opts.requested) === "apply") {
        // Merged against the item showing NOW (a reload may have replaced the
        // one the button was pressed on -- new value ids after a save), never
        // the captured one; the plan already guarantees it is the same item.
        const current = h.item && h.item.id === opts.itemId ? h.item : opts.item;
        applyTranslationsToState(current, answer);
      }
      // A primary-locale translate-to-all wrote NEW translations into every
      // language: whatever the overlay staged for those resources (an older
      // translate answer, a confirmed clear's "") is older than them and would
      // shadow them after the reload. Dropped in every locale and layer.
      if (opts.dropOverlayIds && opts.dropOverlayIds.length > 0) {
        h.dropStagedFor(opts.dropOverlayIds, {
          failedLocales: data.failedLocales,
          failedResources: data.failedResources,
        });
      }
      // A translate into EVERY language answers its confirmed values per
      // locale: each is staged under the locale it was written for, and the one
      // on screen NOW is shown. Relying on the re-read below alone lost them
      // for a merchant who switched language while the run worked -- the load
      // effect does not re-read an already open view, and the re-read is
      // skipped while another one is in flight.
      // Applied against the item showing NOW (as above), and never over a
      // resource the merchant has typed into and not saved yet: the staging
      // keeps the whole answer, the open view skips the dirty resources.
      const byLocale = data.localeTranslations;
      if (byLocale) {
        const current = h.item && h.item.id === opts.itemId ? h.item : opts.item;
        for (const [locale, localeAnswer] of Object.entries(byLocale)) {
          const target = { itemId: opts.itemId, locale, marketId: "" };
          if (h.stageTranslations(localeAnswer, target) === "apply") {
            const pending = pendingStateRef.current;
            const visible = answerWithoutDirty(localeAnswer, [
              pending?.dirtyOptionIds ?? new Set<string>(),
              pending?.dirtyOptionValueIds ?? new Set<string>(),
              pending?.dirtyMetafieldIds ?? new Set<string>(),
            ]);
            if (Object.keys(visible).length > 0) h.applyTranslationsToState(current, visible);
          }
        }
      }
      // A primary-locale translate saves into every language server-side and
      // returns nothing to show: re-read so the locale markers move.
      if (opts.revalidateAfter) h.requestRevalidate();
      // Only the translated fields are saved; other pending edits stay pending.
      h.syncHasChanges();
      // A run in which fields or languages failed is never reported as done.
      const outcome = subResourceOutcome(data, stringsRef.current);
      if (outcome) {
        h.showInfoBox?.(outcome.text, outcome.tone);
      } else if (opts.confirmPrimary) {
        h.showInfoBox?.(stringsRef.current.optionTranslatedAll || "Translation saved for all languages", "success");
      }
    } finally {
      for (const fieldId of opts.fieldIds) endSubResourceSpinner(opts.itemId, fieldId);
    }
  }, [applyTranslationsToState, answerHandlersRef, stringsRef]);

  // A SINGLE field/option/metafield translate.
  const runIndividualTranslate = useCallback((
    fieldId: string,
    sourceData: Array<{ resourceId: string; resourceType: string; key: string; value: string; label: string }>,
  ) => {
    const item = selectedItem;
    if (!item) return;
    const resourceId = item.id;
    const requested: TranslateTarget | null = isPrimaryLocale
      ? null
      : { itemId: resourceId, locale: currentLanguage, marketId: selectedMarketId };

    const fd = new FormData();
    fd.set("sourceData", JSON.stringify(sourceData));
    fd.set("itemId", resourceId);
    fd.set("primaryLocale", primaryLocale);
    fd.set("fieldId", fieldId);
    if (isPrimaryLocale) {
      // Primary locale: translate to ALL foreign locales (saved server-side).
      fd.set("action", "translateSubResourceToAllLocales");
    } else {
      fd.set("action", "translateSubResources");
      fd.set("targetLocale", currentLanguage);
    }

    // Spinner first, so it shows immediately and persists across navigation.
    beginSubResourceSpinner(resourceId, fieldId, "translateSubResource");
    void runTranslateRequest({
      itemId: resourceId,
      item,
      fieldIds: [fieldId],
      form: fd,
      requested,
      confirmPrimary: isPrimaryLocale,
      revalidateAfter: isPrimaryLocale,
      dropOverlayIds: isPrimaryLocale ? sourceData.map((s) => s.resourceId) : undefined,
    });
  }, [selectedItem, isPrimaryLocale, currentLanguage, primaryLocale, selectedMarketId, runTranslateRequest]);

  const translateOption = useCallback((optionId: string) => {
    const sourceData = buildSourceData(optionId);
    if (sourceData.length === 0) return;
    runIndividualTranslate(`${optionId}:entire`, sourceData);
  }, [buildSourceData, runIndividualTranslate]);

  const translateOptionField = useCallback((optionId: string, fieldType: "name" | "value", valueIndex?: number) => {
    if (!selectedItem || optionTranslationBlockedIds.has(optionId)) return;

    const option = selectedItem.options?.find(o => o.id === optionId);
    if (!option) return;

    let sourceData: Array<{ resourceId: string; resourceType: string; key: string; value: string; label: string }>;
    const fieldId = fieldType === "name" ? `${optionId}:name` : `${optionId}:value:${valueIndex}`;

    if (fieldType === "name") {
      sourceData = [{
        resourceId: option.id,
        resourceType: "ProductOption",
        key: "name",
        value: option.name,
        label: `Option: ${option.name}`,
      }];
    } else {
      const val = option.values[valueIndex!];
      if (!val?.id) return;
      sourceData = [{
        resourceId: val.id,
        resourceType: "ProductOptionValue",
        key: "name",
        value: val.name,
        label: `Value: ${val.name}`,
      }];
    }

    runIndividualTranslate(fieldId, sourceData);
  }, [selectedItem, runIndividualTranslate, optionTranslationBlockedIds]);

  const translateMetafield = useCallback((metafieldId: string) => {
    if (isPrimaryLocale || !selectedItem) return;

    const mf = selectedItem.metafields?.find(m => m.id === metafieldId);
    if (!mf) return;

    runIndividualTranslate(`${metafieldId}:value`, [{
      resourceId: mf.id,
      resourceType: "Metafield",
      key: "value",
      value: mf.value,
      label: `${mf.namespace}.${mf.key}`,
    }]);
  }, [isPrimaryLocale, selectedItem, runIndividualTranslate]);

  // Every granular spinner a translate-all covers, plus its global marker.
  const translateAllFieldIds = useCallback((item: TranslatableContentItem): string[] => {
    const fieldIds = new Set<string>();
    for (const opt of item.options || []) {
      fieldIds.add(`${opt.id}:name`);
      if (!opt.isLinked) {
        for (let i = 0; i < opt.values.length; i++) {
          if (opt.values[i].id) fieldIds.add(`${opt.id}:value:${i}`);
        }
      }
    }
    for (const mf of item.metafields || []) {
      fieldIds.add(`${mf.id}:value`);
    }
    fieldIds.add("all:subresources");
    return [...fieldIds];
  }, []);

  // Which "translate all" runs are out, as `<item>|<locale>` (`*` = every
  // language): the editor's "clear all" of that language waits for them.
  const translateAllRunsRef = useRef<Map<string, number>>(new Map());
  const trackTranslateAllRun = useCallback((itemId: string, locale: string, run: Promise<unknown>) => {
    const key = `${itemId}|${locale}`;
    const runs = translateAllRunsRef.current;
    runs.set(key, (runs.get(key) ?? 0) + 1);
    void run
      .finally(() => {
        const left = (runs.get(key) ?? 1) - 1;
        if (left > 0) runs.set(key, left);
        else runs.delete(key);
      })
      // The run reports its own failure; a rejection must not surface as an
      // unhandled one here.
      .catch(() => {});
  }, []);
  // The card's own "clear all" requests that are out, as `<item>|<locale>`.
  const clearsOutRef = useRef<Map<string, number>>(new Map());
  const fetcherForSaveCheckRef = useRef(fetcher);
  fetcherForSaveCheckRef.current = fetcher;
  const isSaveInFlight = useCallback((itemId: string, locale: string) => {
    for (const key of clearsOutRef.current.keys()) {
      const [clearItem, clearLocale] = key.split("|");
      if (clearItem === itemId && (locale === "*" || clearLocale === locale)) return true;
    }
    const f = fetcherForSaveCheckRef.current;
    if (f.state === "idle" || !f.formData) return false;
    const form = f.formData;
    return subResourceSaveRacesRun((key) => form.get(key), itemId, locale);
  }, []);

  const isTranslateAllRunning = useCallback((itemId: string, locale: string) => {
    const runs = translateAllRunsRef.current;
    return runs.has(`${itemId}|${locale}`) || runs.has(`${itemId}|*`);
  }, []);

  const translateAllSubResources = useCallback(() => {
    if (isPrimaryLocale || !selectedItem) return;

    const sourceData = buildSourceData();
    if (sourceData.length === 0) return;

    const fieldIds = translateAllFieldIds(selectedItem);
    for (const fid of fieldIds) beginSubResourceSpinner(selectedItem.id, fid, "translateSubResource");

    const fd = new FormData();
    fd.set("action", "translateSubResources");
    fd.set("targetLocale", currentLanguage);
    fd.set("primaryLocale", primaryLocale);
    fd.set("sourceData", JSON.stringify(sourceData));
    fd.set("itemId", selectedItem.id);
    fd.set("fieldId", "all:subresources");
    trackTranslateAllRun(selectedItem.id, currentLanguage, runTranslateRequest({
      itemId: selectedItem.id,
      item: selectedItem,
      fieldIds,
      form: fd,
      requested: { itemId: selectedItem.id, locale: currentLanguage, marketId: selectedMarketId },
      confirmPrimary: false,
      revalidateAfter: false,
    }));
  }, [isPrimaryLocale, buildSourceData, currentLanguage, primaryLocale, selectedItem, selectedMarketId, translateAllFieldIds, runTranslateRequest, trackTranslateAllRun]);

  // Translate ALL sub-resources to ALL foreign locales (called from primary locale "Translate All")
  const translateAllSubResourcesToAllLocales = useCallback(() => {
    if (!isPrimaryLocale || !selectedItem) return;

    const sourceData = buildSourceData();
    if (sourceData.length === 0) return;

    const fieldIds = translateAllFieldIds(selectedItem);
    for (const fid of fieldIds) beginSubResourceSpinner(selectedItem.id, fid, "translateSubResourceToAllLocales");

    const fd = new FormData();
    fd.set("action", "translateSubResourceToAllLocales");
    fd.set("sourceData", JSON.stringify(sourceData));
    fd.set("itemId", selectedItem.id);
    fd.set("primaryLocale", primaryLocale);
    fd.set("fieldId", "all:subresources");
    trackTranslateAllRun(selectedItem.id, "*", runTranslateRequest({
      itemId: selectedItem.id,
      item: selectedItem,
      fieldIds,
      form: fd,
      requested: null,
      confirmPrimary: false,
      revalidateAfter: true,
      dropOverlayIds: sourceData.map((s) => s.resourceId),
    }));
  }, [isPrimaryLocale, buildSourceData, selectedItem, primaryLocale, translateAllFieldIds, runTranslateRequest, trackTranslateAllRun]);

  // The save bar's save shares the fetcher with Phase 2, and its submit ABORTS
  // a load still in flight: that load is re-queued for when the save is done
  // (see the deferred-load effect) instead of leaving `isLoading` stuck and
  // the Shopify supplement lost.
  const yieldLoadToSave = useCallback(() => {
    if (!pendingLoadRef.current) return;
    deferredLoadRef.current = pendingLoadRef.current;
    pendingLoadRef.current = null;
  }, []);

  // Unified save handler - automatically detects primary vs foreign locale
  const saveSubResources = useCallback(() => {
    if (!hasChanges || !selectedItem) {
      return;
    }

    if (isPrimaryLocale) {
      // PRIMARY LOCALE: Save primary values (options + metafields)
      const optionsChanges: Record<
        string,
        {
          name?: string;
          valueUpdates?: { id: string; name: string }[];
          valuesToAdd?: string[];
          valuesToAddLinked?: string[];
          valuesToDelete?: string[];
        }
      > = {};
      const metafieldChanges: Record<string, string> = {};

      // Collect option name and value changes with validation
      for (const [optionId, edit] of Object.entries(primaryOptionEdits)) {
        const originalOption = selectedItem.options?.find(o => o.id === optionId);
        // Same rule as the passes below: an option on its way out cannot be
        // renamed, and asking would fail the whole save.
        if (!originalOption || optionsToDelete.includes(optionId)) {
          continue;
        }

        const hasNameChange = edit.name !== undefined && edit.name !== originalOption.name;
        const hasValuesChange =
          edit.values !== undefined &&
          JSON.stringify(edit.values) !== JSON.stringify(originalOption.values.map(v => v.name));

        if (hasNameChange || hasValuesChange) {
          // VALIDATION: Prevent empty option names and values
          if (hasNameChange && edit.name.trim() === "") {
            if (showInfoBox) {
              showInfoBox(strings.optionNameEmpty || "Option name cannot be empty", "critical");
            } else {
              alert("Option name cannot be empty");
            }
            return;
          }
          // A value the merchant renamed and then DELETED must not be sent as
          // both a rename and a delete: Shopify rejects the contradiction, and
          // because failures are per option that takes the other renames on
          // the same option down with it. It also must not trip the
          // empty-value guard below -- a value on its way out is allowed to
          // read blank.
          const deletedHere = new Set(optionValuesToDelete[optionId] ?? []);
          const survivingEdits = originalOption.values
            .map((v, i) => ({ id: v.id, name: edit.values[i], original: v.name }))
            .filter((v) => !deletedHere.has(v.id));

          if (hasValuesChange && survivingEdits.some(v => (v.name ?? "").trim() === "")) {
            if (showInfoBox) {
              showInfoBox(strings.optionValuesEmpty || "Option values cannot be empty", "critical");
            } else {
              alert("Option values cannot be empty");
            }
            return;
          }

          optionsChanges[optionId] = {};
          if (hasNameChange) optionsChanges[optionId].name = edit.name;
          // For metaobject-linked options, only save name changes (not values)
          if (hasValuesChange && !originalOption.isLinked) {
            // Only include values that actually changed — and never one that
            // is being deleted in the same save.
            const updates = survivingEdits
              .filter((v) => v.name !== v.original)
              .map((v) => ({ id: v.id, name: v.name }));
            if (updates.length > 0) optionsChanges[optionId].valueUpdates = updates;
          }
        }
      }

      // Values added and removed. Their own pass: a merchant can add a colour
      // without renaming anything, and the loop above only visits options that
      // carry a text edit.
      // An option being deleted in the same save takes its queued edits with
      // it. Sent, they address a GID that no longer exists: Shopify rejects
      // them, the save reports "changes have been reverted", and the merchant
      // is told the opposite of what happened -- the delete succeeded and is
      // irreversible. The value-order pass already filtered this; the add and
      // remove passes did not.
      for (const [optionId, added] of Object.entries(optionValuesToAdd)) {
        if (added.length === 0 || optionsToDelete.includes(optionId)) continue;
        optionsChanges[optionId] = { ...(optionsChanges[optionId] ?? {}), valuesToAdd: added };
      }
      for (const [optionId, removed] of Object.entries(optionValuesToDelete)) {
        if (removed.length === 0 || optionsToDelete.includes(optionId)) continue;
        optionsChanges[optionId] = { ...(optionsChanges[optionId] ?? {}), valuesToDelete: removed };
      }
      // A LINKED option's additions travel as metaobject GIDs: its values are
      // entries, not free text, and Shopify takes the name from the entry.
      for (const [optionId, added] of Object.entries(optionLinkedValuesToAdd)) {
        if (added.length === 0 || optionsToDelete.includes(optionId)) continue;
        optionsChanges[optionId] = {
          ...(optionsChanges[optionId] ?? {}),
          valuesToAddLinked: added.map((e) => e.id),
        };
      }

      // Collect metafield value changes with validation
      for (const [metafieldId, editValue] of Object.entries(primaryMetafieldEdits)) {
        const originalMetafield = selectedItem.metafields?.find(m => m.id === metafieldId);
        if (!originalMetafield) continue;

        if (editValue !== originalMetafield.value) {
          // VALIDATION: Prevent empty metafield values
          if (editValue.trim() === "") {
            if (showInfoBox) {
              showInfoBox(strings.metafieldValuesEmpty || "Metafield values cannot be empty", "critical");
            } else {
              alert("Metafield values cannot be empty");
            }
            return;
          }
          metafieldChanges[metafieldId] = editValue;
        }
      }

      // The order counts as changed only if it DIFFERS from the saved one:
      // dragging an option away and back leaves `optionOrder` non-null, and a
      // reorder that reorders nothing is a Shopify call with a chance of going
      // wrong and no chance of achieving anything.
      const savedOrder = [...(selectedItem.options ?? [])]
        .sort((a, b) => a.position - b.position)
        .map((o) => o.id);
      const wantedOrder = (optionOrder ?? []).filter((id) => !optionsToDelete.includes(id));
      const orderChanged =
        optionOrder !== null &&
        JSON.stringify(wantedOrder) !== JSON.stringify(savedOrder.filter((id) => !optionsToDelete.includes(id)));

      // Values that actually MOVED, per option. Same rule as the option order:
      // an arrangement identical to the saved one is not a change, and writing
      // it would be a Shopify call with nothing to achieve.
      const movedValueOrder: Record<string, string[]> = {};
      for (const [optionId, ids] of Object.entries(optionValueOrder)) {
        const option = selectedItem.options?.find((o) => o.id === optionId);
        // An option being deleted in the same save has no order left to have
        // changed, and keeping it would force a reorder call whose entire
        // content is restating positions nobody moved.
        if (!option || optionsToDelete.includes(optionId)) continue;
        const deletedHere = new Set(optionValuesToDelete[optionId] ?? []);
        const saved = option.values.map((v) => v.id).filter((id) => id && !deletedHere.has(id));
        const wanted = ids.filter((id) => !deletedHere.has(id) && saved.includes(id));
        if (wanted.length === saved.length && JSON.stringify(wanted) !== JSON.stringify(saved)) {
          movedValueOrder[optionId] = wanted;
        }
      }
      const valueOrderChanged = Object.keys(movedValueOrder).length > 0;

      const hasStructuralChange =
        optionsToCreate.length > 0 || optionsToDelete.length > 0 || orderChanged || valueOrderChanged;
      if (
        Object.keys(optionsChanges).length === 0 &&
        Object.keys(metafieldChanges).length === 0 &&
        !hasStructuralChange
      ) {
        setHasChanges(false);
        return;
      }

      // Create FormData to submit
      const formData = new FormData();
      formData.append("action", "savePrimarySubResources");
      formData.append("productId", selectedItem.id);
      formData.append("optionsChanges", JSON.stringify(optionsChanges));
      formData.append("metafieldChanges", JSON.stringify(metafieldChanges));
      // The structural half. Sent only when it has content: an empty order
      // list would otherwise ask Shopify to reorder nothing on every save.
      if (optionsToCreate.length > 0) {
        formData.append("optionsToCreate", JSON.stringify(optionsToCreate));
      }
      if (optionsToDelete.length > 0) {
        formData.append("optionsToDelete", JSON.stringify(optionsToDelete));
      }
      if (orderChanged || valueOrderChanged) {
        // Already minus whatever is being deleted in the same save — naming a
        // gone option would fail the reorder for all of them. Options CREATED
        // in the same save have no GID yet and so cannot appear here; the
        // server runs creates first and Shopify appends them, which is where a
        // merchant expects a brand-new variant to land.
        //
        // Sent even when only VALUES moved: the reorder mutation hangs its
        // values off an option list, so it needs the current order to name
        // them under.
        const orderToSend = orderChanged
          ? wantedOrder
          : savedOrder.filter((id) => !optionsToDelete.includes(id));
        formData.append("optionOrder", JSON.stringify(orderToSend));
      }
      if (valueOrderChanged) {
        // UNMEASURED: values ADDED in the same save have no GID yet, so a
        // reorder that follows an add names only the values that already
        // existed. Whether `productOptionsReorder` accepts a partial value
        // list or demands the complete set is not established -- if it demands
        // it, this reorder fails and says so (the save reports a structural
        // failure), rather than applying a wrong order silently. Worth one
        // probe against a live shop before relying on the combination.
        formData.append("optionValueOrder", JSON.stringify(movedValueOrder));
      }

      pendingPrimarySaveIdsRef.current = changedIdsOfPrimarySave(optionsChanges, metafieldChanges);
      pendingPrimarySaveSentRef.current = { options: optionsChanges, metafields: metafieldChanges };
      yieldLoadToSave();
      fetcher.submit(formData, { method: "POST", action: "/app/products" });
    } else {
      // FOREIGN LOCALE: Save translations
      const translationsData: Record<string, Record<string, string>> = {};
      const resourceTypes: Record<string, string> = {};

      for (const opt of selectedItem.options || []) {
        const trans = optionTranslations[opt.id];
        // Only include options the user actually modified
        if (trans?.name !== undefined && dirtyOptionIds.has(opt.id)) {
          translationsData[opt.id] = { name: trans.name };
          resourceTypes[opt.id] = "ProductOption";
        }
        if (!opt.isLinked) {
          for (let i = 0; i < opt.values.length; i++) {
            const val = opt.values[i];
            // Only include option values the user actually modified
            if (val.id && trans?.values[i] !== undefined && dirtyOptionValueIds.has(val.id)) {
              translationsData[val.id] = { name: trans.values[i] };
              resourceTypes[val.id] = "ProductOptionValue";
            }
          }
        }
      }

      for (const mf of selectedItem.metafields || []) {
        const trans = metafieldTranslations[mf.id];
        // Only include metafields the user actually modified
        if (trans !== undefined && dirtyMetafieldIds.has(mf.id)) {
          translationsData[mf.id] = { value: trans };
          resourceTypes[mf.id] = "Metafield";
        }
      }

      if (Object.keys(translationsData).length === 0) return;

      pendingForeignSaveRef.current = {
        localeKey: buildLocaleKey(currentLanguage, selectedMarketId),
        marketLayer: !!selectedMarketId,
        values: translationsData,
      };
      yieldLoadToSave();
      fetcher.submit(
        {
          action: "saveSubResourceTranslations",
          locale: currentLanguage,
          translationsData: JSON.stringify(translationsData),
          resourceTypes: JSON.stringify(resourceTypes),
          itemId: selectedItem.id,
          marketId: selectedMarketId,
        },
        { method: "POST", action: "/app/products" }
      );
    }
  }, [hasChanges, isPrimaryLocale, selectedItem, primaryOptionEdits, primaryMetafieldEdits, optionTranslations, metafieldTranslations, currentLanguage, selectedMarketId, fetcher, dirtyOptionIds, dirtyOptionValueIds, dirtyMetafieldIds, optionValuesToAdd, optionLinkedValuesToAdd, optionValuesToDelete, optionsToCreate, optionsToDelete, optionOrder, optionValueOrder, yieldLoadToSave]);

  const clearAllForLocale = useCallback(() => {
    if (!selectedItem || isPrimaryLocale) return;
    const overlayKey = buildLocaleKey(currentLanguage, selectedMarketId);
    const { translationsData, resourceTypes } = buildClearAllSubResourcePayload({
      item: selectedItem,
      locale: currentLanguage,
      marketId: selectedMarketId,
      optionTranslations,
      metafieldTranslations,
      fallbackResourceIds,
      overlayForLayer: localSubResourceOverlayRef.current[overlayKey],
    });

    // Empty what this layer holds at once, like the editor's own fields; an
    // inherited global value stays shown (a market clear does not touch it),
    // and so does a LINKED option's value (translated on its metaobject).
    // Unsaved typed values of this locale go too: "clear all" supersedes them.
    const keepInherited = (id: string | undefined) =>
      !!id && !!selectedMarketId && fallbackResourceIds.has(id);
    setOptionTranslations((prev) => {
      const next: Record<string, OptionTranslation> = {};
      for (const [optionId, trans] of Object.entries(prev)) {
        const option = selectedItem.options?.find((o) => o.id === optionId);
        next[optionId] = {
          name: keepInherited(optionId) ? trans.name : "",
          values: trans.values.map((value, index) =>
            option?.isLinked || keepInherited(option?.values[index]?.id) ? value : "",
          ),
        };
      }
      return next;
    });
    setMetafieldTranslations((prev) => {
      const next: Record<string, string> = {};
      for (const [id, value] of Object.entries(prev)) next[id] = keepInherited(id) ? value : "";
      return next;
    });
    setDirtyOptionIds(new Set());
    setDirtyOptionValueIds(new Set());
    setDirtyMetafieldIds(new Set());
    setHasChanges(false);

    if (Object.keys(translationsData).length === 0) return;

    // Its OWN request, like every translate and copy: on the shared fetcher it
    // aborted a Phase-2 load or the save bar's save (and was aborted by them),
    // and its answer was then read as theirs.
    //
    // While it is in flight the cleared fields are STAGED EMPTY values in the
    // overlay, so a reload's re-read or a Phase-2 Shopify answer that lands
    // meanwhile cannot put them back (both merge the overlay over the item,
    // which still carries the rows); the record of what was staged travels
    // with this request and settles exactly its own fields.
    const requested = { itemId: selectedItem.id, locale: currentLanguage, marketId: selectedMarketId };
    const marketLayer = !!selectedMarketId;
    const snapshot = stageClearAll(localSubResourceOverlayRef.current, overlayKey, translationsData);
    const stagedAt = Date.now();
    const previousStamps = new Map<string, number | undefined>();
    for (const resourceId of Object.keys(translationsData)) {
      previousStamps.set(resourceId, recentlyStagedRef.current.get(resourceId));
      // Kept through a reload's overlay reset like a translate answer: the
      // loader may have read the rows before the removal deleted them.
      recentlyStagedRef.current.set(resourceId, stagedAt);
    }
    stampStaged(overlayKey, Object.keys(translationsData));
    touchOverlay();

    const fd = new FormData();
    fd.set("action", "saveSubResourceTranslations");
    fd.set("locale", currentLanguage);
    fd.set("translationsData", JSON.stringify(translationsData));
    fd.set("resourceTypes", JSON.stringify(resourceTypes));
    fd.set("itemId", selectedItem.id);
    fd.set("marketId", selectedMarketId);

    const clearKey = `${requested.itemId}|${requested.locale}`;
    clearsOutRef.current.set(clearKey, (clearsOutRef.current.get(clearKey) ?? 0) + 1);
    const clearDone = () => {
      const left = (clearsOutRef.current.get(clearKey) ?? 1) - 1;
      if (left > 0) clearsOutRef.current.set(clearKey, left);
      else clearsOutRef.current.delete(clearKey);
    };
    void (async () => {
      let data: Awaited<ReturnType<typeof postSubResourceRequest>>;
      try {
        data = await postSubResourceRequest(fd);
      } finally {
        clearDone();
      }
      const h = answerHandlersRef.current;
      const view = currentViewRef.current;
      // A different item reset the overlay and the stamps; nothing here is
      // that item's to settle. Another language or market of the SAME item
      // still gets its overlay settled, only the visible state is left alone.
      if (view.itemId !== requested.itemId) {
        if (!data || data.success === false) {
          h.reportFailedRequest(data ?? { success: false, actionType: "saveSubResourceTranslations" });
        }
        return;
      }
      const sameView = view.locale === requested.locale && view.marketId === requested.marketId;
      const confirmed = confirmedClearIds(translationsData, data);
      settleClearAll(localSubResourceOverlayRef.current, overlayKey, snapshot, confirmed, marketLayer);
      for (const [resourceId, previous] of previousStamps) {
        const keepStaged = confirmed.has(resourceId) && !marketLayer;
        if (keepStaged) recentlyStagedRef.current.set(resourceId, Date.now());
        else if (previous === undefined) recentlyStagedRef.current.delete(resourceId);
        else recentlyStagedRef.current.set(resourceId, previous);
      }
      // The confirmed "" lives from the confirmation on; a restored pair keeps
      // the clear's stamp, which is never older than what it restored.
      if (confirmed.size > 0 && !marketLayer) stampStaged(overlayKey, confirmed);
      h.touchOverlay();

      if (!data || data.success === false) {
        // Nothing reached Shopify, nothing was removed: the emptied fields go
        // back to what the layer still holds (overlay restored above).
        h.reportFailedRequest(data ?? { success: false, actionType: "saveSubResourceTranslations" });
        if (sameView) h.readTranslationsFromItem(false);
        return;
      }

      const unconfirmed = Object.keys(translationsData).filter((id) => !confirmed.has(id));
      if (unconfirmed.length > 0) {
        // Shopify kept these translations: they are live, so they show again.
        h.showInfoBox?.(
          (stringsRef.current.saveFailedOptions || "Failed to save {count} option(s). Changes have been reverted to original values.").replace("{count}", String(unconfirmed.length)),
          "critical",
        );
        if (sameView && h.item) {
          h.restoreFailedResources(unconfirmed);
          const restoredOverlay: Record<string, Record<string, string>> = {};
          const layer = localSubResourceOverlayRef.current[overlayKey] || {};
          for (const id of unconfirmed) if (layer[id]) restoredOverlay[id] = layer[id];
          h.applyTranslationsToState(h.item, restoredOverlay);
        }
      }

      if (marketLayer && sameView && confirmed.size > 0 && h.item) {
        // A removed market override leaves the market INHERITING the global
        // value: shown greyed at once, from the global rows (and staged global
        // values) the clear did not touch.
        const { map: globalMap } = dbPreloadToMap(h.item.subResourceTranslations, requested.locale, "");
        const globalOverlay = localSubResourceOverlayRef.current[buildLocaleKey(requested.locale, "")] || {};
        const inherited: Record<string, Record<string, string>> = {};
        for (const id of confirmed) {
          const fields = { ...(globalMap[id] || {}), ...(globalOverlay[id] || {}) };
          const value = fields.name ?? fields.value ?? "";
          if (value) inherited[id] = fields;
        }
        if (Object.keys(inherited).length > 0) {
          h.applyTranslationsToState(h.item, inherited);
          h.setFallbackResourceIds((prev) => {
            const next = new Set(prev);
            for (const id of Object.keys(inherited)) next.add(id);
            return next;
          });
        }
      }

      // The loaded item still carries the removed rows; a reload brings it in
      // line (the staged "" keeps a global clear empty until it lands). No
      // success message: the editor's own clear reports the clear.
      // A reload already running may have read before the removal: queued.
      if (confirmed.size > 0) h.requestRevalidate();
    })();
  }, [selectedItem, isPrimaryLocale, currentLanguage, selectedMarketId, optionTranslations, metafieldTranslations, fallbackResourceIds, touchOverlay, stampStaged, answerHandlersRef, currentViewRef, stringsRef]);

  const resetChanges = useCallback(() => {
    // Reset foreign locale translations
    setOptionTranslations({});
    setMetafieldTranslations({});
    setDirtyOptionIds(new Set());
    setDirtyOptionValueIds(new Set());
    setDirtyMetafieldIds(new Set());

    // Reset primary locale edits
    setPrimaryOptionEdits({});
    setOptionValuesToAdd({});
    setOptionLinkedValuesToAdd({});
    setOptionValuesToDelete({});
    setOptionsToCreate([]);
    setOptionsToDelete([]);
    setOptionOrder(null);
    setOptionValueOrder({});
    // The card keeps the dragged order in its own state so a drag feels
    // immediate; without this it would go on showing an arrangement that the
    // discard just threw away.
    setSavedNonce((n) => n + 1);
    setPrimaryMetafieldEdits({});

    // Reset flags
    setHasChanges(false);
    // Note: translatingFieldIds in global store is cleared per-resource,
    // no need to clear here — the operation will finish naturally.

    // Force reload from DB/Shopify on next render
    loadedForRef.current = "";
  }, []);

  /** Force re-load on next render (called after revalidation delivers fresh DB data) */
  const resetForReload = useCallback(() => {
    loadedForRef.current = "";
    // Fresh data is about to be applied: staged values must not shadow it
    // (unconfirmed-purge resources excepted, their translations are still live;
    // and a translate answer from the last moments, which the reload may have
    // read before its write -- see `overlayResetKeepIds`).
    localSubResourceOverlayRef.current = overlayKeepingOnly(
      localSubResourceOverlayRef.current,
      overlayResetKeepIds(),
    );
    pruneOverlayStamps(overlayStampsRef.current, localSubResourceOverlayRef.current);
    touchOverlay();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- overlayResetKeepIds reads refs only
  }, [touchOverlay]);

  const copyOptionField = useCallback((optionId: string, fieldType: "name" | "value", valueIndex?: number) => {
    if (!selectedItem) return;
    const option = selectedItem.options?.find(o => o.id === optionId);
    if (!option) return;

    let translationsData: Record<string, { name: string }>;
    let resourceTypes: Record<string, string>;
    const fieldId = fieldType === "name" ? `${optionId}:name` : `${optionId}:value:${valueIndex}`;

    if (fieldType === "name") {
      if (!option.name) return;
      translationsData = { [option.id]: { name: option.name } };
      resourceTypes = { [option.id]: "ProductOption" };
      handleOptionNameChange(optionId, option.name);
    } else {
      const val = option.values[valueIndex!];
      if (!val?.id || !val.name) return;
      translationsData = { [val.id]: { name: val.name } };
      resourceTypes = { [val.id]: "ProductOptionValue" };
      handleOptionValueChange(optionId, valueIndex!, val.name);
    }

    // Write to overlay immediately (eliminates stale window when switching
    // locale). Market-folded so a market-scoped copy stays in the market layer.
    const overlayKey = buildLocaleKey(currentLanguage, selectedMarketId);
    const overlay = localSubResourceOverlayRef.current;
    if (!overlay[overlayKey]) overlay[overlayKey] = {};
    const [copiedResourceId, copiedFields] = Object.entries(translationsData)[0];
    // Remembered so a refused save can put the real stored value back. The
    // record travels with THIS request: several copies may be out at once.
    const copied: CopyRecord = {
      itemId: selectedItem.id,
      locale: currentLanguage,
      marketId: selectedMarketId,
      overlayKey,
      resourceId: copiedResourceId,
      value: copiedFields.name,
      previous: overlay[overlayKey][copiedResourceId]?.["name"],
    };
    for (const [resourceId, fields] of Object.entries(translationsData)) {
      if (!overlay[overlayKey][resourceId]) overlay[overlayKey][resourceId] = {};
      overlay[overlayKey][resourceId]["name"] = fields.name;
    }
    stampStaged(overlayKey, Object.keys(translationsData));
    touchOverlay();

    const itemId = selectedItem.id;
    beginSubResourceSpinner(itemId, fieldId, "copy");

    const fd = new FormData();
    fd.set("action", "saveSubResourceTranslations");
    fd.set("locale", currentLanguage);
    fd.set("translationsData", JSON.stringify(translationsData));
    fd.set("resourceTypes", JSON.stringify(resourceTypes));
    fd.set("itemId", itemId);
    fd.set("marketId", selectedMarketId);

    // Its own request, like every translate: on the shared fetcher a second
    // Copy (or the load, or the save bar) aborted this one, its answer was
    // never read and its spinner hung.
    void (async () => {
      try {
        const data = await postSubResourceRequest(fd);
        const h = answerHandlersRef.current;
        const view = currentViewRef.current;
        // The pending sets and the visible values belong to the view the copy
        // was made in; in another view only the overlay is settled.
        const sameView =
          view.itemId === copied.itemId && view.locale === copied.locale && view.marketId === copied.marketId;
        if (!data || data.success === false) {
          // The copy's value was staged as saved; it was not, so it goes again
          // (the edit itself stays pending, like every failed request).
          h.reportFailedRequest(data ?? { success: false, actionType: "saveSubResourceTranslations" });
          h.rollbackCopy(copied);
          return;
        }
        const failedResources = data.failedResources || [];
        if (failedResources.length > 0) {
          h.showInfoBox?.(
            (stringsRef.current.saveFailedOptions || "Failed to save {count} option(s). Changes have been reverted to original values.").replace("{count}", String(failedResources.length)),
            "critical",
          );
          h.rollbackCopy(copied);
          if (sameView) {
            h.restoreFailedResources(failedResources);
            h.settleCopiedResource(copied.resourceId);
          }
        } else if ((data.notTranslatable || []).length > 0) {
          // Not a refused write: Shopify exposes no digest for the field.
          const outcome = subResourceOutcome(data, stringsRef.current);
          if (outcome) h.showInfoBox?.(outcome.text, outcome.tone);
          if (sameView) h.settleCopiedResource(copied.resourceId);
        } else {
          // Only the one resource was sent, so only it leaves the dirty sets;
          // another unsaved translation keeps its bar.
          h.showInfoBox?.(stringsRef.current.copied || "Copied", "success");
          if (sameView) h.settleCopiedResource(copied.resourceId);
          if (h.revalidator && h.revalidator.state === "idle") h.revalidator.revalidate();
        }
      } finally {
        endSubResourceSpinner(itemId, fieldId);
      }
    })();
  }, [selectedItem, currentLanguage, selectedMarketId, handleOptionNameChange, handleOptionValueChange, touchOverlay, answerHandlersRef, currentViewRef, stringsRef]);

  const copyOptionFieldToAllLocales = useCallback((optionId: string, fieldType: "name" | "value", valueIndex?: number) => {
    // Copies the CACHED primary text, so the same rule as translating holds.
    if (!selectedItem || optionTranslationBlockedIds.has(optionId)) return;
    const option = selectedItem.options?.find(o => o.id === optionId);
    if (!option) return;

    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) return;

    let primaryValue: string;
    let resourceId: string;
    let resourceType: string;
    const fieldId = fieldType === "name" ? `${optionId}:name` : `${optionId}:value:${valueIndex}`;

    if (fieldType === "name") {
      if (!option.name) return;
      primaryValue = option.name;
      resourceId = option.id;
      resourceType = "ProductOption";
    } else {
      const val = option.values[valueIndex!];
      if (!val?.id || !val.name) return;
      primaryValue = val.name;
      resourceId = val.id;
      resourceType = "ProductOptionValue";
    }

    const translationsData = JSON.stringify({ [resourceId]: { name: primaryValue } });
    const resourceTypes = JSON.stringify({ [resourceId]: resourceType });
    const capturedItemId = selectedItem.id;

    // Write to overlay immediately for all target locales
    for (const locale of targetLocales) {
      const overlay = localSubResourceOverlayRef.current;
      if (!overlay[locale]) overlay[locale] = {};
      if (!overlay[locale][resourceId]) overlay[locale][resourceId] = {};
      overlay[locale][resourceId]["name"] = primaryValue;
      stampStaged(locale, [resourceId]);
    }
    touchOverlay();

    beginSubResourceSpinner(capturedItemId, fieldId, "copyToAllLocales");

    // The answer is READ: a locale whose save was refused (or only partly
    // applied) is named, and the overlay value written up front is taken back
    // for it, instead of the copy being reported as done.
    void runPerLocaleSavesDetailed(targetLocales, (locale) => {
      const fd = new FormData();
      fd.set("action", "saveSubResourceTranslations");
      fd.set("locale", locale);
      fd.set("translationsData", translationsData);
      fd.set("resourceTypes", resourceTypes);
      fd.set("itemId", capturedItemId);
      return postJsonSave(SUB_RESOURCE_ENDPOINT, setContentEditorPage(fd, "/app/products"));
    }).then(({ failed, gated }) => {
      rollbackSubResourceCopy(localSubResourceOverlayRef.current, failed, [{ resourceId, value: primaryValue }]);
      pruneOverlayStamps(overlayStampsRef.current, localSubResourceOverlayRef.current);
      touchOverlay();
      const outcome = copyOutcomeMessage(failed, { copied: strings.copied, copyFailedLocales: strings.copyFailedLocales, upgradeRequired: strings.upgradeRequired }, gated);
      showInfoBox?.(outcome.text, outcome.tone);
    }).finally(() => {
      endSubResourceSpinner(capturedItemId, fieldId);
      if (revalidator && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    });
  }, [selectedItem, primaryLocale, enabledLanguages, revalidator, optionTranslationBlockedIds, showInfoBox, strings.copied, strings.copyFailedLocales, strings.upgradeRequired]);

  const copyOptionToAllLocales = useCallback((optionId: string) => {
    // Copies the CACHED primary text, so the same rule as translating holds.
    if (!selectedItem || optionTranslationBlockedIds.has(optionId)) return;
    const option = selectedItem.options?.find(o => o.id === optionId);
    if (!option) return;

    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) return;

    // The same rows `buildSourceData` would translate: the name, and the
    // values only where they belong to the product (a linked option's values
    // live in the metaobjects). Empty text is skipped — copying "" would
    // register an empty translation rather than leave the field to fall back.
    const entries: Array<{ resourceId: string; resourceType: string; value: string }> = [];
    if (option.name) entries.push({ resourceId: option.id, resourceType: "ProductOption", value: option.name });
    if (!option.isLinked) {
      for (const val of option.values) {
        if (val.id && val.name) entries.push({ resourceId: val.id, resourceType: "ProductOptionValue", value: val.name });
      }
    }
    if (entries.length === 0) return;

    const translationsData = JSON.stringify(
      Object.fromEntries(entries.map((e) => [e.resourceId, { name: e.value }])),
    );
    const resourceTypes = JSON.stringify(
      Object.fromEntries(entries.map((e) => [e.resourceId, e.resourceType])),
    );
    const capturedItemId = selectedItem.id;
    const fieldId = `${optionId}:copyAll`;

    // Write to overlay immediately for all target locales
    for (const locale of targetLocales) {
      const overlay = localSubResourceOverlayRef.current;
      if (!overlay[locale]) overlay[locale] = {};
      for (const e of entries) {
        if (!overlay[locale][e.resourceId]) overlay[locale][e.resourceId] = {};
        overlay[locale][e.resourceId]["name"] = e.value;
      }
      stampStaged(locale, entries.map((e) => e.resourceId));
    }
    touchOverlay();

    beginSubResourceSpinner(capturedItemId, fieldId, "copyToAllLocales");

    // The answer is READ: a locale whose save was refused (or only partly
    // applied) is named, and the overlay value written up front is taken back
    // for it, instead of the copy being reported as done.
    void runPerLocaleSavesDetailed(targetLocales, (locale) => {
      const fd = new FormData();
      fd.set("action", "saveSubResourceTranslations");
      fd.set("locale", locale);
      fd.set("translationsData", translationsData);
      fd.set("resourceTypes", resourceTypes);
      fd.set("itemId", capturedItemId);
      return postJsonSave(SUB_RESOURCE_ENDPOINT, setContentEditorPage(fd, "/app/products"));
    }).then(({ failed, gated }) => {
      rollbackSubResourceCopy(localSubResourceOverlayRef.current, failed, entries);
      pruneOverlayStamps(overlayStampsRef.current, localSubResourceOverlayRef.current);
      touchOverlay();
      const outcome = copyOutcomeMessage(failed, { copied: strings.copied, copyFailedLocales: strings.copyFailedLocales, upgradeRequired: strings.upgradeRequired }, gated);
      showInfoBox?.(outcome.text, outcome.tone);
    }).finally(() => {
      endSubResourceSpinner(capturedItemId, fieldId);
      if (revalidator && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    });
  }, [selectedItem, primaryLocale, enabledLanguages, revalidator, optionTranslationBlockedIds, showInfoBox, strings.copied, strings.copyFailedLocales, strings.upgradeRequired]);

  return {
    state: {
      optionTranslations,
      metafieldTranslations,
      primaryOptionEdits,
      optionValuesToAdd,
      optionLinkedValuesToAdd,
      optionValuesToDelete,
      optionsToCreate,
      optionsToDelete,
      optionValueOrder,
      savedNonce,
      optionTranslationBlockedIds,
      primaryMetafieldEdits,
      translatingFieldIds,
      fallbackResourceIds,
      hasChanges,
      localOverlay: localSubResourceOverlayRef.current,
      overlayVersion,
      isLoading,
      isSaving: fetcher.state !== "idle",
    },
    handlers: {
      handleOptionNameChange,
      handleOptionValueChange,
      handleMetafieldChange,
      handlePrimaryOptionNameChange,
      handlePrimaryOptionValuesChange,
      handleAddOptionValue,
      handleAddLinkedOptionValue,
      handleRemoveLinkedOptionValue,
      handleRemoveOptionValue,
      handleEditPendingValue,
      handleCreateOption,
      handleCancelCreateOption,
      handleDeleteOption,
      handleReorderOptions,
      handleReorderOptionValues,
      handlePrimaryMetafieldChange,
      translateOption,
      translateOptionField,
      copyOptionField,
      copyOptionFieldToAllLocales,
      copyOptionToAllLocales,
      translateMetafield,
      translateAllSubResources,
      translateAllSubResourcesToAllLocales,
      saveSubResources,
      clearAllForLocale,
      isTranslateAllRunning,
      isSaveInFlight,
      resetChanges,
      resetForReload,
      refreshTranslations,
    },
  };
}
