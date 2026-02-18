/**
 * useProductSubResources - State management for product option & metafield translations
 *
 * Manages:
 * - Reading pre-loaded translations from item data (loaded via DB pipeline in loader)
 * - Tracking local edits
 * - Saving changes to Shopify + DB
 * - AI translation per sub-resource
 */

import { useState, useEffect, useCallback, useRef } from "react";
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
  /** Whether translations are loading */
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
 * Helper: Build option + metafield translation state from pre-loaded sub-resource translations.
 * Reads from `item.subResourceTranslations` which is loaded in the products loader
 * via the same ContentTranslation DB pipeline as main product translations.
 */
function buildTranslationsFromItem(
  item: TranslatableContentItem | null,
  locale: string,
): {
  optionTranslations: Record<string, OptionTranslation>;
  metafieldTranslations: Record<string, string>;
} {
  const optionTranslations: Record<string, OptionTranslation> = {};
  const metafieldTranslations: Record<string, string> = {};

  if (!item) return { optionTranslations, metafieldTranslations };

  const subTrans = item.subResourceTranslations || {};

  for (const opt of item.options || []) {
    // Find translated option name for this locale
    const optRecords = subTrans[opt.id] || [];
    const optNameRecord = optRecords.find(t => t.key === "name" && t.locale === locale);
    const optName = optNameRecord?.value || "";

    // Find translated values for this locale
    const valueTranslations: string[] = opt.values.map(val => {
      if (!val.id) return "";
      const valRecords = subTrans[val.id] || [];
      const valNameRecord = valRecords.find(t => t.key === "name" && t.locale === locale);
      return valNameRecord?.value || "";
    });

    optionTranslations[opt.id] = { name: optName, values: valueTranslations };
  }

  for (const mf of item.metafields || []) {
    const mfRecords = subTrans[mf.id] || [];
    const mfValueRecord = mfRecords.find(t => t.key === "value" && t.locale === locale);
    metafieldTranslations[mf.id] = mfValueRecord?.value || "";
  }

  return { optionTranslations, metafieldTranslations };
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

  // Track which item+locale combo we've loaded translations for
  const loadedForRef = useRef<string>("");

  const isPrimaryLocale = currentLanguage === primaryLocale;
  const itemId = selectedItem?.id;

  // ============================================================================
  // LOAD — Read pre-loaded translations from item data (DB pipeline)
  // No fetcher needed — translations come via the loader, same as main translations
  // ============================================================================
  useEffect(() => {
    const loadKey = `${itemId}::${currentLanguage}`;

    // If loadKey matches what we already loaded, nothing to do
    if (loadedForRef.current === loadKey) return;

    // Reset state
    setHasChanges(false);
    setIsTranslating(false);
    setTranslatingOptionId(undefined);
    setTranslatingMetafieldId(undefined);
    setIsLoading(false);

    loadedForRef.current = loadKey;

    // Don't load translations for primary locale
    if (!itemId || isPrimaryLocale) {
      console.log(`[SUB-RESOURCE-HOOK] Skipping load: itemId=${itemId}, isPrimary=${isPrimaryLocale}`);
      setOptionTranslations({});
      setMetafieldTranslations({});
      return;
    }

    // Read translations from pre-loaded item data (loaded in products loader from DB)
    const subTrans = selectedItem?.subResourceTranslations;
    console.log(`[SUB-RESOURCE-HOOK] Loading for item=${itemId}, locale=${currentLanguage}`);
    console.log(`[SUB-RESOURCE-HOOK] selectedItem has options=${selectedItem?.options?.length || 0}, metafields=${selectedItem?.metafields?.length || 0}`);
    console.log(`[SUB-RESOURCE-HOOK] subResourceTranslations keys: [${Object.keys(subTrans || {}).join(", ")}]`);
    if (subTrans) {
      for (const [rid, records] of Object.entries(subTrans)) {
        console.log(`[SUB-RESOURCE-HOOK]   ${rid}: ${records.length} records → ${JSON.stringify(records.slice(0, 3))}`);
      }
    }

    const { optionTranslations: opts, metafieldTranslations: mfs } =
      buildTranslationsFromItem(selectedItem, currentLanguage);

    console.log(`[SUB-RESOURCE-HOOK] Built optionTranslations:`, JSON.stringify(opts));
    console.log(`[SUB-RESOURCE-HOOK] Built metafieldTranslations:`, JSON.stringify(mfs));

    setOptionTranslations(opts);
    setMetafieldTranslations(mfs);
  }, [itemId, currentLanguage, isPrimaryLocale, selectedItem]);

  // ============================================================================
  // Handle fetcher responses (translate + save operations)
  // ============================================================================
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    const data = fetcher.data as any;
    if (!data.success) return;

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
      // Skip values for linked/metaobject options — they are translated via Metaobjects
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

    // Build translationsData: { resourceId: { key: value } }
    const translationsData: Record<string, Record<string, string>> = {};
    const resourceTypes: Record<string, string> = {};

    for (const opt of selectedItem.options || []) {
      const trans = optionTranslations[opt.id];
      if (trans?.name) {
        translationsData[opt.id] = { name: trans.name };
        resourceTypes[opt.id] = "ProductOption";
      }
      // Skip values for linked/metaobject options
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
    // Force re-read from pre-loaded data on next render
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
