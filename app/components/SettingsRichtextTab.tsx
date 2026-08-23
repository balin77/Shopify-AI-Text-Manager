import { useState, useEffect } from "react";
import type { FetcherWithComponents } from "react-router";
import {
  Card,
  Text,
  BlockStack,
  Banner,
  InlineStack,
  ChoiceList,
} from "@shopify/polaris";
import { SaveDiscardButtons } from "./SaveDiscardButtons";

interface Settings {
  themeRichtextMode: string;
}

interface SettingsRichtextTabProps {
  settings: Settings;
  fetcher: FetcherWithComponents<any>;
  t: any;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

const VALID_MODES = ["autofix", "normalize", "error"] as const;

export function SettingsRichtextTab({
  settings,
  fetcher,
  t,
  onHasChangesChange,
}: SettingsRichtextTabProps) {
  const initial = VALID_MODES.includes(settings.themeRichtextMode as (typeof VALID_MODES)[number])
    ? settings.themeRichtextMode
    : "autofix";
  const [mode, setMode] = useState<string>(initial);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    const changed = mode !== initial;
    setHasChanges(changed);
    if (onHasChangesChange) onHasChangesChange(changed);
  }, [mode, initial, onHasChangesChange]);

  const handleSave = () => {
    if (!hasChanges) return;
    fetcher.submit(
      { actionType: "saveRichtextMode", themeRichtextMode: mode },
      { method: "POST" }
    );
  };

  const handleDiscard = () => setMode(initial);

  const s = t.settings || {};

  return (
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingLg">
            {s.richtextFormatting || "Rich-text formatting"}
          </Text>
          <SaveDiscardButtons
            hasChanges={hasChanges}
            onSave={handleSave}
            onDiscard={handleDiscard}
            saveText={t.products?.saveChanges || "Speichern"}
            discardText={t.content?.discardChanges || "Verwerfen"}
            action="saveRichtextMode"
            fetcherState={fetcher.state}
            fetcherFormData={fetcher.formData}
          />
        </InlineStack>

        <Text as="p" variant="bodyMd" tone="subdued">
          {s.richtextFormattingDescription ||
            "Some theme settings (e.g. the Brand information description) are rich-text fields. Shopify requires every paragraph to be wrapped in a block tag such as <p>. Choose how the app should handle content that does not follow this rule when you save the primary language."}
        </Text>

        <ChoiceList
          title={s.richtextModeTitle || "Behaviour on save"}
          titleHidden
          selected={[mode]}
          onChange={(selected) => setMode(selected[0])}
          choices={[
            {
              label: s.richtextModeAutofix || "Fix automatically only when needed (recommended)",
              value: "autofix",
              helpText:
                s.richtextModeAutofixHelp ||
                "Save your content as-is. Only if Shopify rejects it, the app reformats that field (wrapping lines in paragraphs) and saves again.",
            },
            {
              label: s.richtextModeNormalize || "Always reformat rich-text before saving",
              value: "normalize",
              helpText:
                s.richtextModeNormalizeHelp ||
                "Every rich-text theme setting is reformatted to valid paragraphs before it is sent to Shopify. No second attempt is needed.",
            },
            {
              label: s.richtextModeError || "Never change my content, just warn me",
              value: "error",
              helpText:
                s.richtextModeErrorHelp ||
                "The app never rewrites your HTML. If Shopify rejects the format, you get a clear message so you can fix it yourself.",
            },
          ]}
        />

        <Banner tone="info">
          <Text as="p" variant="bodySm">
            {s.richtextFormattingNote ||
              "This only affects theme settings that Shopify treats as rich text. Product, collection and page descriptions are unaffected."}
          </Text>
        </Banner>
      </BlockStack>
    </Card>
  );
}
