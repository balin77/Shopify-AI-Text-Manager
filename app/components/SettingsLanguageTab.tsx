import { useState, useEffect } from "react";
import type { FetcherWithComponents } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
  Button,
  Select,
  InlineStack,
} from "@shopify/polaris";

interface SettingsLanguageTabProps {
  settings: {
    appLanguage: string;
    [key: string]: any;
  };
  fetcher: FetcherWithComponents<any>;
  t: any; // i18n translations
}

export function SettingsLanguageTab({ settings, fetcher, t }: SettingsLanguageTabProps) {
  const APP_LANGUAGES = [
    { label: t.settings.languages.de, value: "de" },
    { label: t.settings.languages.en, value: "en" },
  ];

  const [appLanguage, setAppLanguage] = useState(settings.appLanguage);
  const [languageChanged, setLanguageChanged] = useState(false);

  // Track if language was changed
  useEffect(() => {
    if (appLanguage !== settings.appLanguage) {
      setLanguageChanged(true);
    } else {
      setLanguageChanged(false);
    }
  }, [appLanguage, settings.appLanguage]);

  // Reload page after language change is saved
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success && languageChanged) {
      // Language was saved successfully, navigate to the settings page with a forced reload
      // This ensures the new language is loaded from the server
      const currentUrl = new URL(window.location.href);
      const settingsUrl = `${currentUrl.origin}${currentUrl.pathname}${currentUrl.search}`;
      window.location.href = settingsUrl;
    }
  }, [fetcher.state, fetcher.data, languageChanged]);

  const handleSave = () => {
    if (!languageChanged) return;

    fetcher.submit(
      {
        actionType: "saveSettings",
        // We need to pass all settings, not just appLanguage
        huggingfaceApiKey: settings.huggingfaceApiKey || "",
        geminiApiKey: settings.geminiApiKey || "",
        claudeApiKey: settings.claudeApiKey || "",
        openaiApiKey: settings.openaiApiKey || "",
        grokApiKey: settings.grokApiKey || "",
        deepseekApiKey: settings.deepseekApiKey || "",
        preferredProvider: settings.preferredProvider,
        appLanguage: appLanguage,
        hfMaxTokensPerMinute: String(settings.hfMaxTokensPerMinute || 1000000),
        hfMaxRequestsPerMinute: String(settings.hfMaxRequestsPerMinute || 100),
        geminiMaxTokensPerMinute: String(settings.geminiMaxTokensPerMinute || 1000000),
        geminiMaxRequestsPerMinute: String(settings.geminiMaxRequestsPerMinute || 15),
        claudeMaxTokensPerMinute: String(settings.claudeMaxTokensPerMinute || 40000),
        claudeMaxRequestsPerMinute: String(settings.claudeMaxRequestsPerMinute || 5),
        openaiMaxTokensPerMinute: String(settings.openaiMaxTokensPerMinute || 200000),
        openaiMaxRequestsPerMinute: String(settings.openaiMaxRequestsPerMinute || 500),
        grokMaxTokensPerMinute: String(settings.grokMaxTokensPerMinute || 100000),
        grokMaxRequestsPerMinute: String(settings.grokMaxRequestsPerMinute || 60),
        deepseekMaxTokensPerMinute: String(settings.deepseekMaxTokensPerMinute || 100000),
        deepseekMaxRequestsPerMinute: String(settings.deepseekMaxRequestsPerMinute || 60),
      },
      { method: "POST" }
    );
  };

  return (
    <Card>
      <BlockStack gap="500">
        <Text as="h2" variant="headingLg">
          {t.settings.appLanguage}
        </Text>

        <Text as="p" variant="bodyMd" tone="subdued">
          {t.settings.appLanguageDescription}
        </Text>

        <Select
          label=""
          options={APP_LANGUAGES}
          value={appLanguage}
          onChange={setAppLanguage}
        />

        <InlineStack align="end">
          <Button
            variant={languageChanged ? "primary" : undefined}
            onClick={handleSave}
            disabled={!languageChanged}
            loading={fetcher.state !== "idle"}
          >
            {t.products.saveChanges}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
