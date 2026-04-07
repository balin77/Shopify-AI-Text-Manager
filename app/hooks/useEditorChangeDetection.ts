/**
 * Change detection for the Unified Content Editor.
 * Unifies three different change-detection strategies:
 *  - Standard (products, collections, blogs, pages, policies)
 *  - Template-specific (compares against originalTemplateValuesRef snapshot)
 *  - Metaobject-specific (compares against originalLoadedValuesRef snapshot)
 * Also detects alt-text changes separately.
 */

import { useMemo } from "react";
import { useChangeTracking } from "../utils/contentEditor.utils";
import type { ContentEditorConfig, TranslatableContentItem } from "../types/content-editor.types";

interface UseEditorChangeDetectionProps {
  config: ContentEditorConfig;
  isLoadingData: boolean;
  selectedItem: TranslatableContentItem | undefined;
  currentLanguage: string;
  primaryLocale: string;
  editableValues: Record<string, string>;
  fallbackFields: Set<string>;
  imageAltTexts: Record<number, string>;
  originalAltTexts: Record<number, string>;
  originalLoadedValuesRef: React.MutableRefObject<Record<string, string>>;
  originalTemplateValuesRef: React.MutableRefObject<Record<string, string>>;
  templateValuesVersion: number;
}

interface UseEditorChangeDetectionReturn {
  hasChanges: boolean;
  hasFieldChanges: boolean;
  hasAltTextChanges: boolean;
}

export function useEditorChangeDetection({
  config,
  isLoadingData,
  selectedItem,
  currentLanguage,
  primaryLocale,
  editableValues,
  fallbackFields,
  imageAltTexts,
  originalAltTexts,
  originalLoadedValuesRef,
  originalTemplateValuesRef,
  templateValuesVersion,
}: UseEditorChangeDetectionProps): UseEditorChangeDetectionReturn {
  // Standard change tracking — skip for templates and metaobjects (they use custom logic below)
  const standardHasFieldChanges = useChangeTracking(
    isLoadingData ? null : (
      config.contentType !== 'templates' && config.contentType !== 'metaobjects'
        ? (selectedItem || null)
        : null
    ),
    currentLanguage,
    primaryLocale,
    editableValues,
    config.contentType,
    fallbackFields
  );

  // Template-specific change detection: compare editableValues with originalTemplateValuesRef
  const templateHasFieldChanges = useMemo(() => {
    if (config.contentType !== 'templates' || isLoadingData || !selectedItem) return false;

    const originalValues = originalTemplateValuesRef.current;
    if (Object.keys(originalValues).length === 0) return false;

    // Compare only current page's fields to avoid stale keys from previous pages
    for (const [key, originalValue] of Object.entries(originalValues)) {
      if ((editableValues[key] ?? "") !== originalValue) return true;
    }
    return false;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- templateValuesVersion forces recalc when ref updates
  }, [config.contentType, isLoadingData, selectedItem, editableValues, templateValuesVersion]);

  // Metaobjects-specific change detection: compare editableValues with originalLoadedValuesRef
  const metaobjectsHasFieldChanges = useMemo(() => {
    if (config.contentType !== 'metaobjects' || isLoadingData || !selectedItem) return false;

    const originalValues = originalLoadedValuesRef.current;
    if (!originalValues || Object.keys(originalValues).length === 0) return false;

    for (const [key, originalValue] of Object.entries(originalValues)) {
      if ((editableValues[key] ?? "") !== originalValue) return true;
    }
    return false;
  }, [config.contentType, isLoadingData, selectedItem, editableValues]);

  const hasFieldChanges =
    config.contentType === 'templates' ? templateHasFieldChanges :
    config.contentType === 'metaobjects' ? metaobjectsHasFieldChanges :
    standardHasFieldChanges;

  const hasAltTextChanges = useMemo(() => {
    const originalKeys = Object.keys(originalAltTexts);
    const currentKeys = Object.keys(imageAltTexts);

    if (originalKeys.length === 0 && currentKeys.length === 0) return false;

    const allKeys = new Set([...originalKeys, ...currentKeys]);
    for (const key of allKeys) {
      const numKey = Number(key);
      if (originalAltTexts[numKey] !== imageAltTexts[numKey]) return true;
    }
    return false;
  }, [imageAltTexts, originalAltTexts]);

  return {
    hasChanges: hasFieldChanges || hasAltTextChanges,
    hasFieldChanges,
    hasAltTextChanges,
  };
}
