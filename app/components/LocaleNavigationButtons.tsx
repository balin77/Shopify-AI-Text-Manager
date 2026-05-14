import { useRef } from "react";
import { Button, Tooltip } from "@shopify/polaris";
import { useLocaleButtonStyle, getLocaleButtonTooltip, getLocalizedLanguageName } from "../utils/contentEditor.utils";
import type { ValidationOverlays } from "../utils/contentEditor.utils";
import type { ShopLocale, TranslatableItem, ContentType } from "../types/content-editor.types";
import { ReloadButton } from "./ReloadButton";
import { HelpTooltip } from "./HelpTooltip";
import { useI18n } from "../contexts/I18nContext";

interface LocaleNavigationButtonsProps {
  shopLocales: ShopLocale[];
  currentLanguage: string;
  primaryLocaleSuffix: string;
  selectedItem: TranslatableItem | null;
  primaryLocale: string;
  contentType: ContentType;
  hasChanges: boolean;
  onLanguageChange: (locale: string) => void;
  enabledLanguages?: string[];
  onToggleLanguage?: (locale: string) => void;
  isLoadingData?: boolean;
  validationOverlays?: ValidationOverlays;
  validationVersion?: number;
}

export function LocaleNavigationButtons({
  shopLocales,
  currentLanguage,
  primaryLocaleSuffix,
  selectedItem,
  primaryLocale,
  contentType,
  hasChanges,
  onLanguageChange,
  enabledLanguages,
  onToggleLanguage,
  isLoadingData = false,
  validationOverlays,
  validationVersion,
}: LocaleNavigationButtonsProps) {
  const { t: i18n, locale: appLocale } = useI18n();
  const tooltipI18n = {
    missingContent: i18n.common.missingContent,
    missingTranslations: i18n.common.missingTranslations,
    fieldLabels: i18n.common.fieldLabels,
  };

  // Map content type to resource type for the API
  const resourceType = contentType === 'blogs' ? 'article' : contentType === 'pages' ? 'page' : contentType === 'policies' ? 'policy' : contentType;

  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <HelpTooltip helpKey="ctrlClickLanguage" position="below" />
        {shopLocales.map((locale) => {
          const LocaleButton = () => {
            const ctrlPressedRef = useRef(false);
            const buttonStyle = useLocaleButtonStyle(
              locale,
              selectedItem,
              primaryLocale,
              contentType,
              isLoadingData,
              validationOverlays,
              validationVersion
            );

            const tooltip = getLocaleButtonTooltip(locale, selectedItem, primaryLocale, contentType, isLoadingData, tooltipI18n, validationOverlays);

            const isEnabled = !enabledLanguages || enabledLanguages.includes(locale.locale);
            const isPrimary = locale.primary;
            const isCurrentLanguage = currentLanguage === locale.locale;

            const button = (
              <div key={locale.locale} style={buttonStyle}>
                <Button
                  variant={isCurrentLanguage ? "primary" : undefined}
                  onClick={() => {
                    // Don't navigate if Ctrl was pressed - that's for toggling language mode
                    if (ctrlPressedRef.current) {
                      ctrlPressedRef.current = false;
                      return;
                    }
                    onLanguageChange(locale.locale);
                  }}
                  onPointerDown={(event: React.PointerEvent) => {
                    // Ctrl+Click toggles language activation (except for primary locale)
                    if (event.ctrlKey && onToggleLanguage && !isPrimary) {
                      ctrlPressedRef.current = true;
                      event.preventDefault();
                      onToggleLanguage(locale.locale);
                    }
                  }}
                  size="slim"
                  tone={!isEnabled && !isPrimary ? "critical" : undefined}
                >
                  {getLocalizedLanguageName(locale.locale, appLocale, locale.name)} {locale.primary ? `(${primaryLocaleSuffix})` : ''}
                </Button>
              </div>
            );

            if (tooltip) {
              return <Tooltip content={tooltip} dismissOnMouseOut preferredPosition="below">{button}</Tooltip>;
            }
            return button;
          };

          return <LocaleButton key={locale.locale} />;
        })}
      </div>

      {/* Reload Button - rechts neben den Sprachen */}
      {selectedItem && (
        <ReloadButton
          resourceId={selectedItem.id}
          resourceType={resourceType as "product" | "collection" | "article" | "page" | "policy" | "templates"}
          locale={currentLanguage}
        />
      )}
    </div>
  );
}
