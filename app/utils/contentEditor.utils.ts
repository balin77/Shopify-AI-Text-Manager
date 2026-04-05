/**
 * Shared utilities for content editing routes
 * Used by: app.collections.tsx, app.blog.tsx, app.pages.tsx, app.policies.tsx
 */

import type { TranslatableItem } from "~/types/content-editor.types";

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

// Re-exports for backwards compatibility
export { useNavigationGuard } from "../hooks/useNavigationGuard";
export {
  isFieldTranslated,
  hasPrimaryContentMissing,
  hasLocaleMissingTranslations,
  getMissingPrimaryFields,
  getMissingLocaleTranslationFields,
  getLocaleButtonTooltip,
  hasMissingTranslations,
  hasFieldMissingTranslations,
  getLocaleButtonStyle,
  useLocaleButtonStyle,
} from "./field-validation.utils";
