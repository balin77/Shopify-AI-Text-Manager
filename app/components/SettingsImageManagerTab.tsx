import { useState } from "react";
import { Card, BlockStack, Text, InlineStack, Button, Divider } from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";

interface ImageManagerSettings {
  firstImageBig: boolean;
  showAltTags: boolean;
  autoAltText: boolean;
}

interface Props {
  settings: ImageManagerSettings;
}

export function SettingsImageManagerTab({ settings }: Props) {
  const [firstImageBig, setFirstImageBig] = useState(settings.firstImageBig);
  const [showAltTags, setShowAltTags] = useState(settings.showAltTags);
  const [autoAltText, setAutoAltText] = useState(settings.autoAltText);
  const fetcher = useFetcher();
  const isSaving = fetcher.state !== "idle";
  const saved = fetcher.state === "idle" && fetcher.data != null;

  const handleSave = () => {
    fetcher.submit(
      JSON.stringify({ firstImageBig, showAltTags, autoAltText }),
      { method: "post", action: "/api/image-manager-settings", encType: "application/json" }
    );
  };

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">Image Manager</Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Einstellungen für den Variant Image Manager (Pro & Max).
        </Text>

        <Divider />

        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">Erstes Bild groß anzeigen</Text>
            <Text as="p" variant="bodySm" tone="subdued">Das erste Produktbild wird größer als die anderen dargestellt.</Text>
          </BlockStack>
          <label style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={firstImageBig}
              onChange={e => setFirstImageBig(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
          </label>
        </InlineStack>

        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">SKU-Alt-Text-Tags anzeigen</Text>
            <Text as="p" variant="bodySm" tone="subdued">Zeigt die aus SKUs generierten Alt-Texte direkt in der Galerie an.</Text>
          </BlockStack>
          <label style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showAltTags}
              onChange={e => setShowAltTags(e.target.checked)}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
          </label>
        </InlineStack>

        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">Alt-Text bei Upload automatisch generieren</Text>
            <Text as="p" variant="bodySm" tone="subdued">Nach dem Hochladen wird automatisch ein Alt-Text aus den zugehörigen Varianten-SKUs erstellt.</Text>
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

        <Button variant="primary" onClick={handleSave} loading={isSaving}>
          {saved ? "Gespeichert ✓" : "Speichern"}
        </Button>
      </BlockStack>
    </Card>
  );
}
