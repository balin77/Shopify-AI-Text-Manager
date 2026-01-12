import { Button } from "@shopify/polaris";
import { getLocaleButtonStyle } from "../utils/contentEditor.utils";

interface LocaleNavigationButtonsProps {
  shopLocales: any[];
  currentLanguage: string;
  primaryLocaleSuffix: string;
  selectedItem: any;
  primaryLocale: string;
  loadedTranslations: Record<string, any[]>;
  contentType: 'pages' | 'blogs' | 'collections' | 'policies';
  hasChanges: boolean;
  onLanguageChange: (locale: string) => void;
}

export function LocaleNavigationButtons({
  shopLocales,
  currentLanguage,
  primaryLocaleSuffix,
  selectedItem,
  primaryLocale,
  loadedTranslations,
  contentType,
  hasChanges,
  onLanguageChange,
}: LocaleNavigationButtonsProps) {
  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
      {shopLocales.map((locale: any) => {
        const isSelected = currentLanguage === locale.locale;
        const buttonStyle = getLocaleButtonStyle(
          locale,
          selectedItem,
          primaryLocale,
          loadedTranslations,
          contentType,
          isSelected
        );

        return (
          <div key={locale.locale} style={buttonStyle}>
            <Button
              variant={isSelected ? "primary" : undefined}
              onClick={() => onLanguageChange(locale.locale)}
              size="slim"
            >
              {locale.name} {locale.primary && `(${primaryLocaleSuffix})`}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
