import { Button } from "@shopify/polaris";
import { getLocaleButtonStyle } from "../utils/contentEditor.utils";

interface LocaleNavigationButtonsProps {
  shopLocales: any[];
  currentLanguage: string;
  primaryLocaleSuffix: string;
  selectedItem: any;
  primaryLocale: string;
  contentType: 'pages' | 'blogs' | 'collections' | 'policies' | 'products';
  hasChanges: boolean;
  onLanguageChange: (locale: string) => void;
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
}: LocaleNavigationButtonsProps) {
  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
      {shopLocales.map((locale: any) => {
        const buttonStyle = getLocaleButtonStyle(
          locale,
          selectedItem,
          primaryLocale,
          contentType
        );

        return (
          <div key={locale.locale} style={buttonStyle}>
            <Button
              variant={currentLanguage === locale.locale ? "primary" : undefined}
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
