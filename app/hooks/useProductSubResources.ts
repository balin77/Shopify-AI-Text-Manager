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
  revalidator?: { revalidate: () => void; state: string };
  showInfoBox?: (message: string, tone?: "success" | "info" | "warning" | "critical", title?: string) => void;
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
  revalidator,
  showInfoBox,
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
  // Track the last processed fetcher response to avoid re-processing
  const lastProcessedDataRef = useRef<any>(null);

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
      }
      setHasChanges(false);
    }

    if (data.actionType === "translateSubResources" || data.actionType === "translateSubResourceToAllLocales") {
      // Remove the field IDs that were just translated from the translating set
      const fieldId = data.fieldId as string | undefined;
      if (fieldId) {
        setTranslatingFieldIds(prev => {
          const newSet = new Set(prev);

          // If this was a "translate all" operation, clear ALL sub-resource fieldIds
          if (fieldId === "all:subresources") {
            // Remove all granular fieldIds that were added for this operation
            for (const id of newSet) {
              if (id.includes(":name") || id.includes(":value") || id === "all:subresources") {
                newSet.delete(id);
              }
            }
          } else {
            // Single field translation - just remove this fieldId
            newSet.delete(fieldId);
          }

          return newSet;
        });
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
      const failedResources = data.failedResources || [];

      if (failedResources.length > 0) {
        // Some resources failed - show error and restore original values for failed resources
        if (showInfoBox) {
          showInfoBox(
            `Failed to save ${failedResources.length} option(s). Changes have been reverted to original values.`,
            "critical",
            "Save Failed"
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
                const dbMap = dbPreloadToMap(selectedItem.subResourceTranslations, currentLanguage);
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
                  const dbMap = dbPreloadToMap(selectedItem.subResourceTranslations, currentLanguage);
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
                const dbMap = dbPreloadToMap(selectedItem.subResourceTranslations, currentLanguage);
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
          showInfoBox("Options and metafields saved successfully", "success", "Success");
        }
        setHasChanges(false);
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
            `Failed to save ${totalFailed} item(s). Changes have been reverted to original values.`,
            "critical",
            "Save Failed"
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
          showInfoBox("Options and metafields saved successfully", "success", "Success");
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

    // Add all fieldIds to the translating set
    setTranslatingFieldIds(prev => new Set([...prev, ...fieldIds]));

    fetcher.submit(
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
  }, [isPrimaryLocale, buildSourceData, currentLanguage, primaryLocale, fetcher, selectedItem]);

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
              showInfoBox("Option name cannot be empty", "critical", "Validation Error");
            } else {
              alert("Option name cannot be empty");
            }
            return;
          }
          if (hasValuesChange && edit.values.some(v => v.trim() === "")) {
            if (showInfoBox) {
              showInfoBox("Option values cannot be empty", "critical", "Validation Error");
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
              showInfoBox("Metafield values cannot be empty", "critical", "Validation Error");
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
        // Allow empty strings in foreign languages (user explicitly cleared the field)
        if (trans?.name !== undefined) {
          translationsData[opt.id] = { name: trans.name };
          resourceTypes[opt.id] = "ProductOption";
        }
        if (!opt.isLinked) {
          for (let i = 0; i < opt.values.length; i++) {
            const val = opt.values[i];
            // Allow empty strings in foreign languages (user explicitly cleared the field)
            if (val.id && trans?.values[i] !== undefined) {
              translationsData[val.id] = { name: trans.values[i] };
              resourceTypes[val.id] = "ProductOptionValue";
            }
          }
        }
      }

      for (const mf of selectedItem.metafields || []) {
        const trans = metafieldTranslations[mf.id];
        // Allow empty strings in foreign languages (user explicitly cleared the field)
        if (trans !== undefined) {
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
    // Reset foreign locale translations
    setOptionTranslations({});
    setMetafieldTranslations({});

    // Reset primary locale edits
    setPrimaryOptionEdits({});
    setPrimaryMetafieldEdits({});

    // Reset flags
    setHasChanges(false);
    setTranslatingFieldIds(new Set());

    // Force reload from DB/Shopify on next render
    loadedForRef.current = "";
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
