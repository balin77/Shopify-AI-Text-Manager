import { useState, useEffect } from "react";
import { Card, BlockStack, Text, InlineStack, Divider, Button, Badge, Box } from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { ToggleSwitch } from "./ToggleSwitch";
import { useI18n } from "../contexts/I18nContext";

const EXTENSION_UID = "55861f03-b391-90ea-8394-b3a6d5b6946b5f566a73";

interface ImageManagerSettings {
  enabled: boolean;
  autoAltText: boolean;
}

interface Props {
  settings: ImageManagerSettings;
  shop: string;
  onHasChangesChange?: (hasChanges: boolean) => void;
  highlightSaveButton?: boolean;
}

export function SettingsImageManagerTab({ settings, shop, onHasChangesChange, highlightSaveButton = false }: Props) {
  const { t } = useI18n();
  const embedUrl = `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${EXTENSION_UID}/variant-gallery-embed`;
  const blockUrl = `https://${shop}/admin/themes/current/editor?template=product&addAppBlockId=${EXTENSION_UID}/variant-gallery&target=mainSection`;
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
          <SaveDiscardButtons
            hasChanges={hasChanges}
            onSave={handleSave}
            onDiscard={handleDiscard}
            saveText={t.common.save}
            discardText={t.content?.discardChanges ?? "Verwerfen"}
            isSavingCurrentItem={fetcher.state !== "idle"}
            highlightSaveButton={highlightSaveButton}
          />
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

        <Divider />

        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">{t.settings.themeSetupTitle}</Text>
          <Text as="p" variant="bodySm" tone="subdued">{t.settings.themeSetupDescription}</Text>

          <Box
            background="bg-surface-secondary"
            borderRadius="200"
            padding="400"
          >
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="center">
                <Text as="p" variant="bodyMd" fontWeight="semibold">{t.settings.themeSetupOptionATitle}</Text>
                <Badge tone="success">Recommended</Badge>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">{t.settings.themeSetupOptionADescription}</Text>
              <div>
                <Button url={embedUrl} external variant="primary" size="slim">
                  {t.settings.themeSetupOptionAButton}
                </Button>
              </div>
            </BlockStack>
          </Box>

          <Box
            background="bg-surface-secondary"
            borderRadius="200"
            padding="400"
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">{t.settings.themeSetupOptionBTitle}</Text>
              <Text as="p" variant="bodySm" tone="subdued">{t.settings.themeSetupOptionBDescription}</Text>
              <div>
                <Button url={blockUrl} external variant="secondary" size="slim">
                  {t.settings.themeSetupOptionBButton}
                </Button>
              </div>
            </BlockStack>
          </Box>

          <Text as="p" variant="bodySm" tone="subdued">
            {t.settings.themeSetupNote}
          </Text>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}
