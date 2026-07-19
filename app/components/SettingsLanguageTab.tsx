import { useState, useEffect } from "react";
import type { Translation as I18nTranslation } from "~/i18n/de";
import type { FetcherWithComponents } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
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
  t: I18nTranslation;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export function SettingsLanguageTab({ settings, fetcher, t, onHasChangesChange }: SettingsLanguageTabProps) {
  const APP_LANGUAGES = [
    { label: t.settings.languages.de, value: "de" },
    { label: t.settings.languages.en, value: "en" },
    { label: t.settings.languages.es, value: "es" },
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

  // Reload page after language change is saved. The fetcher is SHARED with
  // other settings saves (AI, SEO, instructions), so we must gate on the
  // returned `actionType` — otherwise saving anything else while a stale
  // languageChanged flag is set would nuke the page mid-edit.
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.success &&
      fetcher.data?.actionType === "saveAppLanguage" &&
      languageChanged
    ) {
      const currentUrl = new URL(window.location.href);
      const settingsUrl = `${currentUrl.origin}${currentUrl.pathname}${currentUrl.search}`;
      window.location.href = settingsUrl;
    }
  }, [fetcher.state, fetcher.data, languageChanged]);

  const handleSave = () => {
    if (!languageChanged) return;

    // Narrow submit: action `saveAppLanguage` only touches the appLanguage
    // column. Previously this resent every AI setting from the loader, which
    // could (a) wipe values not in props (selectedModel, SEO suffix) and
    // (b) be blocked by Zod if any *stored* key didn't match the current
    // regex.
    fetcher.submit(
      { actionType: "saveAppLanguage", appLanguage },
      { method: "POST" }
    );
  };

  const handleDiscard = () => {
    setAppLanguage(settings.appLanguage);
  };

  return (
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingLg">
            {t.settings.appLanguage}
          </Text>
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
        </InlineStack>

        <Text as="p" variant="bodyMd" tone="subdued">
          {t.settings.appLanguageDescription}
        </Text>

        <div style={{ maxWidth: "280px" }}>
          <Select
            label=""
            options={APP_LANGUAGES}
            value={appLanguage}
            onChange={setAppLanguage}
          />
        </div>
      </BlockStack>
    </Card>
  );
}
