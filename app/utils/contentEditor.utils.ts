/**
 * Shared utilities for content editing routes
 * Used by: app.collections.tsx, app.blog.tsx, app.pages.tsx, app.policies.tsx
 */

import { useState, useEffect, useRef } from "react";

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

/**
 * Get translated value from translations array
 */
export function getTranslatedValue(
  item: any,
  key: string,
  locale: string,
  fallback: string,
  primaryLocale: string
): string {
  if (!item || locale === primaryLocale) {
    return fallback;
  }

  // Get translations directly from item
  const translations = item.translations || [];

  const translation = translations.find(
    (t: any) => t.key === key && t.locale === locale
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

  const handleNavigationAttempt = (navigationAction: () => void, hasChanges: boolean) => {
    if (hasChanges) {
      // Prevent navigation
      setPendingNavigation(() => navigationAction);

      // Scroll to top
      window.scrollTo({ top: 0, behavior: 'smooth' });

      // Highlight save button
      setHighlightSaveButton(true);

      // Scroll save button into view
      if (saveButtonRef.current) {
        saveButtonRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      return false; // Prevent navigation
    }

    // Allow navigation
    setHighlightSaveButton(false);
    setPendingNavigation(null);
    navigationAction();
    return true;
  };

  const clearPendingNavigation = () => {
    setTimeout(() => {
      if (pendingNavigation) {
        pendingNavigation();
      }
      setPendingNavigation(null);
      setHighlightSaveButton(false);
    }, 500);
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
  selectedItem: any,
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
  contentType: 'pages' | 'blogs' | 'collections' | 'policies' | 'products'
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

    const descKey = contentType === 'policies' ? 'body' : 'body_html';
    const descFallback = contentType === 'collections'
      ? (selectedItem.descriptionHtml || "")
      : (selectedItem.body || "");

    // Get the actual description/body value from editableFields
    // Pages and Blogs use 'body', Collections use 'description'
    const currentDescValue = editableFields.body || editableFields.description || "";

    // Policies don't have translatable title field
    const titleChanged = contentType !== 'policies'
      ? (editableFields.title || "") !== getOriginalValue("title", selectedItem.title || "")
      : false;

    const descChanged = currentDescValue !== getOriginalValue(descKey, descFallback || "");
    const handleChanged = (editableFields.handle || "") !== getOriginalValue("handle", selectedItem.handle || "");
    const seoTitleChanged = (editableFields.seoTitle || "") !== getOriginalValue("meta_title", selectedItem.seo?.title || "");
    const metaDescChanged = (editableFields.metaDescription || "") !== getOriginalValue("meta_description", selectedItem.seo?.description || "");

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
  selectedItem: any,
  currentLanguage: string,
  primaryLocale: string,
  contentType: 'pages' | 'blogs' | 'collections' | 'policies' | 'products',
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
      const descKey = contentType === 'policies' ? 'body' : 'body_html';

      const title = contentType !== 'policies'
        ? getTranslatedValue(selectedItem, "title", currentLanguage, "", primaryLocale)
        : "";
      const description = getTranslatedValue(selectedItem, descKey, currentLanguage, "", primaryLocale);
      const handle = getTranslatedValue(selectedItem, "handle", currentLanguage, "", primaryLocale);
      const seoTitle = getTranslatedValue(selectedItem, "meta_title", currentLanguage, "", primaryLocale);
      const metaDescription = getTranslatedValue(selectedItem, "meta_description", currentLanguage, "", primaryLocale);

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
  selectedItem: any,
  key: string,
  currentLanguage: string,
  primaryLocale: string
): boolean {
  if (currentLanguage === primaryLocale) return true;
  if (!selectedItem) return false;

  const translations = selectedItem.translations || [];

  const translation = translations.find(
    (t: any) => t.key === key && t.locale === currentLanguage
  );

  return !!translation && !!translation.value;
}

/**
 * Check if primary locale has any missing content
 */
export function hasPrimaryContentMissing(
  selectedItem: any,
  contentType: 'pages' | 'blogs' | 'collections' | 'policies' | 'products'
): boolean {
  if (!selectedItem) return false;

  // Check required fields based on content type
  if (contentType === 'products') {
    const titleMissing = !selectedItem.title || (typeof selectedItem.title === 'string' && selectedItem.title.trim() === '');
    const descriptionMissing = !selectedItem.descriptionHtml || (typeof selectedItem.descriptionHtml === 'string' && selectedItem.descriptionHtml.trim() === '');
    const handleMissing = !selectedItem.handle || (typeof selectedItem.handle === 'string' && selectedItem.handle.trim() === '');
    const seoTitleMissing = !selectedItem.seo?.title || (typeof selectedItem.seo.title === 'string' && selectedItem.seo.title.trim() === '');
    const seoDescriptionMissing = !selectedItem.seo?.description || (typeof selectedItem.seo.description === 'string' && selectedItem.seo.description.trim() === '');
    return titleMissing || descriptionMissing || handleMissing || seoTitleMissing || seoDescriptionMissing;
  }

  if (contentType === 'collections') {
    const titleMissing = !selectedItem.title || (typeof selectedItem.title === 'string' && selectedItem.title.trim() === '');
    const descriptionMissing = !selectedItem.descriptionHtml || (typeof selectedItem.descriptionHtml === 'string' && selectedItem.descriptionHtml.trim() === '');
    const handleMissing = !selectedItem.handle || (typeof selectedItem.handle === 'string' && selectedItem.handle.trim() === '');
    const seoTitleMissing = !selectedItem.seo?.title || (typeof selectedItem.seo.title === 'string' && selectedItem.seo.title.trim() === '');
    const seoDescriptionMissing = !selectedItem.seo?.description || (typeof selectedItem.seo.description === 'string' && selectedItem.seo.description.trim() === '');
    return titleMissing || descriptionMissing || handleMissing || seoTitleMissing || seoDescriptionMissing;
  }

  const titleMissing = contentType !== 'policies' && !selectedItem.title;
  const bodyMissing = !selectedItem.body;
  const handleMissing = contentType !== 'policies' && !selectedItem.handle;

  return titleMissing || bodyMissing || handleMissing;
}

/**
 * Check if a specific locale has missing translations
 * Only marks a field as missing if the primary locale has content for that field
 */
export function hasLocaleMissingTranslations(
  selectedItem: any,
  locale: string,
  primaryLocale: string,
  contentType: 'pages' | 'blogs' | 'collections' | 'policies' | 'products'
): boolean {
  if (!selectedItem || locale === primaryLocale) return false;

  const translations = selectedItem.translations?.filter(
    (t: any) => t.locale === locale
  ) || [];

  // Define required fields based on content type
  let requiredFields: string[] = [];

  if (contentType === 'collections' || contentType === 'products') {
    requiredFields = ["title", "body_html", "handle", "meta_title", "meta_description"];
  } else if (contentType === 'policies') {
    requiredFields = ["body"];
  } else {
    requiredFields = ["title", "body_html", "handle"];
  }

  return requiredFields.some(field => {
    // Check if the primary locale has content for this field
    let primaryHasContent = false;

    if (field === "title") {
      primaryHasContent = !!selectedItem.title && typeof selectedItem.title === 'string' && selectedItem.title.trim() !== '';
    } else if (field === "body_html") {
      if (contentType === 'collections' || contentType === 'products') {
        primaryHasContent = !!selectedItem.descriptionHtml && typeof selectedItem.descriptionHtml === 'string' && selectedItem.descriptionHtml.trim() !== '';
      } else {
        primaryHasContent = !!selectedItem.body && typeof selectedItem.body === 'string' && selectedItem.body.trim() !== '';
      }
    } else if (field === "body") {
      primaryHasContent = !!selectedItem.body && typeof selectedItem.body === 'string' && selectedItem.body.trim() !== '';
    } else if (field === "handle") {
      primaryHasContent = !!selectedItem.handle && typeof selectedItem.handle === 'string' && selectedItem.handle.trim() !== '';
    } else if (field === "meta_title") {
      primaryHasContent = !!selectedItem.seo?.title && typeof selectedItem.seo.title === 'string' && selectedItem.seo.title.trim() !== '';
    } else if (field === "meta_description") {
      primaryHasContent = !!selectedItem.seo?.description && typeof selectedItem.seo.description === 'string' && selectedItem.seo.description.trim() !== '';
    }

    // Only check if translation is missing if primary has content
    if (!primaryHasContent) {
      return false; // Don't mark as missing if primary is empty
    }

    const translation = translations.find((t: any) => t.key === field);
    return !translation || !translation.value || (typeof translation.value === 'string' && translation.value.trim() === '');
  });
}

/**
 * Check if any foreign locale has missing translations
 */
export function hasMissingTranslations(
  selectedItem: any,
  shopLocales: any[],
  contentType: 'pages' | 'blogs' | 'collections' | 'policies' | 'products'
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
  selectedItem: any,
  fieldKey: string,
  shopLocales: any[],
  primaryLocale: string,
  contentType: 'pages' | 'blogs' | 'collections' | 'policies' | 'products'
): boolean {
  if (!selectedItem) return false;

  // First check if primary locale has content for this field
  let primaryHasContent = false;

  if (fieldKey === "title") {
    primaryHasContent = !!selectedItem.title && typeof selectedItem.title === 'string' && selectedItem.title.trim() !== '';
  } else if (fieldKey === "body_html" || fieldKey === "description") {
    if (contentType === 'collections' || contentType === 'products') {
      primaryHasContent = !!selectedItem.descriptionHtml && typeof selectedItem.descriptionHtml === 'string' && selectedItem.descriptionHtml.trim() !== '';
    } else {
      primaryHasContent = !!selectedItem.body && typeof selectedItem.body === 'string' && selectedItem.body.trim() !== '';
    }
  } else if (fieldKey === "body") {
    primaryHasContent = !!selectedItem.body && typeof selectedItem.body === 'string' && selectedItem.body.trim() !== '';
  } else if (fieldKey === "handle") {
    primaryHasContent = !!selectedItem.handle && typeof selectedItem.handle === 'string' && selectedItem.handle.trim() !== '';
  } else if (fieldKey === "meta_title" || fieldKey === "seoTitle") {
    primaryHasContent = !!selectedItem.seo?.title && typeof selectedItem.seo.title === 'string' && selectedItem.seo.title.trim() !== '';
  } else if (fieldKey === "meta_description" || fieldKey === "metaDescription") {
    primaryHasContent = !!selectedItem.seo?.description && typeof selectedItem.seo.description === 'string' && selectedItem.seo.description.trim() !== '';
  }

  // If primary doesn't have content, no translation is expected
  if (!primaryHasContent) {
    return false;
  }

  // Map UI field names to translation keys
  const translationKeyMap: { [key: string]: string } = {
    "title": "title",
    "description": "body_html",
    "body_html": "body_html",
    "body": "body",
    "handle": "handle",
    "seoTitle": "meta_title",
    "meta_title": "meta_title",
    "metaDescription": "meta_description",
    "meta_description": "meta_description",
  };

  const translationKey = translationKeyMap[fieldKey] || fieldKey;

  // Check if any foreign locale is missing this specific translation
  const foreignLocales = shopLocales.filter((l: any) => !l.primary);

  return foreignLocales.some((locale: any) => {
    const translations = selectedItem.translations?.filter(
      (t: any) => t.locale === locale.locale
    ) || [];

    const translation = translations.find((t: any) => t.key === translationKey);
    return !translation || !translation.value || (typeof translation.value === 'string' && translation.value.trim() === '');
  });
}

/**
 * Get button style for locale navigation
 * Shows pulsing border animation when translations are missing
 */
export function getLocaleButtonStyle(
  locale: any,
  selectedItem: any,
  primaryLocale: string,
  contentType: 'pages' | 'blogs' | 'collections' | 'policies' | 'products'
): React.CSSProperties {
  const primaryContentMissing = locale.primary && hasPrimaryContentMissing(selectedItem, contentType);
  const foreignTranslationMissing = !locale.primary && hasLocaleMissingTranslations(selectedItem, locale.locale, primaryLocale, contentType);

  if (primaryContentMissing) {
    // Pulsing border animation (orange) when primary content is missing
    return {
      animation: "pulse 1.5s ease-in-out infinite",
      borderRadius: "8px",
    };
  }

  if (foreignTranslationMissing) {
    // Pulsing border animation (blue) when translations are missing
    return {
      animation: "pulseBlue 1.5s ease-in-out infinite",
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
