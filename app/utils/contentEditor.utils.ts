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
  primaryLocale: string,
  loadedTranslations: Record<string, any[]>
): string {
  if (!item || locale === primaryLocale) {
    return fallback;
  }

  // Check loaded translations state
  const itemKey = `${item.id}_${locale}`;
  const translations = loadedTranslations[itemKey] || item.translations || [];

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
  loadedTranslations: Record<string, any[]>,
  editableFields: {
    title: string;
    description: string;
    handle: string;
    seoTitle: string;
    metaDescription: string;
  },
  contentType: 'pages' | 'blogs' | 'collections' | 'policies'
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
      return getTranslatedValue(selectedItem, key, currentLanguage, "", primaryLocale, loadedTranslations);
    };

    const descKey = contentType === 'policies' ? 'body' : 'body_html';
    const descFallback = contentType === 'collections'
      ? (selectedItem.descriptionHtml || "")
      : (selectedItem.body || "");

    // Policies don't have translatable title field
    const titleChanged = contentType !== 'policies'
      ? editableFields.title !== getOriginalValue("title", selectedItem.title)
      : false;

    const descChanged = editableFields.description !== getOriginalValue(descKey, descFallback || "");
    const handleChanged = editableFields.handle !== getOriginalValue("handle", selectedItem.handle || "");
    const seoTitleChanged = editableFields.seoTitle !== getOriginalValue("meta_title", selectedItem.seo?.title || "");
    const metaDescChanged = editableFields.metaDescription !== getOriginalValue("meta_description", selectedItem.seo?.description || "");

    setHasChanges(titleChanged || descChanged || handleChanged || seoTitleChanged || metaDescChanged);
  }, [
    editableFields.title,
    editableFields.description,
    editableFields.handle,
    editableFields.seoTitle,
    editableFields.metaDescription,
    selectedItem,
    currentLanguage,
    contentType,
    primaryLocale,
    loadedTranslations
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
  loadedTranslations: Record<string, any[]>,
  contentType: 'pages' | 'blogs' | 'collections' | 'policies',
  setEditableFields: (fields: {
    title: string;
    description: string;
    handle: string;
    seoTitle: string;
    metaDescription: string;
  }) => void,
  fetcher: any,
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
      // Load translation data
      const itemKey = `${selectedItem.id}_${currentLanguage}`;
      const hasTranslations = contentType === 'policies'
        ? loadedTranslations[itemKey]
        : (loadedTranslations[itemKey] || selectedItem.translations?.some(
            (t: any) => t.locale === currentLanguage
          ));

      if (!hasTranslations) {
        // Load translations from server
        fetcher.submit(
          {
            action: "loadTranslations",
            itemId: selectedItem.id,
            locale: currentLanguage,
            contentType: contentType,
          },
          { method: "POST" }
        );
      } else {
        // Translations already loaded
        const descKey = contentType === 'policies' ? 'body' : 'body_html';

        const title = contentType !== 'policies'
          ? getTranslatedValue(selectedItem, "title", currentLanguage, "", primaryLocale, loadedTranslations)
          : "";
        const description = getTranslatedValue(selectedItem, descKey, currentLanguage, "", primaryLocale, loadedTranslations);
        const handle = getTranslatedValue(selectedItem, "handle", currentLanguage, "", primaryLocale, loadedTranslations);
        const seoTitle = getTranslatedValue(selectedItem, "meta_title", currentLanguage, "", primaryLocale, loadedTranslations);
        const metaDescription = getTranslatedValue(selectedItem, "meta_description", currentLanguage, "", primaryLocale, loadedTranslations);

        setEditableFields({
          title,
          description,
          handle,
          seoTitle,
          metaDescription
        });
      }
    }
  }, [selectedItemId, currentLanguage, loadedTranslations, selectedItem, contentType, primaryLocale]);
}

/**
 * Check if field is translated
 */
export function isFieldTranslated(
  selectedItem: any,
  key: string,
  currentLanguage: string,
  primaryLocale: string,
  loadedTranslations: Record<string, any[]>
): boolean {
  if (currentLanguage === primaryLocale) return true;
  if (!selectedItem) return false;

  const itemKey = `${selectedItem.id}_${currentLanguage}`;
  const translations = loadedTranslations[itemKey] || selectedItem.translations || [];

  const translation = translations.find(
    (t: any) => t.key === key && t.locale === currentLanguage
  );

  return !!translation && !!translation.value;
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
      transform: scale(1);
    }
    50% {
      box-shadow: 0 0 20px 10px rgba(255, 149, 0, 0.3);
      transform: scale(1.05);
    }
  }
`;
