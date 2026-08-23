import {
  Card,
  Text,
  BlockStack,
  Banner,
  ChoiceList,
} from "@shopify/polaris";
import { useInstantSetting } from "../hooks/useInstantSetting";
import { useInfoBox } from "../contexts/InfoBoxContext";

interface Settings {
  themeRichtextMode: string;
}

interface SettingsRichtextTabProps {
  settings: Settings;
  t: any;
}

const VALID_MODES = ["autofix", "normalize", "error"] as const;

export function SettingsRichtextTab({ settings, t }: SettingsRichtextTabProps) {
  const initial = VALID_MODES.includes(settings.themeRichtextMode as (typeof VALID_MODES)[number])
    ? settings.themeRichtextMode
    : "autofix";

  /**
   * A three-way choice with no text beside it — so it saves itself, like every
   * other switch and picker in Settings
   * ([useInstantSetting.ts](../hooks/useInstantSetting.ts)). This card has no
   * draft state left and therefore no Save button.
   */
  const { showInfoBox } = useInfoBox();
  const richtextMode = useInstantSetting<string>({
    stored: initial,
    submit: (value, f) =>
      f.submit({ actionType: "saveRichtextMode", themeRichtextMode: value }, { method: "POST" }),
    onError: (error) =>
      showInfoBox(
        error || t.settings?.settingSaveFailed || t.products?.saveFailed || "Save failed",
        "critical",
        t.common?.error || "Error",
      ),
  });
  const mode = richtextMode.value;

  const s = t.settings || {};

  return (
    <Card>
      <BlockStack gap="500">
        <Text as="h2" variant="headingLg">
          {s.richtextFormatting || "Rich-text formatting"}
        </Text>

        <Text as="p" variant="bodyMd" tone="subdued">
          {s.richtextFormattingDescription ||
            "Some theme settings (e.g. the Brand information description) are rich-text fields. Shopify requires every paragraph to be wrapped in a block tag such as <p>. Choose how the app should handle content that does not follow this rule when you save the primary language."}
        </Text>

        <ChoiceList
          title={s.richtextModeTitle || "Behaviour on save"}
          titleHidden
          selected={[mode]}
          onChange={(selected) => richtextMode.set(selected[0])}
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
