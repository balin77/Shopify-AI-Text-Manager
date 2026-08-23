import { useState, useEffect } from "react";
import { Card, BlockStack, Text, InlineStack, Divider, Banner } from "@shopify/polaris";
import { useFetcher } from "react-router";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { ToggleSwitch } from "./ToggleSwitch";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";

interface ImageManagerSettings {
  enabled: boolean;
  autoAltText: boolean;
}

interface Props {
  settings: ImageManagerSettings;
  shop: string;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export function SettingsImageManagerTab({ settings, onHasChangesChange }: Props) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [autoAltText, setAutoAltText] = useState(settings.autoAltText);
  const [committed, setCommitted] = useState({ enabled: settings.enabled, autoAltText: settings.autoAltText });
  const fetcher = useFetcher<{ success?: boolean; settings?: { enabled: boolean; autoAltText: boolean }; error?: string }>();
  const { showInfoBox } = useInfoBox();
  const [saveError, setSaveError] = useState<string | null>(null);

  const hasChanges = enabled !== committed.enabled || autoAltText !== committed.autoAltText;

  useEffect(() => {
    onHasChangesChange?.(hasChanges);
  }, [hasChanges, onHasChangesChange]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const data = fetcher.data;
    if (data.success && data.settings != null) {
      setCommitted({ enabled: data.settings.enabled, autoAltText: data.settings.autoAltText });
      setSaveError(null);
    } else if (data.success === false) {
      // Previously errors here were silently swallowed — no banner, no toast,
      // just the unsaved local state. Surface both inline and in the global
      // toast so the merchant can't miss it. Use an i18n string instead of
      // data.error — the server-side message is English-only and can leak
      // backend wording (e.g. raw Prisma errors).
      const msg = (t.settings as unknown as Record<string, string>)?.imageManagerSaveError
        || t.products?.saveFailed
        || "Save failed";
      setSaveError(msg);
      showInfoBox(msg, "critical");
    }
  }, [fetcher.state, fetcher.data, showInfoBox, t]);

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

        {saveError && (
          <Banner tone="critical" title={t.products?.saveFailed || "Save failed"} onDismiss={() => setSaveError(null)}>
            <Text as="p" variant="bodySm">{saveError}</Text>
          </Banner>
        )}

        <Divider />

        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <ToggleSwitch checked={enabled} onChange={setEnabled} />
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">{t.settings.imageManagerEnabled}</Text>
            <Text as="p" variant="bodySm" tone="subdued">{t.settings.imageManagerEnabledDescription}</Text>
          </BlockStack>
        </InlineStack>

        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <ToggleSwitch checked={autoAltText} onChange={setAutoAltText} />
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">{t.settings.imageManagerAutoAltText}</Text>
            <Text as="p" variant="bodySm" tone="subdued">{t.settings.imageManagerAutoAltTextDescription}</Text>
          </BlockStack>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
