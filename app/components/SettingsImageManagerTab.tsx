import { useState, useEffect } from "react";
import { Card, BlockStack, Text, InlineStack, Divider, Button, Box, Banner } from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { ToggleSwitch } from "./ToggleSwitch";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";

/*
 * Theme app extension UUID used for the theme-editor deep links. This is the
 * `uid` from extensions/variant-gallery/shopify.extension.toml. It is a single
 * source of truth committed in this repo, so it is identical for the dev and
 * prod Shopify apps (both deploy the same extension source). If that ever
 * changes (e.g. the extension is re-registered), pass the correct value via
 * the optional `extensionUid` prop from a loader/env instead of editing this.
 */
const DEFAULT_EXTENSION_UID = "55861f03-b391-90ea-8394-b3a6d5b6946b5f566a73";

interface ImageManagerSettings {
  enabled: boolean;
  autoAltText: boolean;
}

interface Props {
  settings: ImageManagerSettings;
  shop: string;
  /** Override the theme app extension UUID (e.g. wired from a loader/env). */
  extensionUid?: string;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export function SettingsImageManagerTab({ settings, shop, extensionUid, onHasChangesChange }: Props) {
  const { t } = useI18n();
  const uid = extensionUid || DEFAULT_EXTENSION_UID;
  const embedUrl = `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${uid}/variant-gallery-embed`;
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
      showInfoBox(msg, "critical", t.common?.error || "Error");
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
              <Text as="p" variant="bodyMd" fontWeight="semibold">{t.settings.themeSetupOptionATitle}</Text>
              <Text as="p" variant="bodySm" tone="subdued">{t.settings.themeSetupOptionADescription}</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {(t.settings as unknown as Record<string, string>).themeSetupSelectorHint ??
                  "If your theme’s product gallery is not replaced automatically, open the embed settings and set the “Native gallery CSS selector” to your theme’s product gallery element (inspect it in the browser; e.g. media-gallery or .product__media-wrapper)."}
              </Text>
              <div>
                <Button url={embedUrl} external variant="primary" size="slim">
                  {t.settings.themeSetupOptionAButton}
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
