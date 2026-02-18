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
import type { FetcherWithComponents } from "@remix-run/react";
import type { OptionTranslation } from "../components/unified/OptionsField";
import type { TranslatableContentItem } from "../types/content-editor.types";

export interface SubResourceState {
  /** Option translations keyed by option GID → { name, values[] } */
  optionTranslations: Record<string, OptionTranslation>;
  /** Metafield translations keyed by metafield GID → translated value */
  metafieldTranslations: Record<string, string>;
  /** Whether any AI translation is in progress */
  isTranslating: boolean;
  /** Which option is currently being translated */
  translatingOptionId?: string;
  /** Which metafield is currently being translated */
  translatingMetafieldId?: string;
  /** Whether there are unsaved changes */
  hasChanges: boolean;
  /** Whether translations are loading from Shopify */
  isLoading: boolean;
}

export interface SubResourceHandlers {
  handleOptionNameChange: (optionId: string, value: string) => void;
  handleOptionValueChange: (optionId: string, valueIndex: number, value: string) => void;
  handleMetafieldChange: (metafieldId: string, value: string) => void;
  translateOption: (optionId: string) => void;
  translateMetafield: (metafieldId: string) => void;
  translateAllSubResources: () => void;
  saveSubResourceTranslations: () => void;
  resetChanges: () => void;
}

interface UseProductSubResourcesProps {
  selectedItem: TranslatableContentItem | null;
  currentLanguage: string;
  primaryLocale: string;
  fetcher: FetcherWithComponents<any>;
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
 * Convert DB pre-loaded subResourceTranslations (array format per resource)
 * into the flat map format { resourceId: { key: value } } for the given locale.
 */
function dbPreloadToMap(
  subResourceTranslations: Record<string, Array<{ key: string; value: string; locale: string }>> | undefined,
  locale: string,
): Record<string, Record<string, string>> {
  const map: Record<string, Record<string, string>> = {};
  if (!subResourceTranslations) return map;

  for (const [resourceId, records] of Object.entries(subResourceTranslations)) {
    for (const r of records) {
      if (r.locale === locale) {
        if (!map[resourceId]) map[resourceId] = {};
        map[resourceId][r.key] = r.value;
      }
    }
  }
  return map;
}

export function useProductSubResources({
  selectedItem,
  currentLanguage,
  primaryLocale,
  fetcher,
}: UseProductSubResourcesProps): { state: SubResourceState; handlers: SubResourceHandlers } {
  const [optionTranslations, setOptionTranslations] = useState<Record<string, OptionTranslation>>({});
  const [metafieldTranslations, setMetafieldTranslations] = useState<Record<string, string>>({});
  const [isTranslating, setIsTranslating] = useState(false);
  const [translatingOptionId, setTranslatingOptionId] = useState<string | undefined>();
  const [translatingMetafieldId, setTranslatingMetafieldId] = useState<string | undefined>();
  const [hasChanges, setHasChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Track which item+locale combo we've loaded for
  const loadedForRef = useRef<string>("");

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
    const loadKey = `${itemId}::${currentLanguage}`;
    if (loadedForRef.current === loadKey) return;

    // Reset state
    setHasChanges(false);
    setIsTranslating(false);
    setTranslatingOptionId(undefined);
    setTranslatingMetafieldId(undefined);

    loadedForRef.current = loadKey;

    if (!itemId || isPrimaryLocale || subResourceIds.length === 0) {
      setOptionTranslations({});
      setMetafieldTranslations({});
      setIsLoading(false);
      return;
    }

    // Phase 1: DB pre-load — read from item.subResourceTranslations (instant, synchronous)
    const dbMap = dbPreloadToMap(selectedItem?.subResourceTranslations, currentLanguage);
    const { optionTranslations: dbOpts, metafieldTranslations: dbMfs } =
      buildFromTranslationsMap(selectedItem, dbMap);

    console.log(`[SUB-RESOURCE] Phase 1 (DB): item=${itemId}, locale=${currentLanguage}, dbKeys=${Object.keys(dbMap).length}`);
    setOptionTranslations(dbOpts);
    setMetafieldTranslations(dbMfs);

    // Phase 2: Shopify fetch — load from Shopify for any missing translations
    setIsLoading(true);
    console.log(`[SUB-RESOURCE] Phase 2 (Shopify): fetching ${subResourceIds.length} sub-resource IDs`);
    fetcher.submit(
      {
        action: "loadSubResourceTranslations",
        locale: currentLanguage,
        resourceIds: JSON.stringify(subResourceIds),
        itemId,
      },
      { method: "POST" }
    );
  }, [itemId, currentLanguage, isPrimaryLocale, subResourceIds, selectedItem, fetcher]);

  // ============================================================================
  // Handle fetcher responses (load + translate + save)
  // ============================================================================
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    const data = fetcher.data as any;
    if (!data.success) {
      if (data.actionType === "loadSubResourceTranslations") setIsLoading(false);
      return;
    }

    // Phase 2 complete: merge Shopify data into state
    if (data.actionType === "loadSubResourceTranslations") {
      setIsLoading(false);
      const translations = data.translations as Record<string, Record<string, string>>;
      console.log(`[SUB-RESOURCE] Phase 2 response: ${Object.keys(translations).length} resources with translations`);

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
      }
      setHasChanges(false);
    }

    if (data.actionType === "translateSubResources") {
      setIsTranslating(false);
      setTranslatingOptionId(undefined);
      setTranslatingMetafieldId(undefined);

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

      setHasChanges(true);
    }

    if (data.actionType === "saveSubResourceTranslations") {
      setHasChanges(false);
    }
  }, [fetcher.state, fetcher.data, selectedItem]);

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleOptionNameChange = useCallback((optionId: string, value: string) => {
    setOptionTranslations(prev => ({
      ...prev,
      [optionId]: { ...prev[optionId], name: value, values: prev[optionId]?.values || [] },
    }));
    setHasChanges(true);
  }, []);

  const handleOptionValueChange = useCallback((optionId: string, valueIndex: number, value: string) => {
    setOptionTranslations(prev => {
      const existing = prev[optionId] || { name: "", values: [] };
      const newValues = [...existing.values];
      newValues[valueIndex] = value;
      return { ...prev, [optionId]: { ...existing, values: newValues } };
    });
    setHasChanges(true);
  }, []);

  const handleMetafieldChange = useCallback((metafieldId: string, value: string) => {
    setMetafieldTranslations(prev => ({ ...prev, [metafieldId]: value }));
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

  const translateOption = useCallback((optionId: string) => {
    if (isPrimaryLocale || isTranslating) return;

    const sourceData = buildSourceData(optionId);
    if (sourceData.length === 0) return;

    setIsTranslating(true);
    setTranslatingOptionId(optionId);

    fetcher.submit(
      {
        action: "translateSubResources",
        targetLocale: currentLanguage,
        primaryLocale,
        sourceData: JSON.stringify(sourceData),
        itemId: selectedItem?.id || "",
      },
      { method: "POST" }
    );
  }, [isPrimaryLocale, isTranslating, buildSourceData, currentLanguage, primaryLocale, fetcher, selectedItem?.id]);

  const translateMetafield = useCallback((metafieldId: string) => {
    if (isPrimaryLocale || isTranslating || !selectedItem) return;

    const mf = selectedItem.metafields?.find(m => m.id === metafieldId);
    if (!mf) return;

    const sourceData = [{
      resourceId: mf.id,
      resourceType: "Metafield",
      key: "value",
      value: mf.value,
      label: `${mf.namespace}.${mf.key}`,
    }];

    setIsTranslating(true);
    setTranslatingMetafieldId(metafieldId);

    fetcher.submit(
      {
        action: "translateSubResources",
        targetLocale: currentLanguage,
        primaryLocale,
        sourceData: JSON.stringify(sourceData),
        itemId: selectedItem.id,
      },
      { method: "POST" }
    );
  }, [isPrimaryLocale, isTranslating, selectedItem, currentLanguage, primaryLocale, fetcher]);

  const translateAllSubResources = useCallback(() => {
    if (isPrimaryLocale || isTranslating) return;

    const sourceData = buildSourceData();
    if (sourceData.length === 0) return;

    setIsTranslating(true);

    fetcher.submit(
      {
        action: "translateSubResources",
        targetLocale: currentLanguage,
        primaryLocale,
        sourceData: JSON.stringify(sourceData),
        itemId: selectedItem?.id || "",
      },
      { method: "POST" }
    );
  }, [isPrimaryLocale, isTranslating, buildSourceData, currentLanguage, primaryLocale, fetcher, selectedItem?.id]);

  const saveSubResourceTranslations = useCallback(() => {
    if (!hasChanges || isPrimaryLocale || !selectedItem) return;

    const translationsData: Record<string, Record<string, string>> = {};
    const resourceTypes: Record<string, string> = {};

    for (const opt of selectedItem.options || []) {
      const trans = optionTranslations[opt.id];
      if (trans?.name) {
        translationsData[opt.id] = { name: trans.name };
        resourceTypes[opt.id] = "ProductOption";
      }
      if (!opt.isLinked) {
        for (let i = 0; i < opt.values.length; i++) {
          const val = opt.values[i];
          if (val.id && trans?.values[i]) {
            translationsData[val.id] = { name: trans.values[i] };
            resourceTypes[val.id] = "ProductOptionValue";
          }
        }
      }
    }

    for (const mf of selectedItem.metafields || []) {
      const trans = metafieldTranslations[mf.id];
      if (trans) {
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
      },
      { method: "POST" }
    );
  }, [hasChanges, isPrimaryLocale, selectedItem, optionTranslations, metafieldTranslations, currentLanguage, fetcher]);

  const resetChanges = useCallback(() => {
    loadedForRef.current = "";
    setHasChanges(false);
  }, []);

  return {
    state: {
      optionTranslations,
      metafieldTranslations,
      isTranslating,
      translatingOptionId,
      translatingMetafieldId,
      hasChanges,
      isLoading,
    },
    handlers: {
      handleOptionNameChange,
      handleOptionValueChange,
      handleMetafieldChange,
      translateOption,
      translateMetafield,
      translateAllSubResources,
      saveSubResourceTranslations,
      resetChanges,
    },
  };
}
