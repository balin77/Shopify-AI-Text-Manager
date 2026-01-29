/**
 * UnifiedLanguageBar - Advanced language navigation with translation features
 *
 * Combines the best features from both systems:
 * - Language switching with visual indicators
 * - Translate All button (from products page)
 * - Ctrl+Click to enable/disable languages
 * - ReloadButton integration
 * - Color-coded translation status
 * - Responsive layout
 *
 * Used by: Products, Collections, Pages, Blogs, Articles, Policies, etc.
 */

import { useRef } from "react";
import { Button, InlineStack, ButtonGroup } from "@shopify/polaris";
import { useLocaleButtonStyle } from "../../utils/contentEditor.utils";
import { ReloadButton } from "../ReloadButton";
import { HelpTooltip } from "../HelpTooltip";
import type { ShopLocale, TranslatableItem, ContentType } from "../../types/contentEditor.types";

interface UnifiedLanguageBarProps {
  /** Shop locales from Shopify */
  shopLocales: ShopLocale[];

  /** Currently selected language */
  currentLanguage: string;

  /** Primary locale (e.g., "de") */
  primaryLocale: string;

  /** Currently selected item */
  selectedItem: TranslatableItem | null;

  /** Content type for translation status */
  contentType: ContentType;

  /** Whether there are unsaved changes */
  hasChanges: boolean;

  /** Callback when language changes */
  onLanguageChange: (locale: string) => void;

  /** Optional: Array of enabled languages */
  enabledLanguages?: string[];

  /** Optional: Callback to toggle language on/off (Ctrl+Click) */
  onToggleLanguage?: (locale: string) => void;

  /** Optional: Callback for "Translate All" button */
  onTranslateAll?: () => void;

  /** Optional: Whether translation is in progress */
  isTranslating?: boolean;

  /** Optional: Show Translate All button (default: true for primary locale) */
  showTranslateAll?: boolean;

  /** Optional: Show Reload button (default: true) */
  showReloadButton?: boolean;

  /** Optional: Whether data is currently loading (suppresses blinking) */
  isLoadingData?: boolean;

  /** Translation strings */
  t?: {
    primaryLocaleSuffix?: string;
    translateAll?: string;
    translating?: string;
  };
}

export function UnifiedLanguageBar({
  shopLocales,
  currentLanguage,
  primaryLocale,
  selectedItem,
  contentType,
  hasChanges,
  onLanguageChange,
  enabledLanguages,
  onToggleLanguage,
  onTranslateAll,
  isTranslating = false,
  showTranslateAll = true,
  showReloadButton = true,
  isLoadingData = false,
  t = {},
}: UnifiedLanguageBarProps) {
  const isPrimaryLocale = currentLanguage === primaryLocale;
  const ctrlPressedRef = useRef<Record<string, boolean>>({});

  // Map content type to resource type for the API
  const resourceTypeMap: Record<string, string> = {
    blogs: "article",
    pages: "page",
    policies: "policy",
    collections: "collection",
    products: "product",
  };
  const resourceType = resourceTypeMap[contentType] || contentType;

  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", flex: 1, minWidth: 0, alignItems: "center" }}>
      <HelpTooltip helpKey="ctrlClickLanguage" position="below" />
      {shopLocales.map((locale) => {
        const buttonStyle = useLocaleButtonStyle(
          locale,
          selectedItem,
          primaryLocale,
          contentType,
          isLoadingData
        );

        const isEnabled = !enabledLanguages || enabledLanguages.includes(locale.locale);
        const isPrimary = locale.primary;
        const isCurrentLanguage = currentLanguage === locale.locale;

        return (
          <div key={locale.locale} style={buttonStyle}>
            <Button
              variant={isCurrentLanguage ? "primary" : undefined}
              onClick={() => {
                // Don't navigate if Ctrl was pressed - that's for toggling language mode
                if (ctrlPressedRef.current[locale.locale]) {
                  ctrlPressedRef.current[locale.locale] = false;
                  return;
                }
                onLanguageChange(locale.locale);
              }}
              onPointerDown={(event: React.PointerEvent) => {
                // Ctrl+Click toggles language activation (except for primary locale)
                if (event.ctrlKey && onToggleLanguage && !isPrimary) {
                  ctrlPressedRef.current[locale.locale] = true;
                  event.preventDefault();
                  onToggleLanguage(locale.locale);
                }
              }}
              size="slim"
              tone={!isEnabled && !isPrimary ? "critical" : undefined}
            >
              {locale.name || locale.locale} {locale.primary ? `(${t.primaryLocaleSuffix || "Primary"})` : ""}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
