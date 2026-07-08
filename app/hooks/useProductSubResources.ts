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
import { useFetcher } from "@remix-run/react";
import type { FetcherWithComponents } from "@remix-run/react";
import {
  markSubResourceActive,
  markSubResourceCompleted,
  useTranslatingSubResourceIds,
} from "./useAIOperationsStore";
import type { OptionTranslation } from "../components/unified/OptionsField";
import type { TranslatableContentItem } from "../types/content-editor.types";
import { buildLocaleKey } from "./useUiDataLoader";

/** Response shape from sub-resource API actions */
interface SubResourceFetcherData {
  success: boolean;
  actionType?: string;
  translations?: Record<string, Record<string, string>>;
  fieldId?: string;
  failedResources?: string[];
  failedOptions?: string[];
  failedMetafields?: string[];
}

export interface SubResourceState {
  /** Option translations keyed by option GID → { name, values[] } */
  optionTranslations: Record<string, OptionTranslation>;
  /** Metafield translations keyed by metafield GID → translated value */
  metafieldTranslations: Record<string, string>;
  /** Primary locale option edits keyed by option GID → { name, values[] } */
  primaryOptionEdits: Record<string, { name: string; values: string[] }>;
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
  handlePrimaryMetafieldChange: (metafieldId: string, value: string) => void;
  translateOption: (optionId: string) => void;
  translateOptionField: (optionId: string, fieldType: "name" | "value", valueIndex?: number) => void;
  copyOptionField: (optionId: string, fieldType: "name" | "value", valueIndex?: number) => void;
  copyOptionFieldToAllLocales: (optionId: string, fieldType: "name" | "value", valueIndex?: number) => void;
  translateMetafield: (metafieldId: string) => void;
  translateAllSubResources: () => void;
  translateAllSubResourcesToAllLocales: () => void;
  saveSubResources: () => void;
  resetChanges: () => void;
  resetForReload: () => void;
}

interface UseProductSubResourcesStrings {
  optionsSavedSuccess?: string;
  saveFailed?: string;
  saveFailedOptions?: string;
  saveFailedItems?: string;
  validationError?: string;
  optionNameEmpty?: string;
  optionValuesEmpty?: string;
  metafieldValuesEmpty?: string;
  success?: string;
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
  showInfoBox?: (message: string, tone?: "success" | "info" | "warning" | "critical", title?: string) => void;
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
function dbPreloadToMap(
  subResourceTranslations: Record<string, Array<{ key: string; value: string; locale: string; marketId?: string }>> | undefined,
  locale: string,
  selectedMarketId: string,
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
      else if (selectedMarketId && rMarket === selectedMarketId) marketByKey[r.key] = r.value;
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

  // Shared state
  // translatingFieldIds is now derived from the global AI operations store
  // so spinners persist across item navigation.
  const translatingFieldIds = useTranslatingSubResourceIds(selectedItem?.id || "");
  const [hasChanges, setHasChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Own fetcher for load/save/individual-translate operations.
  // Must NOT be shared with the main editor to avoid race conditions
  // (main editor's safeSubmit queue vs. direct submit here).
  const fetcher = useFetcher<any>();

  // Separate fetcher for translate-all operations to avoid conflicting with
  // the load/save fetcher above.
  const translateAllFetcher = useFetcher<any>();
  const lastProcessedTranslateAllDataRef = useRef<any>(null);

  // Track which item+locale combo we've loaded for
  const loadedForRef = useRef<string>("");
  // Track the last processed fetcher response to avoid re-processing
  const lastProcessedDataRef = useRef<any>(null);
  // Track fieldId of an in-flight copy save so we can clear its spinner on response
  const pendingCopyFieldIdRef = useRef<string | null>(null);
  // Per-locale overlay for copy operations — eliminates stale window on locale switch
  // structure: { locale: { resourceId: { fieldKey: value } } }
  const localSubResourceOverlayRef = useRef<Record<string, Record<string, Record<string, string>>>>({});
  // Track item ID to clear overlay when switching items
  const lastOverlayItemIdRef = useRef<string | null>(null);

  const isPrimaryLocale = currentLanguage === primaryLocale;
  const itemId = selectedItem?.id;

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
    // Note: translatingFieldIds is now in the global AI operations store
    // and should NOT be cleared on item change — it's resource-specific.

    loadedForRef.current = loadKey;

    // Clear overlay when switching to a different item (data is item-specific)
    if (lastOverlayItemIdRef.current !== itemId) {
      lastOverlayItemIdRef.current = itemId || null;
      localSubResourceOverlayRef.current = {};
    }

    if (!itemId || isPrimaryLocale || subResourceIds.length === 0) {
      setOptionTranslations({});
      setMetafieldTranslations({});
      setFallbackResourceIds(new Set());
      setIsLoading(false);
      return;
    }

    // Phase 1: DB pre-load — read from item.subResourceTranslations (instant,
    // synchronous), resolving market → global and flagging inherited resources.
    const { map: dbMap, fallbackResourceIds: dbFallback } =
      dbPreloadToMap(selectedItem?.subResourceTranslations, currentLanguage, selectedMarketId);

    // Merge overlay (from copy operations) on top of DB data. Overlay is
    // market-folded so a market override doesn't leak into the global view.
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

    if (missingFromDb.length > 0) {
      setIsLoading(true);
      fetcher.submit(
        {
          action: "loadSubResourceTranslations",
          locale: currentLanguage,
          resourceIds: JSON.stringify(missingFromDb),
          itemId,
        },
        { method: "POST", action: "/app/products" }
      );
    } else {
      setIsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetcher is hook-internal and stable
  }, [itemId, currentLanguage, selectedMarketId, isPrimaryLocale, subResourceIds, selectedItem]);

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
      if (data.actionType === "loadSubResourceTranslations") setIsLoading(false);
      return;
    }

    // Phase 2 complete: merge Shopify data into state
    if (data.actionType === "loadSubResourceTranslations") {
      setIsLoading(false);
      const translations = data.translations as Record<string, Record<string, string>>;
      if (selectedItem) {
        const { optionTranslations: shopifyOpts, metafieldTranslations: shopifyMfs } =
          buildFromTranslationsMap(selectedItem, translations);

        // Merge: Shopify data overrides DB data (Shopify is fresher)
        setOptionTranslations(prev => {
          const merged = { ...prev };
          for (const [optId, trans] of Object.entries(shopifyOpts)) {
            if (trans.name || trans.values.some(v => v)) {
              merged[optId] = trans;
            }
          }
          return merged;
        });
        setMetafieldTranslations(prev => {
          const merged = { ...prev };
          for (const [mfId, value] of Object.entries(shopifyMfs)) {
            if (value) merged[mfId] = value;
          }
          return merged;
        });

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
      setHasChanges(false);
    }

    if (data.actionType === "translateSubResources" || data.actionType === "translateSubResourceToAllLocales") {
      // Remove the field IDs that were just translated from the global store
      const fieldId = data.fieldId as string | undefined;
      const resourceId = selectedItem?.id || "";
      if (fieldId && resourceId) {
        if (fieldId === "all:subresources") {
          // Clear all sub-resource fieldIds for this resource
          for (const id of translatingFieldIds) {
            markSubResourceCompleted(resourceId, id);
          }
          markSubResourceCompleted(resourceId, "all:subresources");
        } else {
          markSubResourceCompleted(resourceId, fieldId);
        }
      }

      const translations = data.translations as Record<string, Record<string, string>>;

      // For translateSubResourceToAllLocales from primary locale:
      // The server saves translations to DB but returns empty translations object.
      // Trigger revalidation to reload fresh data including updated subResourceTranslations,
      // which will update locale button pulsing state.
      if (data.actionType === "translateSubResourceToAllLocales" && revalidator && revalidator.state === "idle") {
        revalidator.revalidate();
      }

      if (selectedItem) {
        setOptionTranslations(prev => {
          const updated = { ...prev };
          for (const opt of selectedItem.options || []) {
            const optTrans = translations[opt.id];
            if (optTrans?.name) {
              if (!updated[opt.id]) updated[opt.id] = { name: "", values: [] };
              updated[opt.id] = { ...updated[opt.id], name: optTrans.name };
            }
            const valueTranslations = [...(updated[opt.id]?.values || [])];
            for (let i = 0; i < opt.values.length; i++) {
              const valTrans = translations[opt.values[i].id];
              if (valTrans?.name) {
                valueTranslations[i] = valTrans.name;
              }
            }
            if (updated[opt.id]) {
              updated[opt.id] = { ...updated[opt.id], values: valueTranslations };
            }
          }
          return updated;
        });

        setMetafieldTranslations(prev => {
          const updated = { ...prev };
          for (const mf of selectedItem.metafields || []) {
            const mfTrans = translations[mf.id];
            if (mfTrans?.value) {
              updated[mf.id] = mfTrans.value;
            }
          }
          return updated;
        });
      }

      // Both translateSubResources and translateSubResourceToAllLocales save to Shopify immediately
      // So we don't need to mark as changed - translations are already persisted
      setHasChanges(false);
    }

    if (data.actionType === "saveSubResourceTranslations") {
      // Clear copy loading state (markSubResourceActive was called in copyOptionField)
      const wasCopyOperation = !!pendingCopyFieldIdRef.current;
      if (pendingCopyFieldIdRef.current) {
        markSubResourceCompleted(selectedItem?.id || "", pendingCopyFieldIdRef.current);
        pendingCopyFieldIdRef.current = null;
      }

      const failedResources = data.failedResources || [];

      if (failedResources.length > 0) {
        // Some resources failed - show error and restore original values for failed resources
        if (showInfoBox) {
          showInfoBox(
            (strings.saveFailedOptions || "Failed to save {count} option(s). Changes have been reverted to original values.").replace("{count}", String(failedResources.length)),
            "critical",
            strings.saveFailed || "Save Failed"
          );
        }

        // Restore original values for failed resources from selectedItem
        if (selectedItem) {
          setOptionTranslations(prev => {
            const restored = { ...prev };

            for (const resourceId of failedResources) {
              // Check if this is an option
              const option = selectedItem.options?.find(o => o.id === resourceId);
              if (option) {
                // Restore original option name (empty string if no translation existed)
                const { map: dbMap } = dbPreloadToMap(selectedItem.subResourceTranslations, currentLanguage, selectedMarketId);
                const originalName = dbMap[resourceId]?.name || "";
                if (restored[resourceId]) {
                  restored[resourceId] = { ...restored[resourceId], name: originalName };
                } else {
                  restored[resourceId] = { name: originalName, values: [] };
                }
              }

              // Check if this is an option value
              for (const opt of selectedItem.options || []) {
                const valueIndex = opt.values.findIndex(v => v.id === resourceId);
                if (valueIndex !== -1) {
                  // Restore original value (empty string if no translation existed)
                  const { map: dbMap } = dbPreloadToMap(selectedItem.subResourceTranslations, currentLanguage, selectedMarketId);
                  const originalValue = dbMap[resourceId]?.name || "";
                  if (restored[opt.id]) {
                    const newValues = [...restored[opt.id].values];
                    newValues[valueIndex] = originalValue;
                    restored[opt.id] = { ...restored[opt.id], values: newValues };
                  }
                }
              }
            }

            return restored;
          });

          // Also restore metafield values if any failed
          setMetafieldTranslations(prev => {
            const restored = { ...prev };

            for (const resourceId of failedResources) {
              const metafield = selectedItem.metafields?.find(m => m.id === resourceId);
              if (metafield) {
                const { map: dbMap } = dbPreloadToMap(selectedItem.subResourceTranslations, currentLanguage, selectedMarketId);
                const originalValue = dbMap[resourceId]?.value || "";
                restored[resourceId] = originalValue;
              }
            }

            return restored;
          });
        }

        setHasChanges(false);
      } else {
        // All saved successfully
        if (showInfoBox) {
          showInfoBox(strings.optionsSavedSuccess || "Options and metafields saved successfully", "success", strings.success || "Success");
        }
        setHasChanges(false);
        setDirtyOptionIds(new Set());
        setDirtyOptionValueIds(new Set());
        setDirtyMetafieldIds(new Set());

        // Revalidate after copy so fresh DB data loads when user switches locale
        if (wasCopyOperation && revalidator && revalidator.state === "idle") {
          revalidator.revalidate();
        }
      }
    }

    if (data.actionType === "savePrimarySubResources") {
      const failedOptions = data.failedOptions || [];
      const failedMetafields = data.failedMetafields || [];
      const totalFailed = failedOptions.length + failedMetafields.length;

      if (totalFailed > 0) {
        // Some resources failed - show error and restore original values
        if (showInfoBox) {
          showInfoBox(
            (strings.saveFailedItems || "Failed to save {count} item(s). Changes have been reverted to original values.").replace("{count}", String(totalFailed)),
            "critical",
            strings.saveFailed || "Save Failed"
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

        setHasChanges(false);
      } else {
        // All saved successfully
        if (showInfoBox) {
          showInfoBox(strings.optionsSavedSuccess || "Options and metafields saved successfully", "success", strings.success || "Success");
        }
        setHasChanges(false);
        // Clear primary edits after successful save
        setPrimaryOptionEdits({});
        setPrimaryMetafieldEdits({});

        // Trigger revalidation to reload fresh data from DB/Shopify
        // This ensures new option value GIDs and updated values are loaded
        if (revalidator && revalidator.state === "idle") {
          revalidator.revalidate();
        }
      }
    }
  }, [fetcher.state, fetcher.data, selectedItem, selectedMarketId, currentLanguage]);

  // Handle translateAllFetcher responses (used by translateAllSubResources and translateAllSubResourcesToAllLocales)
  useEffect(() => {
    if (translateAllFetcher.state !== "idle" || !translateAllFetcher.data) return;
    const data = translateAllFetcher.data as SubResourceFetcherData;
    if (data === lastProcessedTranslateAllDataRef.current) return;
    lastProcessedTranslateAllDataRef.current = data;

    if (!data.success) return;

    if (data.actionType === "translateSubResources" || data.actionType === "translateSubResourceToAllLocales") {
      // Clear all sub-resource translating states from global store
      const resourceId = selectedItem?.id || "";
      if (resourceId) {
        for (const id of translatingFieldIds) {
          markSubResourceCompleted(resourceId, id);
        }
      }

      // For translateSubResourceToAllLocales, trigger revalidation to refresh locale pulsing state
      if (data.actionType === "translateSubResourceToAllLocales" && revalidator && revalidator.state === "idle") {
        revalidator.revalidate();
      }

      const translations = data.translations as Record<string, Record<string, string>>;
      if (selectedItem) {
        setOptionTranslations(prev => {
          const updated = { ...prev };
          for (const opt of selectedItem.options || []) {
            const optTrans = translations[opt.id];
            if (optTrans?.name) {
              if (!updated[opt.id]) updated[opt.id] = { name: "", values: [] };
              updated[opt.id] = { ...updated[opt.id], name: optTrans.name };
            }
            const valueTranslations = [...(updated[opt.id]?.values || [])];
            for (let i = 0; i < opt.values.length; i++) {
              const valTrans = translations[opt.values[i].id];
              if (valTrans?.name) valueTranslations[i] = valTrans.name;
            }
            if (updated[opt.id]) updated[opt.id] = { ...updated[opt.id], values: valueTranslations };
          }
          return updated;
        });
        setMetafieldTranslations(prev => {
          const updated = { ...prev };
          for (const mf of selectedItem.metafields || []) {
            const mfTrans = translations[mf.id];
            if (mfTrans?.value) updated[mf.id] = mfTrans.value;
          }
          return updated;
        });
      }
      setHasChanges(false);
    }
  }, [translateAllFetcher.state, translateAllFetcher.data, selectedItem, revalidator]);

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

  const buildSourceData = useCallback((filterOptionId?: string, filterMetafieldId?: string) => {
    if (!selectedItem) return [];

    const sourceData: Array<{ resourceId: string; resourceType: string; key: string; value: string; label: string }> = [];

    for (const opt of selectedItem.options || []) {
      if (filterOptionId && opt.id !== filterOptionId) continue;
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
  }, [selectedItem]);

  // Merge a translations map ({ resourceId: { key: value } }) into option/metafield state.
  const applyTranslationsToState = useCallback((
    item: TranslatableContentItem,
    translations: Record<string, Record<string, string>>,
  ) => {
    setOptionTranslations(prev => {
      const updated = { ...prev };
      for (const opt of item.options || []) {
        const optTrans = translations[opt.id];
        if (optTrans?.name) {
          if (!updated[opt.id]) updated[opt.id] = { name: "", values: [] };
          updated[opt.id] = { ...updated[opt.id], name: optTrans.name };
        }
        const valueTranslations = [...(updated[opt.id]?.values || [])];
        for (let i = 0; i < opt.values.length; i++) {
          const valTrans = translations[opt.values[i].id];
          if (valTrans?.name) valueTranslations[i] = valTrans.name;
        }
        if (updated[opt.id]) updated[opt.id] = { ...updated[opt.id], values: valueTranslations };
      }
      return updated;
    });
    setMetafieldTranslations(prev => {
      const updated = { ...prev };
      for (const mf of item.metafields || []) {
        const mfTrans = translations[mf.id];
        if (mfTrans?.value) updated[mf.id] = mfTrans.value;
      }
      return updated;
    });
  }, []);

  // Run a SINGLE field/option translate as its own request.
  //
  // These must NOT share the hook's `fetcher`: firing several at once (e.g. the
  // user translates a name + multiple values simultaneously) makes each
  // fetcher.submit() replace the previous in-flight request, so only the last
  // response reaches fetcher.data — every other field's spinner then hangs
  // forever. A dedicated fetch per call gives each its own lifecycle and clears
  // its own spinner in `finally`.
  const runIndividualTranslate = useCallback(async (
    fieldId: string,
    sourceData: Array<{ resourceId: string; resourceType: string; key: string; value: string; label: string }>,
  ) => {
    const item = selectedItem;
    if (!item) return;
    const resourceId = item.id;

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

    try {
      const resp = await fetch("/app/products", { method: "POST", body: fd });
      const data = await resp.json().catch(() => null) as SubResourceFetcherData | null;
      if (data?.success && data.translations) {
        applyTranslationsToState(item, data.translations as Record<string, Record<string, string>>);
      }
      // Primary-locale translate saves to foreign locales server-side and returns
      // no translations — revalidate so locale-pulsing state refreshes.
      if (isPrimaryLocale && revalidator && revalidator.state === "idle") {
        revalidator.revalidate();
      }
      setHasChanges(false);
    } catch {
      // Spinner is still cleared in finally; translation state simply isn't updated.
    } finally {
      markSubResourceCompleted(resourceId, fieldId);
    }
  }, [selectedItem, isPrimaryLocale, currentLanguage, primaryLocale, revalidator, applyTranslationsToState]);

  const translateOption = useCallback((optionId: string) => {
    const sourceData = buildSourceData(optionId);
    if (sourceData.length === 0) return;

    const fieldId = `${optionId}:entire`;

    // Mark in global store so spinner persists across item navigation
    markSubResourceActive(selectedItem?.id || "", fieldId, "translateSubResource");

    // Own request lifecycle (not the shared fetcher) so concurrent translates
    // each clear their own spinner. See runIndividualTranslate.
    void runIndividualTranslate(fieldId, sourceData);
  }, [buildSourceData, selectedItem?.id, runIndividualTranslate]);

  const translateOptionField = useCallback((optionId: string, fieldType: "name" | "value", valueIndex?: number) => {
    if (!selectedItem) return;

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

    // Mark in global store so spinner persists across item navigation
    markSubResourceActive(selectedItem?.id || "", fieldId, "translateSubResource");

    // Own request lifecycle (not the shared fetcher) so concurrent translates
    // each clear their own spinner. See runIndividualTranslate.
    void runIndividualTranslate(fieldId, sourceData);
  }, [selectedItem, runIndividualTranslate]);

  const translateMetafield = useCallback((metafieldId: string) => {
    if (isPrimaryLocale || !selectedItem) return;

    const mf = selectedItem.metafields?.find(m => m.id === metafieldId);
    if (!mf) return;

    const fieldId = `${metafieldId}:value`;
    const sourceData = [{
      resourceId: mf.id,
      resourceType: "Metafield",
      key: "value",
      value: mf.value,
      label: `${mf.namespace}.${mf.key}`,
    }];

    // Mark in global store so spinner persists across item navigation
    markSubResourceActive(selectedItem?.id || "", fieldId, "translateSubResource");

    // Own request lifecycle (not the shared fetcher) so concurrent translates
    // each clear their own spinner. See runIndividualTranslate.
    void runIndividualTranslate(fieldId, sourceData);
  }, [isPrimaryLocale, selectedItem, runIndividualTranslate]);

  const translateAllSubResources = useCallback(() => {
    if (isPrimaryLocale || !selectedItem) return;

    const sourceData = buildSourceData();
    if (sourceData.length === 0) return;

    // Build granular fieldIds for all fields being translated
    const fieldIds = new Set<string>();

    for (const opt of selectedItem.options || []) {
      fieldIds.add(`${opt.id}:name`);
      if (!opt.isLinked) {
        for (let i = 0; i < opt.values.length; i++) {
          const val = opt.values[i];
          if (val.id) {
            fieldIds.add(`${opt.id}:value:${i}`);
          }
        }
      }
    }

    for (const mf of selectedItem.metafields || []) {
      fieldIds.add(`${mf.id}:value`);
    }

    // Add global marker for overall operation
    fieldIds.add("all:subresources");

    // Mark all in global store so spinners persist across item navigation
    for (const fid of fieldIds) {
      markSubResourceActive(selectedItem.id, fid, "translateSubResource");
    }

    translateAllFetcher.submit(
      {
        action: "translateSubResources",
        targetLocale: currentLanguage,
        primaryLocale,
        sourceData: JSON.stringify(sourceData),
        itemId: selectedItem.id,
        fieldId: "all:subresources", // Send global fieldId so server can echo it back
      },
      { method: "POST", action: "/app/products" }
    );
  }, [isPrimaryLocale, buildSourceData, currentLanguage, primaryLocale, translateAllFetcher, selectedItem]);

  // Translate ALL sub-resources to ALL foreign locales (called from primary locale "Translate All")
  const translateAllSubResourcesToAllLocales = useCallback(() => {
    if (!isPrimaryLocale || !selectedItem) return;

    const sourceData = buildSourceData();
    if (sourceData.length === 0) return;

    // Mark all fields as translating
    const fieldIds = new Set<string>();
    for (const opt of selectedItem.options || []) {
      fieldIds.add(`${opt.id}:name`);
      if (!opt.isLinked) {
        for (let i = 0; i < opt.values.length; i++) {
          if (opt.values[i].id) fieldIds.add(`${opt.id}:value:${i}`);
        }
      }
    }
    for (const mf of selectedItem.metafields || []) {
      fieldIds.add(`${mf.id}:value`);
    }
    fieldIds.add("all:subresources");
    for (const fid of fieldIds) {
      markSubResourceActive(selectedItem.id, fid, "translateSubResourceToAllLocales");
    }

    translateAllFetcher.submit(
      {
        action: "translateSubResourceToAllLocales",
        sourceData: JSON.stringify(sourceData),
        itemId: selectedItem.id,
        primaryLocale,
        fieldId: "all:subresources",
      },
      { method: "POST", action: "/app/products" }
    );
  }, [isPrimaryLocale, buildSourceData, selectedItem, primaryLocale, translateAllFetcher]);

  // Unified save handler - automatically detects primary vs foreign locale
  const saveSubResources = useCallback(() => {
    if (!hasChanges || !selectedItem) {
      return;
    }

    if (isPrimaryLocale) {
      // PRIMARY LOCALE: Save primary values (options + metafields)
      const optionsChanges: Record<string, { name?: string; valueUpdates?: { id: string; name: string }[] }> = {};
      const metafieldChanges: Record<string, string> = {};

      // Collect option name and value changes with validation
      for (const [optionId, edit] of Object.entries(primaryOptionEdits)) {
        const originalOption = selectedItem.options?.find(o => o.id === optionId);
        if (!originalOption) {
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
              showInfoBox(strings.optionNameEmpty || "Option name cannot be empty", "critical", strings.validationError || "Validation Error");
            } else {
              alert("Option name cannot be empty");
            }
            return;
          }
          if (hasValuesChange && edit.values.some(v => v.trim() === "")) {
            if (showInfoBox) {
              showInfoBox(strings.optionValuesEmpty || "Option values cannot be empty", "critical", strings.validationError || "Validation Error");
            } else {
              alert("Option values cannot be empty");
            }
            return;
          }

          optionsChanges[optionId] = {};
          if (hasNameChange) optionsChanges[optionId].name = edit.name;
          // For metaobject-linked options, only save name changes (not values)
          if (hasValuesChange && !originalOption.isLinked) {
            // Only include values that actually changed
            optionsChanges[optionId].valueUpdates = originalOption.values
              .map((v, i) => ({ id: v.id, name: edit.values[i] }))
              .filter((v, i) => v.name !== originalOption.values[i].name);
          }
        }
      }

      // Collect metafield value changes with validation
      for (const [metafieldId, editValue] of Object.entries(primaryMetafieldEdits)) {
        const originalMetafield = selectedItem.metafields?.find(m => m.id === metafieldId);
        if (!originalMetafield) continue;

        if (editValue !== originalMetafield.value) {
          // VALIDATION: Prevent empty metafield values
          if (editValue.trim() === "") {
            if (showInfoBox) {
              showInfoBox(strings.metafieldValuesEmpty || "Metafield values cannot be empty", "critical", strings.validationError || "Validation Error");
            } else {
              alert("Metafield values cannot be empty");
            }
            return;
          }
          metafieldChanges[metafieldId] = editValue;
        }
      }

      if (Object.keys(optionsChanges).length === 0 && Object.keys(metafieldChanges).length === 0) {
        setHasChanges(false);
        return;
      }

      // Create FormData to submit
      const formData = new FormData();
      formData.append("action", "savePrimarySubResources");
      formData.append("productId", selectedItem.id);
      formData.append("optionsChanges", JSON.stringify(optionsChanges));
      formData.append("metafieldChanges", JSON.stringify(metafieldChanges));

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
  }, [hasChanges, isPrimaryLocale, selectedItem, primaryOptionEdits, primaryMetafieldEdits, optionTranslations, metafieldTranslations, currentLanguage, selectedMarketId, fetcher, dirtyOptionIds, dirtyOptionValueIds, dirtyMetafieldIds]);

  const resetChanges = useCallback(() => {
    // Reset foreign locale translations
    setOptionTranslations({});
    setMetafieldTranslations({});
    setDirtyOptionIds(new Set());
    setDirtyOptionValueIds(new Set());
    setDirtyMetafieldIds(new Set());

    // Reset primary locale edits
    setPrimaryOptionEdits({});
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
  }, []);

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
    for (const [resourceId, fields] of Object.entries(translationsData)) {
      if (!overlay[overlayKey][resourceId]) overlay[overlayKey][resourceId] = {};
      overlay[overlayKey][resourceId]["name"] = fields.name;
    }

    markSubResourceActive(selectedItem.id, fieldId, "copy");
    pendingCopyFieldIdRef.current = fieldId;

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
  }, [selectedItem, currentLanguage, selectedMarketId, fetcher, handleOptionNameChange, handleOptionValueChange]);

  const copyOptionFieldToAllLocales = useCallback((optionId: string, fieldType: "name" | "value", valueIndex?: number) => {
    if (!selectedItem) return;
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
    }

    markSubResourceActive(capturedItemId, fieldId, "copyToAllLocales");

    const saves = targetLocales.map(locale => {
      const fd = new FormData();
      fd.set("action", "saveSubResourceTranslations");
      fd.set("locale", locale);
      fd.set("translationsData", translationsData);
      fd.set("resourceTypes", resourceTypes);
      fd.set("itemId", capturedItemId);
      return fetch("/app/products", { method: "POST", body: fd });
    });

    Promise.all(saves).finally(() => {
      markSubResourceCompleted(capturedItemId, fieldId);
      if (revalidator && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    });
  }, [selectedItem, primaryLocale, enabledLanguages, revalidator]);

  return {
    state: {
      optionTranslations,
      metafieldTranslations,
      primaryOptionEdits,
      primaryMetafieldEdits,
      translatingFieldIds,
      fallbackResourceIds,
      hasChanges,
      isLoading,
      isSaving: fetcher.state !== "idle",
    },
    handlers: {
      handleOptionNameChange,
      handleOptionValueChange,
      handleMetafieldChange,
      handlePrimaryOptionNameChange,
      handlePrimaryOptionValuesChange,
      handlePrimaryMetafieldChange,
      translateOption,
      translateOptionField,
      copyOptionField,
      copyOptionFieldToAllLocales,
      translateMetafield,
      translateAllSubResources,
      translateAllSubResourcesToAllLocales,
      saveSubResources,
      resetChanges,
      resetForReload,
    },
  };
}
