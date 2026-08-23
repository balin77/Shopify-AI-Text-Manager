import type { Translation as I18nTranslation } from "~/i18n/de";
import {
  Card,
  Text,
  BlockStack,
  Select,
} from "@shopify/polaris";
import { useInstantSetting } from "../hooks/useInstantSetting";
import { useInfoBox } from "../contexts/InfoBoxContext";

interface SettingsLanguageTabProps {
  settings: {
    appLanguage: string;
    [key: string]: any;
  };
  t: I18nTranslation;
}

export function SettingsLanguageTab({ settings, t }: SettingsLanguageTabProps) {
  const APP_LANGUAGES = [
    { label: t.settings.languages.de, value: "de" },
    { label: t.settings.languages.en, value: "en" },
    { label: t.settings.languages.es, value: "es" },
  ];

  /**
   * Saves itself, like every other picker in Settings
   * ([useInstantSetting.ts](../hooks/useInstantSetting.ts)) — and then reloads,
   * because the app is rendered in the language this chooses and the choice is
   * invisible until it is.
   */
  const { showInfoBox } = useInfoBox();
  const appLanguageSetting = useInstantSetting<string>({
    stored: settings.appLanguage,
    submit: (value, f) => f.submit({ actionType: "saveAppLanguage", appLanguage: value }, { method: "POST" }),
    onSaved: () => {
      const currentUrl = new URL(window.location.href);
      window.location.href = `${currentUrl.origin}${currentUrl.pathname}${currentUrl.search}`;
    },
    onError: (error) =>
      showInfoBox(
        error || t.settings?.settingSaveFailed || t.products?.saveFailed || "Save failed",
        "critical",
        t.common?.error || "Error",
      ),
  });

  return (
    <Card>
      <BlockStack gap="500">
        <Text as="h2" variant="headingLg">
          {t.settings.appLanguage}
        </Text>

        <Text as="p" variant="bodyMd" tone="subdued">
          {t.settings.appLanguageDescription}
        </Text>

        <div style={{ maxWidth: "280px" }}>
          <Select
            label=""
            options={APP_LANGUAGES}
            value={appLanguageSetting.value}
            onChange={appLanguageSetting.set}
          />
        </div>
      </BlockStack>
    </Card>
  );
}
