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
import { SaveDiscardButtons } from "./SaveDiscardButtons";

interface SettingsLanguageTabProps {
  settings: {
    appLanguage: string;
    [key: string]: any;
  };
  fetcher: FetcherWithComponents<any>;
  t: any; // i18n translations
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export function SettingsLanguageTab({ settings, fetcher, t, onHasChangesChange }: SettingsLanguageTabProps) {
  const APP_LANGUAGES = [
    { label: t.settings.languages.de, value: "de" },
    { label: t.settings.languages.en, value: "en" },
  ];

  const [appLanguage, setAppLanguage] = useState(settings.appLanguage);
  const [languageChanged, setLanguageChanged] = useState(false);

  // Track if language was changed
  useEffect(() => {
    const changed = appLanguage !== settings.appLanguage;
    setLanguageChanged(changed);
    if (onHasChangesChange) {
      onHasChangesChange(changed);
    }
  }, [appLanguage, settings.appLanguage, onHasChangesChange]);

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

  const handleDiscard = () => {
    setAppLanguage(settings.appLanguage);
  };

  return (
    <>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="500">
            <InlineStack align="space-between" blockAlign="center" wrap={false}>
              <Text as="h2" variant="headingLg">
                {t.settings.appLanguage}
              </Text>
              {/* Show action buttons inline on mobile only */}
              <div className="settings-action-buttons-mobile" style={{ marginLeft: "auto" }}>
                <SaveDiscardButtons
                  hasChanges={languageChanged}
                  onSave={handleSave}
                  onDiscard={handleDiscard}
                  saveText={t.products.saveChanges}
                  discardText={t.content?.discardChanges || "Verwerfen"}
                  action="saveSettings"
                  fetcherState={fetcher.state}
                  fetcherFormData={fetcher.formData}
                />
              </div>
            </InlineStack>

            <Text as="p" variant="bodyMd" tone="subdued">
              {t.settings.appLanguageDescription}
            </Text>

            <Select
              label=""
              options={APP_LANGUAGES}
              value={appLanguage}
              onChange={setAppLanguage}
            />
          </BlockStack>
        </Card>

        <div className="settings-action-buttons-desktop">
          <Card>
            <SaveDiscardButtons
              hasChanges={languageChanged}
              onSave={handleSave}
              onDiscard={handleDiscard}
              saveText={t.products.saveChanges}
              discardText={t.content?.discardChanges || "Verwerfen"}
              action="saveSettings"
              fetcherState={fetcher.state}
              fetcherFormData={fetcher.formData}
            />
          </Card>
        </div>
      </BlockStack>

      <style>{`
        /* Show action buttons in separate card on desktop (900px+) */
        @media (min-width: 900px) {
          .settings-action-buttons-desktop {
            display: block;
          }
          .settings-action-buttons-mobile {
            display: none;
          }
        }

        /* Show action buttons inline on mobile */
        @media (max-width: 899px) {
          .settings-action-buttons-desktop {
            display: none;
          }
          .settings-action-buttons-mobile {
            display: block;
          }
        }
      `}</style>
    </>
  );
}
