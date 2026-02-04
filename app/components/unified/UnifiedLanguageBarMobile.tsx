/**
 * UnifiedLanguageBarMobile - Compact dropdown for language selection on mobile
 *
 * Features:
 * - Compact dropdown button showing current language
 * - Expandable list of all available languages
 * - Translation status indicators
 * - Ctrl+Click to enable/disable languages
 */

import { useState, useRef } from "react";
import { Card, Button, BlockStack, InlineStack, Text, Icon } from "@shopify/polaris";
import { ChevronDownIcon, ChevronUpIcon } from "@shopify/polaris-icons";
import { useLocaleButtonStyle } from "../../utils/contentEditor.utils";
import type { ShopLocale, TranslatableItem, ContentType } from "../../types/contentEditor.types";

interface UnifiedLanguageBarMobileProps {
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

  /** Optional: Whether data is currently loading (suppresses blinking) */
  isLoadingData?: boolean;

  /** Translation strings */
  t?: {
    primaryLocaleSuffix?: string;
    selectLanguage?: string;
  };
}

export function UnifiedLanguageBarMobile({
  shopLocales,
  currentLanguage,
  primaryLocale,
  selectedItem,
  contentType,
  hasChanges,
  onLanguageChange,
  enabledLanguages,
  onToggleLanguage,
  isLoadingData = false,
  t = {},
}: UnifiedLanguageBarMobileProps) {
  // IMPORTANT: Always call hooks in the same order - no conditional hooks!
  const [isExpanded, setIsExpanded] = useState(false);
  const ctrlPressedRef = useRef<Record<string, boolean>>({});

  // Call useLocaleButtonStyle for all locales to ensure consistent hook calls
  const buttonStyles = shopLocales.map((locale) =>
    useLocaleButtonStyle(
      locale,
      selectedItem,
      primaryLocale,
      contentType,
      isLoadingData
    )
  );

  // Find current locale object
  const currentLocale = shopLocales.find((l) => l.locale === currentLanguage);
  const currentLocaleName = currentLocale?.name || currentLanguage;
  const isPrimaryLocale = currentLanguage === primaryLocale;

  return (
    <div className="language-dropdown-mobile">
      {/* Collapsed: Show current language */}
      <Card padding="0">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            width: "100%",
            padding: "0.75rem",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <InlineStack align="space-between" blockAlign="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {currentLocaleName}
              {isPrimaryLocale && ` (${t.primaryLocaleSuffix || "Primary"})`}
            </Text>
            <Icon source={isExpanded ? ChevronUpIcon : ChevronDownIcon} />
          </InlineStack>
        </button>
      </Card>

      {/* Expanded: Show all languages */}
      {isExpanded && (
        <Card padding="300">
          <BlockStack gap="200">
            {shopLocales.map((locale, index) => {
              // Use pre-calculated button styles to avoid conditional hook calls
              const buttonStyle = buttonStyles[index];

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
                      setIsExpanded(false); // Close dropdown after selection
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
                    fullWidth
                  >
                    {locale.name || locale.locale} {locale.primary ? `(${t.primaryLocaleSuffix || "Primary"})` : ""}
                  </Button>
                </div>
              );
            })}
          </BlockStack>
        </Card>
      )}
    </div>
  );
}
