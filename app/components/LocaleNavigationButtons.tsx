import { Button } from "@shopify/polaris";
import { getLocaleButtonStyle } from "../utils/contentEditor.utils";
import { ReloadButton } from "./ReloadButton";

interface LocaleNavigationButtonsProps {
  shopLocales: any[];
  currentLanguage: string;
  primaryLocaleSuffix: string;
  selectedItem: any;
  primaryLocale: string;
  contentType: 'pages' | 'blogs' | 'collections' | 'policies' | 'products';
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
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {shopLocales.map((locale: any) => {
          const buttonStyle = getLocaleButtonStyle(
            locale,
            selectedItem,
            primaryLocale,
            contentType
          );

          const isEnabled = !enabledLanguages || enabledLanguages.includes(locale.locale);
          const isPrimary = locale.primary;

          return (
            <div key={locale.locale} style={buttonStyle}>
              <Button
                variant={currentLanguage === locale.locale ? "primary" : undefined}
                onClick={(event: any) => {
                  // Ctrl+Click toggles language activation (except for primary locale)
                  if (event.ctrlKey && onToggleLanguage && !isPrimary) {
                    onToggleLanguage(locale.locale);
                  } else {
                    onLanguageChange(locale.locale);
                  }
                }}
                size="slim"
                disabled={!isEnabled && !isPrimary}
                tone={!isEnabled && !isPrimary ? "critical" : undefined}
              >
                {locale.name} {locale.primary && `(${primaryLocaleSuffix})`}
              </Button>
            </div>
          );
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
