import { Button } from "@shopify/polaris";
import { useLocaleButtonStyle } from "../utils/contentEditor.utils";
import type { ShopLocale, TranslatableItem, ContentType } from "../types/contentEditor.types";
import { ReloadButton } from "./ReloadButton";
import { HelpTooltip } from "./HelpTooltip";

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
}: LocaleNavigationButtonsProps) {
  // Map content type to resource type for the API
  const resourceType = contentType === 'blogs' ? 'article' : contentType === 'pages' ? 'page' : contentType === 'policies' ? 'policy' : contentType;

  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <HelpTooltip helpKey="ctrlClickLanguage" position="below" />
        {shopLocales.map((locale) => {
          const LocaleButton = () => {
            const buttonStyle = useLocaleButtonStyle(
              locale,
              selectedItem,
              primaryLocale,
              contentType
            );

            const isEnabled = !enabledLanguages || enabledLanguages.includes(locale.locale);
            const isPrimary = locale.primary;
            const isCurrentLanguage = currentLanguage === locale.locale;

            return (
              <div key={locale.locale} style={buttonStyle}>
                <Button
                  variant={isCurrentLanguage ? "primary" : undefined}
                  onClick={(event: any) => {
                    // Don't navigate if Ctrl is pressed - that's for toggling language mode
                    if (event.ctrlKey) {
                      return;
                    }
                    onLanguageChange(locale.locale);
                  }}
                  onPointerDown={(event: any) => {
                    // Ctrl+Click toggles language activation (except for primary locale)
                    if (event.ctrlKey && onToggleLanguage && !isPrimary) {
                      event.preventDefault();
                      onToggleLanguage(locale.locale);
                    }
                  }}
                  size="slim"
                  tone={!isEnabled && !isPrimary ? "critical" : undefined}
                >
                  {locale.name || locale.locale} {locale.primary ? `(${primaryLocaleSuffix})` : ''}
                </Button>
              </div>
            );
          };

          return <LocaleButton key={locale.locale} />;
        })}
      </div>

      {/* Reload Button - rechts neben den Sprachen */}
      {selectedItem && (
        <ReloadButton
          resourceId={selectedItem.id}
          resourceType={resourceType as any}
          locale={currentLanguage}
        />
      )}
    </div>
  );
}
