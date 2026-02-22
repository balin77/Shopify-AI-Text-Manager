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
  /** Primary locale option edits keyed by option GID → { name, values[] } */
  primaryOptionEdits: Record<string, { name: string; values: string[] }>;
  /** Primary locale metafield edits keyed by metafield GID → value */
  primaryMetafieldEdits: Record<string, string>;
  /** Set of field IDs currently being translated (e.g. "optId:name", "optId:value:0") */
  translatingFieldIds: Set<string>;
  /** Whether there are unsaved changes */
  hasChanges: boolean;
  /** Whether translations are loading from Shopify */
  isLoading: boolean;
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
  translateMetafield: (metafieldId: string) => void;
  translateAllSubResources: () => void;
  saveSubResources: () => void;
  resetChanges: () => void;
  resetForReload: () => void;
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
  // Translation state (for foreign locales)
  const [optionTranslations, setOptionTranslations] = useState<Record<string, OptionTranslation>>({});
  const [metafieldTranslations, setMetafieldTranslations] = useState<Record<string, string>>({});

  // Primary locale editing state
  const [primaryOptionEdits, setPrimaryOptionEdits] = useState<Record<string, { name: string; values: string[] }>>({});
  const [primaryMetafieldEdits, setPrimaryMetafieldEdits] = useState<Record<string, string>>({});

  // Shared state
  const [translatingFieldIds, setTranslatingFieldIds] = useState<Set<string>>(new Set());
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
    setTranslatingFieldIds(new Set());

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

    setOptionTranslations(dbOpts);
    setMetafieldTranslations(dbMfs);

    // Phase 2: Only fetch from Shopify if Phase 1 found NO data for this locale.
    // After syncProduct saves sub-resource translations to DB, Phase 1 has
    // everything and this becomes unnecessary.
    const hasAnyDbData = Object.keys(dbMap).length > 0;

    if (!hasAnyDbData) {
      setIsLoading(true);
      fetcher.submit(
        {
          action: "loadSubResourceTranslations",
          locale: currentLanguage,
          resourceIds: JSON.stringify(subResourceIds),
          itemId,
        },
        { method: "POST", action: "/app/products" }
      );
    } else {
      setIsLoading(false);
    }
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

    if (data.actionType === "translateSubResources" || data.actionType === "translateSubResourceToAllLocales") {
      // Remove the field IDs that were just translated from the translating set
      const fieldId = data.fieldId as string | undefined;
      if (fieldId) {
        setTranslatingFieldIds(prev => {
          const newSet = new Set(prev);
          newSet.delete(fieldId);
          return newSet;
        });
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
      setHasChanges(false);
    }

    if (data.actionType === "savePrimarySubResources") {
      setHasChanges(false);
      // Clear primary edits after successful save
      setPrimaryOptionEdits({});
      setPrimaryMetafieldEdits({});
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

  const translateOption = useCallback((optionId: string) => {
    const sourceData = buildSourceData(optionId);
    if (sourceData.length === 0) return;

    const fieldId = `${optionId}:entire`;

    // Add this field to the translating set
    setTranslatingFieldIds(prev => new Set(prev).add(fieldId));

    // If primary locale, translate to all foreign locales
    if (isPrimaryLocale) {
      fetcher.submit(
        {
          action: "translateSubResourceToAllLocales",
          sourceData: JSON.stringify(sourceData),
          itemId: selectedItem?.id || "",
          primaryLocale,
          fieldId, // Send fieldId so server can echo it back
        },
        { method: "POST", action: "/app/products" }
      );
    } else {
      // Foreign locale: translate from primary to this locale only
      fetcher.submit(
        {
          action: "translateSubResources",
          targetLocale: currentLanguage,
          primaryLocale,
          sourceData: JSON.stringify(sourceData),
          itemId: selectedItem?.id || "",
          fieldId, // Send fieldId so server can echo it back
        },
        { method: "POST", action: "/app/products" }
      );
    }
  }, [isPrimaryLocale, buildSourceData, currentLanguage, primaryLocale, fetcher, selectedItem?.id]);

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

    // Add this field to the translating set
    setTranslatingFieldIds(prev => new Set(prev).add(fieldId));

    // If primary locale, translate to all foreign locales
    if (isPrimaryLocale) {
      fetcher.submit(
        {
          action: "translateSubResourceToAllLocales",
          sourceData: JSON.stringify(sourceData),
          itemId: selectedItem.id,
          primaryLocale,
          fieldId, // Send fieldId so server can echo it back
        },
        { method: "POST", action: "/app/products" }
      );
    } else {
      // Foreign locale: translate from primary to this locale only
      fetcher.submit(
        {
          action: "translateSubResources",
          targetLocale: currentLanguage,
          primaryLocale,
          sourceData: JSON.stringify(sourceData),
          itemId: selectedItem.id,
          fieldId, // Send fieldId so server can echo it back
        },
        { method: "POST", action: "/app/products" }
      );
    }
  }, [isPrimaryLocale, selectedItem, currentLanguage, primaryLocale, fetcher]);

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

    // Add this field to the translating set
    setTranslatingFieldIds(prev => new Set(prev).add(fieldId));

    fetcher.submit(
      {
        action: "translateSubResources",
        targetLocale: currentLanguage,
        primaryLocale,
        sourceData: JSON.stringify(sourceData),
        itemId: selectedItem.id,
        fieldId, // Send fieldId so server can echo it back
      },
      { method: "POST", action: "/app/products" }
    );
  }, [isPrimaryLocale, selectedItem, currentLanguage, primaryLocale, fetcher]);

  const translateAllSubResources = useCallback(() => {
    if (isPrimaryLocale) return;

    const sourceData = buildSourceData();
    if (sourceData.length === 0) return;

    const fieldId = "all:subresources";

    // Add this to the translating set
    setTranslatingFieldIds(prev => new Set(prev).add(fieldId));

    fetcher.submit(
      {
        action: "translateSubResources",
        targetLocale: currentLanguage,
        primaryLocale,
        sourceData: JSON.stringify(sourceData),
        itemId: selectedItem?.id || "",
        fieldId, // Send fieldId so server can echo it back
      },
      { method: "POST", action: "/app/products" }
    );
  }, [isPrimaryLocale, buildSourceData, currentLanguage, primaryLocale, fetcher, selectedItem?.id]);

  // Unified save handler - automatically detects primary vs foreign locale
  const saveSubResources = useCallback(() => {
    console.log("[saveSubResources] Called", { hasChanges, isPrimaryLocale, selectedItemId: selectedItem?.id });

    if (!hasChanges || !selectedItem) {
      console.log("[saveSubResources] Exiting early:", { hasChanges, hasSelectedItem: !!selectedItem });
      return;
    }

    if (isPrimaryLocale) {
      // PRIMARY LOCALE: Save primary values (options + metafields)
      const optionsChanges: Record<string, { name?: string; values?: string[] }> = {};
      const metafieldChanges: Record<string, string> = {};

      console.log("[saveSubResources] Primary locale - checking edits", {
        primaryOptionEdits,
        primaryMetafieldEdits
      });

      // Collect option name and value changes with validation
      for (const [optionId, edit] of Object.entries(primaryOptionEdits)) {
        const originalOption = selectedItem.options?.find(o => o.id === optionId);
        if (!originalOption) {
          console.log("[saveSubResources] Option not found:", optionId);
          continue;
        }

        const hasNameChange = edit.name !== undefined && edit.name !== originalOption.name;
        const hasValuesChange =
          edit.values !== undefined &&
          JSON.stringify(edit.values) !== JSON.stringify(originalOption.values.map(v => v.name));

        console.log("[saveSubResources] Checking option:", {
          optionId,
          editName: edit.name,
          originalName: originalOption.name,
          editValues: edit.values,
          originalValues: originalOption.values.map(v => v.name),
          hasNameChange,
          hasValuesChange
        });

        if (hasNameChange || hasValuesChange) {
          // VALIDATION: Prevent empty option names and values
          if (hasNameChange && edit.name.trim() === "") {
            alert("Option name cannot be empty");
            return;
          }
          if (hasValuesChange && edit.values.some(v => v.trim() === "")) {
            alert("Option values cannot be empty");
            return;
          }

          optionsChanges[optionId] = {};
          if (hasNameChange) optionsChanges[optionId].name = edit.name;
          // For metaobject-linked options, only save name changes (not values)
          if (hasValuesChange && !originalOption.isLinked) {
            optionsChanges[optionId].values = edit.values;
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
            alert("Metafield values cannot be empty");
            return;
          }
          metafieldChanges[metafieldId] = editValue;
        }
      }

      console.log("[saveSubResources] Collected changes:", { optionsChanges, metafieldChanges });

      if (Object.keys(optionsChanges).length === 0 && Object.keys(metafieldChanges).length === 0) {
        console.log("[saveSubResources] No changes detected, resetting hasChanges");
        setHasChanges(false);
        return;
      }

      console.log("[saveSubResources] Submitting to server...");

      // Create FormData to submit
      const formData = new FormData();
      formData.append("action", "savePrimarySubResources");
      formData.append("productId", selectedItem.id);
      formData.append("optionsChanges", JSON.stringify(optionsChanges));
      formData.append("metafieldChanges", JSON.stringify(metafieldChanges));

      console.log("[saveSubResources] FormData contents:");
      for (const [key, value] of formData.entries()) {
        console.log(`  ${key}:`, value);
      }

      console.log("[saveSubResources] Submitting to /app/products");
      fetcher.submit(formData, { method: "POST", action: "/app/products" });
    } else {
      // FOREIGN LOCALE: Save translations
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
        { method: "POST", action: "/app/products" }
      );
    }
  }, [hasChanges, isPrimaryLocale, selectedItem, primaryOptionEdits, primaryMetafieldEdits, optionTranslations, metafieldTranslations, currentLanguage, fetcher]);

  const resetChanges = useCallback(() => {
    loadedForRef.current = "";
    setHasChanges(false);
  }, []);

  /** Force re-load on next render (called after revalidation delivers fresh DB data) */
  const resetForReload = useCallback(() => {
    loadedForRef.current = "";
  }, []);

  return {
    state: {
      optionTranslations,
      metafieldTranslations,
      primaryOptionEdits,
      primaryMetafieldEdits,
      translatingFieldIds,
      hasChanges,
      isLoading,
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
      translateMetafield,
      translateAllSubResources,
      saveSubResources,
      resetChanges,
      resetForReload,
    },
  };
}
