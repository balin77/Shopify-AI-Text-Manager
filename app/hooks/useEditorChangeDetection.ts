/**
 * Change detection for the Unified Content Editor.
 * Uses a single unified baseline (baselineValuesRef) across all content types:
 *  - Standard (products, collections, blogs, pages, policies)
 *  - Templates
 *  - Metaobjects
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
  /** Unified change-detection baseline — single source of truth for all content types */
  baselineValuesRef: React.MutableRefObject<Record<string, string>>;
  /** Incremented whenever baselineValuesRef updates, to force useMemo recalculation */
  baselineVersion: number;
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
  baselineValuesRef,
  baselineVersion,
}: UseEditorChangeDetectionProps): UseEditorChangeDetectionReturn {
  // useChangeTracking is called with null to satisfy React hook rules while being disabled.
  // All change detection now goes through the unified baselineValuesRef below.
  useChangeTracking(null, currentLanguage, primaryLocale, editableValues, config.contentType, fallbackFields);

  // Unified change detection: compare editableValues against the baseline set by
  // onDataLoaded() after revalidation and by translation callbacks. Works for all
  // content types (standard, templates, metaobjects).
  const hasFieldChanges = useMemo(() => {
    if (isLoadingData || !selectedItem) return false;
    const baseline = baselineValuesRef.current;
    if (Object.keys(baseline).length === 0) return false;
    for (const [key, baselineValue] of Object.entries(baseline)) {
      if ((editableValues[key] ?? "") !== baselineValue) return true;
    }
    return false;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- baselineVersion forces recalc when ref updates
  }, [editableValues, baselineVersion, isLoadingData, selectedItem]);

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
