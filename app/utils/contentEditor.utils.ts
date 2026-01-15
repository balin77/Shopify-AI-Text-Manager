/**
 * Shared utilities for content editing routes
 * Used by: app.collections.tsx, app.blog.tsx, app.pages.tsx, app.policies.tsx
 */

import { useState, useEffect, useRef } from "react";
import type { TranslatableItem, ContentType } from "~/types/contentEditor.types";
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
function getFieldValue(item: TranslatableItem | null | undefined, fieldPath: string): string {
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
  item: TranslatableItem | null | undefined,
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
  item: TranslatableItem | null | undefined,
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
  item: TranslatableItem | null | undefined,
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
 */
function getRequiredFieldsForContentType(contentType: ContentType): string[] {
  if (contentType === 'collections' || contentType === 'products') {
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
      console.warn('Failed to scroll to top:', e);
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
      console.warn('Failed to scroll element into view:', e);
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
  item: TranslatableItem | null | undefined,
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
 */
export function useChangeTracking(
  selectedItem: TranslatableItem | null | undefined,
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

  useEffect(() => {
    if (!selectedItem) {
      setHasChanges(false);
      return;
    }

    const getOriginalValue = (key: string, fallback: string) => {
      if (currentLanguage === primaryLocale) {
        return fallback;
      }
      return getTranslatedValue(selectedItem, key, currentLanguage, "", primaryLocale);
    };

    const descKey = CONTENT_TYPE_DESCRIPTION_KEY[contentType];
    const descFallback = contentType === 'collections'
      ? (selectedItem.descriptionHtml || "")
      : (selectedItem.body || "");

    // Get the actual description/body value from editableFields
    // Pages and Blogs use 'body', Collections use 'description'
    const currentDescValue = editableFields.body || editableFields.description || "";

    // Policies don't have translatable title field
    const titleChanged = contentType !== 'policies'
      ? (editableFields.title || "") !== getOriginalValue(SHOPIFY_TRANSLATION_KEYS.TITLE, selectedItem.title || "")
      : false;

    const descChanged = currentDescValue !== getOriginalValue(descKey, descFallback || "");
    const handleChanged = (editableFields.handle || "") !== getOriginalValue(SHOPIFY_TRANSLATION_KEYS.HANDLE, selectedItem.handle || "");
    const seoTitleChanged = (editableFields.seoTitle || "") !== getOriginalValue(SHOPIFY_TRANSLATION_KEYS.META_TITLE, selectedItem.seo?.title || "");
    const metaDescChanged = (editableFields.metaDescription || "") !== getOriginalValue(SHOPIFY_TRANSLATION_KEYS.META_DESCRIPTION, selectedItem.seo?.description || "");

    setHasChanges(titleChanged || descChanged || handleChanged || seoTitleChanged || metaDescChanged);
  }, [
    editableFields.title,
    editableFields.description,
    editableFields.body,
    editableFields.handle,
    editableFields.seoTitle,
    editableFields.metaDescription,
    selectedItem,
    currentLanguage,
    contentType,
    primaryLocale
  ]);

  return hasChanges;
}

/**
 * Load item data when item or language changes
 */
export function useItemDataLoader(
  selectedItem: TranslatableItem | null | undefined,
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
  selectedItem: TranslatableItem | null | undefined,
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
 */
export function hasPrimaryContentMissing(
  selectedItem: TranslatableItem | null | undefined,
  contentType: ContentType
): boolean {
  if (!selectedItem) return false;

  const requiredFields = FIELD_CONFIGS[contentType];
  return hasAnyFieldMissing(selectedItem, requiredFields);
}

/**
 * Check if a specific locale has missing translations
 * Only marks a field as missing if the primary locale has content for that field
 */
export function hasLocaleMissingTranslations(
  selectedItem: TranslatableItem | null | undefined,
  locale: string,
  primaryLocale: string,
  contentType: ContentType
): boolean {
  if (!selectedItem || locale === primaryLocale) return false;

  const requiredFields = getRequiredFieldsForContentType(contentType);

  return requiredFields.some(field => {
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
  selectedItem: TranslatableItem | null | undefined,
  shopLocales: any[],
  contentType: ContentType
): boolean {
  if (!selectedItem) return false;

  const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";
  const foreignLocales = shopLocales.filter((l: any) => !l.primary);

  return foreignLocales.some((locale: any) =>
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
  selectedItem: TranslatableItem | null | undefined,
  fieldKey: string,
  shopLocales: any[],
  primaryLocale: string,
  contentType: ContentType
): boolean {
  if (!selectedItem) return false;

  // Map UI field names to translation keys
  const translationKey = UI_FIELD_TO_TRANSLATION_KEY[fieldKey] || fieldKey;

  // Check if primary locale has content for this field
  if (!primaryHasFieldContent(selectedItem, translationKey, contentType)) {
    return false;
  }

  // Check if any foreign locale is missing this specific translation
  const foreignLocales = shopLocales.filter((l: any) => !l.primary);

  return foreignLocales.some((locale: any) => {
    return !hasTranslationForField(selectedItem, translationKey, locale.locale);
  });
}

/**
 * Get button style for locale navigation
 * Shows pulsing border animation when translations are missing
 */
export function getLocaleButtonStyle(
  locale: any,
  selectedItem: TranslatableItem | null | undefined,
  primaryLocale: string,
  contentType: ContentType
): React.CSSProperties {
  const primaryContentMissing = locale.primary && hasPrimaryContentMissing(selectedItem, contentType);
  const foreignTranslationMissing = !locale.primary && hasLocaleMissingTranslations(selectedItem, locale.locale, primaryLocale, contentType);

  if (primaryContentMissing) {
    // Pulsing border animation (orange) when primary content is missing
    return {
      animation: `pulse ${TIMING.HIGHLIGHT_DURATION_MS}ms ease-in-out infinite`,
      borderRadius: "8px",
    };
  }

  if (foreignTranslationMissing) {
    // Pulsing border animation (blue) when translations are missing
    return {
      animation: `pulseBlue ${TIMING.HIGHLIGHT_DURATION_MS}ms ease-in-out infinite`,
      borderRadius: "8px",
    };
  }

  return {};
}

/**
 * Common CSS styles for content editor pages
 */
export const contentEditorStyles = `
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
`;
