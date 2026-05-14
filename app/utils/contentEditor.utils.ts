/**
 * Shared utilities for content editing routes
 * Used by: app.collections.tsx, app.blog.tsx, app.pages.tsx, app.policies.tsx
 */

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { TranslatableItem, ContentType, ShopLocale } from "~/types/content-editor.types";
import {
  SHOPIFY_TRANSLATION_KEYS,
  CONTENT_TYPE_DESCRIPTION_KEY,
  FIELD_TO_LABEL_KEY,
} from "~/constants/shopifyFields";
import { TIMING } from "~/constants/timing";
import { extractReadableName } from "~/utils/templates-field-factory";
import {
  ValidationOverlays,
  hasPrimaryContentMissing as fvHasPrimaryContentMissing,
  hasLocaleMissingTranslations as fvHasLocaleMissingTranslations,
  getMissingPrimaryFields as fvGetMissingPrimaryFields,
  getMissingLocaleTranslationFields as fvGetMissingLocaleTranslationFields,
} from "~/utils/field-validation.utils";
export type { ValidationOverlays };

/** Minimal shape of a metaobject entry as stored on TranslatableItem */
export interface MetaobjectEntry {
  id: string;
  handle?: string;
  displayName?: string;
  fields?: { key: string; value: string }[];
}

/**
 * Returns a localized language name using Intl.DisplayNames.
 * Falls back to the Shopify-provided name or the locale code.
 */
export function getLocalizedLanguageName(localeCode: string, appLocale: string, fallbackName?: string): string {
  try {
    const displayNames = new Intl.DisplayNames([appLocale], { type: 'language' });
    const name = displayNames.of(localeCode);
    if (name) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    // Intl.DisplayNames not supported, fall through
  }
  return fallbackName || localeCode;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely scroll to top of page
 */
function safeScrollToTop(): void {
  try {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    // Fallback for browsers that don't support smooth scrolling
    try {
      window.scrollTo(0, 0);
    } catch (e) {
      // Ignore scroll errors
    }
  }
}

/**
 * Safely scroll element into view
 */
function safeScrollIntoView(element: HTMLElement | null): void {
  if (!element) return;

  try {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    // Fallback for browsers that don't support smooth scrolling
    try {
      element.scrollIntoView();
    } catch (e) {
      // Ignore scroll errors
    }
  }
}

// ============================================================================
// Exported Functions
// ============================================================================

/**
 * Get translated value from translations array
 */
export function getTranslatedValue(
  item: TranslatableItem | null,
  key: string,
  locale: string,
  fallback: string,
  primaryLocale: string
): string {
  if (!item || locale === primaryLocale) {
    return fallback;
  }

  const translations = item.translations || [];
  const translation = translations.find(
    (t) => t.key === key && t.locale === locale
  );

  return translation?.value || "";
}

/**
 * Handle navigation attempt with unsaved changes warning
 */
export function useNavigationGuard() {
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [highlightSaveButton, setHighlightSaveButton] = useState(false);
  const saveButtonRef = useRef<HTMLDivElement>(null);

  const handleNavigationAttempt = (navigationAction: () => void, hasChanges: boolean): void => {
    if (hasChanges) {
      // Prevent navigation
      setPendingNavigation(() => navigationAction);

      // Safely scroll to top
      safeScrollToTop();

      // Highlight and scroll to save button
      setHighlightSaveButton(true);
      safeScrollIntoView(saveButtonRef.current);
      return;
    }

    // Allow navigation
    setHighlightSaveButton(false);
    setPendingNavigation(null);
    navigationAction();
  };

  const clearPendingNavigation = () => {
    setTimeout(() => {
      if (pendingNavigation) {
        pendingNavigation();
      }
      setPendingNavigation(null);
      setHighlightSaveButton(false);
    }, TIMING.NAVIGATION_DELAY_MS);
  };

  return {
    pendingNavigation,
    setPendingNavigation,
    highlightSaveButton,
    setHighlightSaveButton,
    saveButtonRef,
    handleNavigationAttempt,
    clearPendingNavigation,
  };
}

/**
 * Track changes in editable fields
 * IMPORTANT: Uses refs to cache original values and prevent infinite re-renders
 * when selectedItem reference changes (e.g., from Shopify admin revalidations)
 */
export function useChangeTracking(
  selectedItem: TranslatableItem | null,
  currentLanguage: string,
  primaryLocale: string,
  editableFields: {
    title?: string;
    description?: string;
    body?: string;
    handle?: string;
    seoTitle?: string;
    metaDescription?: string;
    productType?: string;
    summary?: string;
  },
  contentType: ContentType,
  fallbackFields?: Set<string>
) {
  const [hasChanges, setHasChanges] = useState(false);

  // Use ref for fallbackFields to avoid triggering useEffect on Set reference changes
  const fallbackFieldsRef = useRef(fallbackFields);
  fallbackFieldsRef.current = fallbackFields;

  // Cache original values to prevent recalculation on every selectedItem reference change
  const originalValuesRef = useRef<{
    itemId: string | null;
    language: string;
    title: string;
    description: string;
    handle: string;
    seoTitle: string;
    metaDescription: string;
    productType: string;
    summary: string;
  } | null>(null);

  // Track previous item ID and language to detect actual changes
  const prevItemIdRef = useRef<string | null>(null);
  const prevLanguageRef = useRef<string>(currentLanguage);

  // Track if selectedItem was null (used to detect post-save state)
  const wasNullRef = useRef<boolean>(selectedItem === null);

  // Helper function to get current item values
  const getCurrentItemValues = useCallback((item: TranslatableItem) => {
    const descKey = CONTENT_TYPE_DESCRIPTION_KEY[contentType];
    const descFallback = (contentType === 'collections' || contentType === 'products')
      ? (item.descriptionHtml || "")
      : (item.body || "");

    const getOriginalValue = (key: string, fallback: string) => {
      if (currentLanguage === primaryLocale) {
        return fallback;
      }
      return getTranslatedValue(item, key, currentLanguage, "", primaryLocale);
    };

    return {
      title: contentType !== 'policies'
        ? getOriginalValue(SHOPIFY_TRANSLATION_KEYS.TITLE, item.title || "")
        : "",
      description: getOriginalValue(descKey, descFallback || ""),
      handle: getOriginalValue(SHOPIFY_TRANSLATION_KEYS.HANDLE, item.handle || ""),
      seoTitle: getOriginalValue(SHOPIFY_TRANSLATION_KEYS.META_TITLE, item.seo?.title || ""),
      metaDescription: getOriginalValue(SHOPIFY_TRANSLATION_KEYS.META_DESCRIPTION, item.seo?.description || ""),
      productType: contentType === 'products'
        ? getOriginalValue(SHOPIFY_TRANSLATION_KEYS.PRODUCT_TYPE, item.productType || "")
        : "",
      summary: contentType === 'pages'
        ? getOriginalValue(SHOPIFY_TRANSLATION_KEYS.SUMMARY, item.summary || "")
        : "",
    };
  }, [contentType, currentLanguage, primaryLocale]);

  const selectedItemId = selectedItem?.id || null;

  // Update cached original values when:
  // 1. Item ID or language changes
  // 2. Item was null and is now non-null (post-save/load state - update to current editable values)
  if (selectedItem) {
    const itemIdChanged = prevItemIdRef.current !== selectedItemId;
    const languageChanged = prevLanguageRef.current !== currentLanguage;
    const wasNull = wasNullRef.current;

    if (itemIdChanged || languageChanged) {
      // Item or language changed - cache the item's current values as original
      prevItemIdRef.current = selectedItemId;
      prevLanguageRef.current = currentLanguage;

      const itemValues = getCurrentItemValues(selectedItem);
      originalValuesRef.current = {
        itemId: selectedItemId,
        language: currentLanguage,
        ...itemValues,
      };
    } else if (wasNull && originalValuesRef.current) {
      // Coming back from null state (after save/load) - update original values to match editable fields
      // This ensures hasChanges becomes false after save
      originalValuesRef.current = {
        itemId: selectedItemId,
        language: currentLanguage,
        title: editableFields.title || "",
        description: editableFields.body || editableFields.description || "",
        handle: editableFields.handle || "",
        seoTitle: editableFields.seoTitle || "",
        metaDescription: editableFields.metaDescription || "",
        productType: editableFields.productType || "",
        summary: editableFields.summary || "",
      };
    }
  }

  // Update wasNull tracking
  wasNullRef.current = selectedItem === null;

  // Calculate hasChanges based on cached original values
  // This effect only depends on editableFields, not on selectedItem reference
  useEffect(() => {
    if (!selectedItem || !originalValuesRef.current) {
      if (hasChanges) setHasChanges(false);
      return;
    }

    const originals = originalValuesRef.current;
    const currentDescValue = editableFields.body || editableFields.description || "";

    const titleChanged = contentType !== 'policies'
      ? (editableFields.title || "") !== originals.title
      : false;
    const descChanged = currentDescValue !== originals.description;
    // Skip fallback fields - they show primary locale values and shouldn't count as changes
    const handleChanged = !fallbackFieldsRef.current?.has('handle') && (editableFields.handle || "") !== originals.handle;
    const seoTitleChanged = !fallbackFieldsRef.current?.has('seoTitle') && (editableFields.seoTitle || "") !== originals.seoTitle;
    const metaDescChanged = (editableFields.metaDescription || "") !== originals.metaDescription;
    const productTypeChanged = contentType === 'products'
      ? (editableFields.productType || "") !== originals.productType
      : false;
    const summaryChanged = contentType === 'pages'
      ? (editableFields.summary || "") !== originals.summary
      : false;

    const newHasChanges = titleChanged || descChanged || handleChanged || seoTitleChanged || metaDescChanged || productTypeChanged || summaryChanged;

    // Only update state if value actually changed to prevent unnecessary re-renders
    if (newHasChanges !== hasChanges) {
      setHasChanges(newHasChanges);
    }
  }, [
    editableFields.title,
    editableFields.description,
    editableFields.body,
    editableFields.handle,
    editableFields.seoTitle,
    editableFields.metaDescription,
    editableFields.productType,
    editableFields.summary,
    // Use selectedItem?.id instead of selectedItem to prevent re-runs on reference changes
    selectedItem?.id,
    currentLanguage,
    contentType,
    hasChanges
  ]);

  return hasChanges;
}

// ============================================================================
// Validation functions — delegate to field-validation.utils.ts
// (overlay-aware implementations live there; re-exported with same signature)
// ============================================================================

export function hasPrimaryContentMissing(
  selectedItem: TranslatableItem | null,
  contentType: ContentType,
  overlays?: ValidationOverlays
): boolean {
  return fvHasPrimaryContentMissing(selectedItem, contentType, overlays);
}

export function hasLocaleMissingTranslations(
  selectedItem: TranslatableItem | null,
  locale: string,
  primaryLocale: string,
  contentType: ContentType,
  overlays?: ValidationOverlays
): boolean {
  return fvHasLocaleMissingTranslations(selectedItem, locale, primaryLocale, contentType, overlays);
}

export function getMissingPrimaryFields(
  selectedItem: TranslatableItem | null,
  contentType: ContentType,
  overlays?: ValidationOverlays
): string[] {
  return fvGetMissingPrimaryFields(selectedItem, contentType, overlays);
}

export function getMissingLocaleTranslationFields(
  selectedItem: TranslatableItem | null,
  locale: string,
  primaryLocale: string,
  contentType: ContentType,
  overlays?: ValidationOverlays
): string[] {
  return fvGetMissingLocaleTranslationFields(selectedItem, locale, primaryLocale, contentType, overlays);
}

/**
 * Get tooltip text for a locale button listing missing fields.
 * Returns null if nothing is missing (no tooltip needed).
 *
 * @param i18n - Translation strings from common.fieldLabels / common.missingContent / common.missingTranslations
 */
export function getLocaleButtonTooltip(
  locale: ShopLocale,
  selectedItem: TranslatableItem | null,
  primaryLocale: string,
  contentType: ContentType,
  isLoadingData: boolean = false,
  i18n?: {
    missingContent: string;
    missingTranslations: string;
    fieldLabels: Record<string, string>;
  },
  overlays?: ValidationOverlays
): string | null {
  if (isLoadingData || !selectedItem) return null;

  let missingFields: string[];
  let prefix: string;

  if (locale.primary) {
    missingFields = getMissingPrimaryFields(selectedItem, contentType, overlays);
    prefix = i18n?.missingContent ?? 'Missing content:';
  } else {
    missingFields = getMissingLocaleTranslationFields(
      selectedItem, locale.locale, primaryLocale, contentType, overlays
    );
    prefix = i18n?.missingTranslations ?? 'Missing translations:';
  }

  if (missingFields.length === 0) return null;

  const fieldLabels = i18n?.fieldLabels ?? {};
  const labels = missingFields.map(key => {
    if (contentType === 'templates') {
      return extractReadableName(key);
    }

    // Metaobjects: resolve metaobject ID to its display name
    if (contentType === 'metaobjects') {
      const metaobjects = (selectedItem as { metaobjects?: MetaobjectEntry[] }).metaobjects;
      if (metaobjects && Array.isArray(metaobjects)) {
        const metaobj = metaobjects.find((m: MetaobjectEntry) => m.id === key);
        if (metaobj) {
          return metaobj.displayName || metaobj.handle || key.split('/').pop() || key;
        }
      }
      return key.split('/').pop() || key;
    }

    // Handle product option fields (e.g., "option_1_name", "option_2_values")
    if (key.startsWith('option_')) {
      const match = key.match(/^option_(\d+)_(name|values)$/);
      if (match) {
        const optionNumber = match[1];
        const fieldType = match[2];
        const templateKey = fieldType === 'name' ? 'optionName' : 'optionValues';
        const template = fieldLabels[templateKey] || (fieldType === 'name' ? 'Option {number} name' : 'Option {number} values');
        return template.replace('{number}', optionNumber);
      }
    }

    const labelKey = FIELD_TO_LABEL_KEY[key];
    return (labelKey && fieldLabels[labelKey]) || labelKey || key;
  });
  // Deduplicate (e.g. 'body' and 'body_html' both map to 'description')
  const unique = [...new Set(labels)];
  return `${prefix} ${unique.join(', ')}`;
}

// Module-level reference point for synchronizing all pulse animations across buttons.
// A negative animation-delay calculated from this epoch ensures every button starts
// at the correct phase of the shared pulse cycle, even when animations restart at
// different times (e.g., after editing a field briefly removes the "missing" state).
export const PULSE_SYNC_EPOCH = Date.now();

/**
 * Hook: Get button style for locale navigation with memoization
 * Shows pulsing border animation when translations are missing
 * This hook provides better performance than getLocaleButtonStyle by memoizing the result
 */
export function useLocaleButtonStyle(
  locale: ShopLocale,
  selectedItem: TranslatableItem | null,
  primaryLocale: string,
  contentType: ContentType,
  isLoadingData: boolean = false,
  overlays?: ValidationOverlays,
  overlaysVersion?: number
): React.CSSProperties {
  // Track translations length separately so the memo recalculates when
  // item.translations is mutated in-place (e.g. after Accept & Translate).
  // Without this, useMemo sees the same selectedItem reference and returns
  // a stale pulsing state even though translations were added.
  const translationsLength = selectedItem?.translations?.length ?? 0;

  return useMemo(() => {
    // Don't show blinking animations while data is still loading
    if (isLoadingData) {
      return {};
    }

    const primaryContentMissing = locale.primary && hasPrimaryContentMissing(selectedItem, contentType, overlays);
    const foreignTranslationMissing = !locale.primary && hasLocaleMissingTranslations(selectedItem, locale.locale, primaryLocale, contentType, overlays);

    if (primaryContentMissing || foreignTranslationMissing) {
      // Synchronize all pulse animations to a shared reference point (PULSE_SYNC_EPOCH).
      // A negative delay starts the animation mid-cycle at the correct phase,
      // so all buttons pulse in lockstep even when animations restart at different times.
      const pulseDuration = TIMING.HIGHLIGHT_DURATION_MS;
      const syncOffset = (Date.now() - PULSE_SYNC_EPOCH) % pulseDuration;
      const isOrange = primaryContentMissing;
      const fadeIn = isOrange ? 'pulseFadeIn' : 'pulseBlueFadeIn';
      const pulse = isOrange ? 'pulse' : 'pulseBlue';

      return {
        animation: `${fadeIn} 500ms ease-out forwards, ${pulse} ${pulseDuration}ms ease-in-out infinite`,
        animationDelay: `0s, -${syncOffset}ms`,
        borderRadius: "8px",
      };
    }

    return {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, selectedItem, primaryLocale, contentType, isLoadingData, translationsLength, overlaysVersion]);
}

