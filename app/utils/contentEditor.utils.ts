/**
 * Shared utilities for content editing routes
 * Used by: app.collections.tsx, app.blog.tsx, app.pages.tsx, app.policies.tsx
 */

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { TranslatableItem, ContentType, ShopLocale } from "~/types/contentEditor.types";
import {
  SHOPIFY_TRANSLATION_KEYS,
  CONTENT_TYPE_DESCRIPTION_KEY,
  UI_FIELD_TO_TRANSLATION_KEY,
  FIELD_CONFIGS,
} from "~/constants/shopifyFields";
import { TIMING } from "~/constants/timing";

export interface ContentEditorState {
  editableTitle: string;
  setEditableTitle: (value: string) => void;
  editableDescription: string;
  setEditableDescription: (value: string) => void;
  editableHandle: string;
  setEditableHandle: (value: string) => void;
  editableSeoTitle: string;
  setEditableSeoTitle: (value: string) => void;
  editableMetaDescription: string;
  setEditableMetaDescription: (value: string) => void;
  hasChanges: boolean;
  setHasChanges: (value: boolean) => void;
  descriptionMode: "html" | "rendered";
  setDescriptionMode: (value: "html" | "rendered") => void;
}

export interface NavigationState {
  pendingNavigation: (() => void) | null;
  setPendingNavigation: (action: (() => void) | null) => void;
  highlightSaveButton: boolean;
  setHighlightSaveButton: (value: boolean) => void;
  saveButtonRef: React.RefObject<HTMLDivElement>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get field value from item, supporting nested paths (e.g., 'seo.title')
 */
function getFieldValue(item: TranslatableItem | null, fieldPath: string): string {
  if (!item) return '';

  const parts = fieldPath.split('.');
  let value: any = item;

  for (const part of parts) {
    value = value?.[part];
    if (value === undefined || value === null) {
      return '';
    }
  }

  return typeof value === 'string' ? value : '';
}

/**
 * Check if a field value is empty (null, undefined, or whitespace only)
 */
function isFieldEmpty(value: string): boolean {
  return !value || (typeof value === 'string' && value.trim() === '');
}

/**
 * Check if item has any missing required fields
 */
function hasAnyFieldMissing(
  item: TranslatableItem | null,
  fields: readonly string[]
): boolean {
  if (!item) return false;

  return fields.some(field => {
    const value = getFieldValue(item, field);
    return isFieldEmpty(value);
  });
}

/**
 * Check if primary locale has content for a specific field
 */
function primaryHasFieldContent(
  item: TranslatableItem | null,
  field: string,
  contentType: ContentType
): boolean {
  if (!item) return false;

  // Map translation key to actual field path
  const fieldPathMap: Record<string, string> = {
    title: 'title',
    body_html: contentType === 'collections' || contentType === 'products' ? 'descriptionHtml' : 'body',
    body: 'body',
    handle: 'handle',
    meta_title: 'seo.title',
    meta_description: 'seo.description',
  };

  const fieldPath = fieldPathMap[field] || field;
  const value = getFieldValue(item, fieldPath);
  return !isFieldEmpty(value);
}

/**
 * Check if a specific locale has a translation for a field
 */
function hasTranslationForField(
  item: TranslatableItem | null,
  field: string,
  locale: string
): boolean {
  if (!item) return false;

  const translations = item.translations?.filter(t => t.locale === locale) || [];
  const translation = translations.find(t => t.key === field);
  return !!translation && !isFieldEmpty(translation.value);
}

/**
 * Get required translation fields for content type
 * Note: For templates, returns empty array as templates have dynamic fields
 * handled separately in hasPrimaryContentMissing and hasLocaleMissingTranslations
 */
function getRequiredFieldsForContentType(contentType: ContentType): string[] {
  if (contentType === 'templates') {
    // Templates have dynamic fields in translatableContent
    // The validation is handled separately in the calling functions
    return [];
  } else if (contentType === 'collections' || contentType === 'products') {
    return ["title", "body_html", "handle", "meta_title", "meta_description"];
  } else if (contentType === 'policies') {
    return ["body"];
  } else {
    return ["title", "body_html", "handle"];
  }
}

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
  },
  contentType: ContentType
) {
  const [hasChanges, setHasChanges] = useState(false);

  // Cache original values to prevent recalculation on every selectedItem reference change
  const originalValuesRef = useRef<{
    itemId: string | null;
    language: string;
    title: string;
    description: string;
    handle: string;
    seoTitle: string;
    metaDescription: string;
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
    const handleChanged = (editableFields.handle || "") !== originals.handle;
    const seoTitleChanged = (editableFields.seoTitle || "") !== originals.seoTitle;
    const metaDescChanged = (editableFields.metaDescription || "") !== originals.metaDescription;

    const newHasChanges = titleChanged || descChanged || handleChanged || seoTitleChanged || metaDescChanged;

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
    // Use selectedItem?.id instead of selectedItem to prevent re-runs on reference changes
    selectedItem?.id,
    currentLanguage,
    contentType,
    hasChanges
  ]);

  return hasChanges;
}

/**
 * Load item data when item or language changes
 */
export function useItemDataLoader(
  selectedItem: TranslatableItem | null,
  currentLanguage: string,
  primaryLocale: string,
  contentType: ContentType,
  setEditableFields: (fields: {
    title: string;
    description: string;
    handle: string;
    seoTitle: string;
    metaDescription: string;
  }) => void,
  selectedItemId: string | null
) {
  useEffect(() => {
    if (!selectedItem) return;

    if (currentLanguage === primaryLocale) {
      // Load primary locale data
      const title = selectedItem.title || "";
      let description = "";
      let handle = selectedItem.handle || "";
      let seoTitle = "";
      let metaDescription = "";

      if (contentType === 'blogs') {
        description = selectedItem.body || "";
      } else if (contentType === 'collections') {
        description = selectedItem.descriptionHtml || "";
        seoTitle = selectedItem.seo?.title || "";
        metaDescription = selectedItem.seo?.description || "";
      } else if (contentType === 'pages') {
        description = selectedItem.body || "";
      } else if (contentType === 'policies') {
        description = selectedItem.body || "";
        handle = "";
      }

      setEditableFields({
        title,
        description,
        handle,
        seoTitle,
        metaDescription
      });
    } else {
      // Load translation data (translations are already loaded in item.translations)
      const descKey = CONTENT_TYPE_DESCRIPTION_KEY[contentType];

      const title = contentType !== 'policies'
        ? getTranslatedValue(selectedItem, SHOPIFY_TRANSLATION_KEYS.TITLE, currentLanguage, "", primaryLocale)
        : "";
      const description = getTranslatedValue(selectedItem, descKey, currentLanguage, "", primaryLocale);
      const handle = getTranslatedValue(selectedItem, SHOPIFY_TRANSLATION_KEYS.HANDLE, currentLanguage, "", primaryLocale);
      const seoTitle = getTranslatedValue(selectedItem, SHOPIFY_TRANSLATION_KEYS.META_TITLE, currentLanguage, "", primaryLocale);
      const metaDescription = getTranslatedValue(selectedItem, SHOPIFY_TRANSLATION_KEYS.META_DESCRIPTION, currentLanguage, "", primaryLocale);

      setEditableFields({
        title,
        description,
        handle,
        seoTitle,
        metaDescription
      });
    }
  }, [selectedItemId, currentLanguage, selectedItem, contentType, primaryLocale]);
}

/**
 * Check if field is translated
 */
export function isFieldTranslated(
  selectedItem: TranslatableItem | null,
  key: string,
  currentLanguage: string,
  primaryLocale: string
): boolean {
  if (currentLanguage === primaryLocale) return true;
  if (!selectedItem) return false;

  const translations = selectedItem.translations || [];
  const translation = translations.find(
    (t) => t.key === key && t.locale === currentLanguage
  );

  return !!translation && !!translation.value;
}

/**
 * Check if primary locale has any missing content
 * For templates: checks if any translatableContent entry has empty value
 */
export function hasPrimaryContentMissing(
  selectedItem: TranslatableItem | null,
  contentType: ContentType
): boolean {
  if (!selectedItem) return false;

  // Templates have dynamic fields in translatableContent
  if (contentType === 'templates') {
    const translatableContent = (selectedItem as any).translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent) || translatableContent.length === 0) {
      return false; // No content to check
    }
    // Check if any translatableContent entry has empty value
    // Filter out null/undefined items to prevent "Cannot read properties of null" errors
    return translatableContent.filter((item) => item != null).some((item: { key: string; value: string }) =>
      isFieldEmpty(item.value)
    );
  }

  const requiredFields = FIELD_CONFIGS[contentType];
  return hasAnyFieldMissing(selectedItem, requiredFields);
}

/**
 * Check if a specific locale has missing translations
 * Only marks a field as missing if the primary locale has content for that field
 * For templates: checks translations for dynamic translatableContent fields
 */
export function hasLocaleMissingTranslations(
  selectedItem: TranslatableItem | null,
  locale: string,
  primaryLocale: string,
  contentType: ContentType
): boolean {
  if (!selectedItem || locale === primaryLocale) return false;

  // Templates have dynamic fields in translatableContent
  if (contentType === 'templates') {
    const translatableContent = (selectedItem as any).translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent) || translatableContent.length === 0) {
      return false; // No content to check
    }

    const translations = selectedItem.translations || [];

    // Check if any translatableContent entry with a value is missing a translation
    // Filter out null/undefined items to prevent "Cannot read properties of null" errors
    return translatableContent.filter((item) => item != null).some((item: { key: string; value: string }) => {
      // Only check if primary has content for this field
      if (isFieldEmpty(item.value)) {
        return false;
      }
      // Check if translation exists for this locale
      const translation = translations.find(
        (t: any) => t.key === item.key && t.locale === locale
      );
      return !translation || isFieldEmpty(translation.value);
    });
  }

  const requiredFields = getRequiredFieldsForContentType(contentType);

  return requiredFields.some(field => {
    // Skip handle field - Shopify often doesn't return translations for handles
    // that are identical to the primary locale, so we ignore it in validation
    if (field === 'handle') {
      return false;
    }

    // Only check if primary has content
    if (!primaryHasFieldContent(selectedItem, field, contentType)) {
      return false;
    }

    // Check if translation exists
    return !hasTranslationForField(selectedItem, field, locale);
  });
}

/**
 * Check if any foreign locale has missing translations
 */
export function hasMissingTranslations(
  selectedItem: TranslatableItem | null,
  shopLocales: ShopLocale[],
  contentType: ContentType
): boolean {
  if (!selectedItem) return false;

  const primaryLocale = shopLocales.find(l => l.primary)?.locale || "de";
  const foreignLocales = shopLocales.filter(l => !l.primary);

  return foreignLocales.some(locale =>
    hasLocaleMissingTranslations(selectedItem, locale.locale, primaryLocale, contentType)
  );
}

/**
 * Check if a specific field has missing translations in any foreign locale
 * Only returns true if:
 * 1. The primary locale has content for this field
 * 2. At least one foreign locale is missing translation for this field
 */
export function hasFieldMissingTranslations(
  selectedItem: TranslatableItem | null,
  fieldKey: string,
  shopLocales: ShopLocale[],
  primaryLocale: string,
  contentType: ContentType
): boolean {
  if (!selectedItem) return false;

  // Skip handle field - Shopify often doesn't return translations for handles
  // that are identical to the primary locale, so we ignore it in validation
  if (fieldKey === 'handle') {
    return false;
  }

  // Map UI field names to translation keys
  const translationKey = UI_FIELD_TO_TRANSLATION_KEY[fieldKey] || fieldKey;

  // Check if primary locale has content for this field
  if (!primaryHasFieldContent(selectedItem, translationKey, contentType)) {
    return false;
  }

  // Check if any foreign locale is missing this specific translation
  const foreignLocales = shopLocales.filter(l => !l.primary);

  return foreignLocales.some(locale => {
    return !hasTranslationForField(selectedItem, translationKey, locale.locale);
  });
}

/**
 * Get button style for locale navigation
 * Shows pulsing border animation when translations are missing
 * @deprecated Use useLocaleButtonStyle hook instead for better performance
 */
export function getLocaleButtonStyle(
  locale: ShopLocale,
  selectedItem: TranslatableItem | null,
  primaryLocale: string,
  contentType: ContentType
): React.CSSProperties {
  const primaryContentMissing = locale.primary && hasPrimaryContentMissing(selectedItem, contentType);
  const foreignTranslationMissing = !locale.primary && hasLocaleMissingTranslations(selectedItem, locale.locale, primaryLocale, contentType);

  if (primaryContentMissing) {
    // Pulsing border animation (orange) when primary content is missing
    // 1s delay to allow data loading, smooth fade-in start
    return {
      animation: `pulseFadeIn 500ms ease-out forwards, pulse ${TIMING.HIGHLIGHT_DURATION_MS}ms ease-in-out 1.5s infinite`,
      animationDelay: "1s, 1.5s",
      borderRadius: "8px",
    };
  }

  if (foreignTranslationMissing) {
    // Pulsing border animation (blue) when translations are missing
    // 1s delay to allow data loading, smooth fade-in start
    return {
      animation: `pulseBlueFadeIn 500ms ease-out forwards, pulseBlue ${TIMING.HIGHLIGHT_DURATION_MS}ms ease-in-out 1.5s infinite`,
      animationDelay: "1s, 1.5s",
      borderRadius: "8px",
    };
  }

  return {};
}

/**
 * Hook: Get button style for locale navigation with memoization
 * Shows pulsing border animation when translations are missing
 * This hook provides better performance than getLocaleButtonStyle by memoizing the result
 */
export function useLocaleButtonStyle(
  locale: ShopLocale,
  selectedItem: TranslatableItem | null,
  primaryLocale: string,
  contentType: ContentType
): React.CSSProperties {
  return useMemo(() => {
    const primaryContentMissing = locale.primary && hasPrimaryContentMissing(selectedItem, contentType);
    const foreignTranslationMissing = !locale.primary && hasLocaleMissingTranslations(selectedItem, locale.locale, primaryLocale, contentType);

    if (primaryContentMissing) {
      // Pulsing border animation (orange) when primary content is missing
      // 1s delay to allow data loading, smooth fade-in start
      return {
        animation: `pulseFadeIn 500ms ease-out forwards, pulse ${TIMING.HIGHLIGHT_DURATION_MS}ms ease-in-out 1.5s infinite`,
        animationDelay: "1s, 1.5s",
        borderRadius: "8px",
      };
    }

    if (foreignTranslationMissing) {
      // Pulsing border animation (blue) when translations are missing
      // 1s delay to allow data loading, smooth fade-in start
      return {
        animation: `pulseBlueFadeIn 500ms ease-out forwards, pulseBlue ${TIMING.HIGHLIGHT_DURATION_MS}ms ease-in-out 1.5s infinite`,
        animationDelay: "1s, 1.5s",
        borderRadius: "8px",
      };
    }

    return {};
  }, [locale, selectedItem, primaryLocale, contentType]);
}

/**
 * Common CSS styles for content editor pages
 */
export const contentEditorStyles = `
  /* Global layout fixes - based on ImageVariantManager pattern */
  html, body {
    margin: 0;
    padding: 0;
    overflow: hidden;
    height: 100%;
  }

  /* Polaris Page component overrides for full-height layout */
  .Polaris-Page {
    padding: 0 !important;
    max-width: 100% !important;
    height: 100% !important;
  }

  .Polaris-Page__Content {
    padding: 0 !important;
    height: 100% !important;
  }

  /* Ensure full height propagates through Polaris wrappers */
  .Polaris-Frame {
    height: 100% !important;
  }

  .description-editor h1 {
    font-size: 2em;
    font-weight: bold;
    margin: 0.67em 0;
  }
  .description-editor h2 {
    font-size: 1.5em;
    font-weight: bold;
    margin: 0.75em 0;
  }
  .description-editor h3 {
    font-size: 1.17em;
    font-weight: bold;
    margin: 0.83em 0;
  }
  .description-editor p {
    margin: 1em 0;
  }
  .description-editor ul, .description-editor ol {
    margin: 1em 0;
    padding-left: 40px;
  }

  /* Fade-in animations for smooth start (orange) */
  @keyframes pulseFadeIn {
    0% {
      box-shadow: 0 0 0 0 rgba(255, 149, 0, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(255, 149, 0, 0.7);
    }
  }

  /* Fade-in animations for smooth start (blue) */
  @keyframes pulseBlueFadeIn {
    0% {
      box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7);
    }
  }

  @keyframes pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(255, 149, 0, 0.7);
    }
    50% {
      box-shadow: 0 0 20px 10px rgba(255, 149, 0, 0.3);
    }
  }

  @keyframes pulseBlue {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7);
    }
    50% {
      box-shadow: 0 0 20px 10px rgba(59, 130, 246, 0.3);
    }
  }

  /* Hide SEO sidebar on narrow screens */
  @media (max-width: 1100px) {
    .seo-sidebar-container {
      display: none !important;
    }
  }
`;
