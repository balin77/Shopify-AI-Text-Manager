import { useState, useEffect } from "react";
import { Card, BlockStack, Text, InlineStack, Divider } from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { ToggleSwitch } from "./ToggleSwitch";
import { useI18n } from "../contexts/I18nContext";

interface ImageManagerSettings {
  enabled: boolean;
  autoAltText: boolean;
}

interface Props {
  settings: ImageManagerSettings;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export function SettingsImageManagerTab({ settings, onHasChangesChange }: Props) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [autoAltText, setAutoAltText] = useState(settings.autoAltText);
  const [committed, setCommitted] = useState({ enabled: settings.enabled, autoAltText: settings.autoAltText });
  const fetcher = useFetcher<{ settings: { enabled: boolean; autoAltText: boolean } }>();

  const hasChanges = enabled !== committed.enabled || autoAltText !== committed.autoAltText;

  useEffect(() => {
    onHasChangesChange?.(hasChanges);
  }, [hasChanges, onHasChangesChange]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.settings != null) {
      setCommitted({ enabled: fetcher.data.settings.enabled, autoAltText: fetcher.data.settings.autoAltText });
    }
  }, [fetcher.state, fetcher.data]);

  const handleSave = () => {
    fetcher.submit(
      JSON.stringify({ enabled, autoAltText }),
      { method: "post", action: "/api/image-manager-settings", encType: "application/json" }
    );
  };

  const handleDiscard = () => {
    setEnabled(committed.enabled);
    setAutoAltText(committed.autoAltText);
  };

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingMd">{t.settings.imageManagerTitle}</Text>
          <div style={{ marginLeft: "auto" }}>
            <SaveDiscardButtons
              hasChanges={hasChanges}
              onSave={handleSave}
              onDiscard={handleDiscard}
              saveText={t.common.save}
              discardText={t.content?.discardChanges ?? "Verwerfen"}
              isSavingCurrentItem={fetcher.state !== "idle"}
            />
          </div>
        </InlineStack>

        <Text as="p" variant="bodySm" tone="subdued">
          {t.settings.imageManagerDescription}
        </Text>

        <Divider />

        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">{t.settings.imageManagerEnabled}</Text>
            <Text as="p" variant="bodySm" tone="subdued">{t.settings.imageManagerEnabledDescription}</Text>
          </BlockStack>
          <ToggleSwitch checked={enabled} onChange={setEnabled} />
        </InlineStack>

        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">{t.settings.imageManagerAutoAltText}</Text>
            <Text as="p" variant="bodySm" tone="subdued">{t.settings.imageManagerAutoAltTextDescription}</Text>
          </BlockStack>
          <ToggleSwitch checked={autoAltText} onChange={setAutoAltText} />
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
