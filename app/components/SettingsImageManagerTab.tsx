import { useState, useEffect } from "react";
import { Card, BlockStack, Text, InlineStack, Divider } from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import { SaveDiscardButtons } from "./SaveDiscardButtons";

interface ImageManagerSettings {
  enabled: boolean;
  autoAltText: boolean;
}

interface Props {
  settings: ImageManagerSettings;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export function SettingsImageManagerTab({ settings, onHasChangesChange }: Props) {
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
          <Text as="h2" variant="headingMd">Image Manager</Text>
          <div style={{ marginLeft: "auto" }}>
            <SaveDiscardButtons
              hasChanges={hasChanges}
              onSave={handleSave}
              onDiscard={handleDiscard}
              saveText="Speichern"
              discardText="Verwerfen"
              isSavingCurrentItem={fetcher.state !== "idle"}
            />
          </div>
        </InlineStack>

        <Text as="p" variant="bodySm" tone="subdued">
          Einstellungen für den Variant Image Manager (Pro & Max).
        </Text>

        <Divider />

        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">Advanced Image Manager aktivieren</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Ersetzt die Standard-Bildgalerie durch den erweiterten Variant Image Manager.
            </Text>
          </BlockStack>
          <label style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
          </label>
        </InlineStack>

        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">Alt-Text bei Upload automatisch generieren</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Nach dem Hochladen wird automatisch ein Alt-Text aus den zugehörigen Varianten-SKUs erstellt.
            </Text>
          </BlockStack>
          <label style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={autoAltText}
              onChange={e => setAutoAltText(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
          </label>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
