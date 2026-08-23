/**
 * Both switches save themselves — see
 * [useInstantSetting.ts](../hooks/useInstantSetting.ts) for the rule and its
 * two rails (optimistic, reverted on refusal; its own fetcher). This card has
 * no draft state and therefore no Save button: a toggle is not a draft, and
 * the route it posts to already writes one field at a time.
 */

import { Card, BlockStack, Text, InlineStack, Divider, Banner } from "@shopify/polaris";
import { useState } from "react";
import { ToggleSwitch } from "./ToggleSwitch";
import { useInstantSetting } from "../hooks/useInstantSetting";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";

interface ImageManagerSettings {
  enabled: boolean;
  autoAltText: boolean;
}

interface Props {
  settings: ImageManagerSettings;
  shop: string;
}

export function SettingsImageManagerTab({ settings }: Props) {
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();
  const [saveError, setSaveError] = useState<string | null>(null);

  const onError = () => {
    // An i18n string rather than `error`: the server-side message is
    // English-only and can leak backend wording (a raw Prisma error).
    const msg = (t.settings as unknown as Record<string, string>)?.imageManagerSaveError
      || t.products?.saveFailed
      || "Save failed";
    setSaveError(msg);
    showInfoBox(msg, "critical", t.common?.error || "Error");
  };

  /** One JSON field per request; the route writes only what it is given. */
  const postField = (field: "enabled" | "autoAltText") =>
    (value: boolean, fetcher: { submit: (body: string, opts: object) => void }) => {
      setSaveError(null);
      fetcher.submit(JSON.stringify({ [field]: value }), {
        method: "post",
        action: "/api/image-manager-settings",
        encType: "application/json",
      });
    };

  const enabled = useInstantSetting<boolean>({
    stored: settings.enabled,
    submit: postField("enabled"),
    onError,
  });
  const autoAltText = useInstantSetting<boolean>({
    stored: settings.autoAltText,
    submit: postField("autoAltText"),
    onError,
  });

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">{t.settings.imageManagerTitle}</Text>

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
          <ToggleSwitch checked={enabled.value} onChange={enabled.set} />
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">{t.settings.imageManagerEnabled}</Text>
            <Text as="p" variant="bodySm" tone="subdued">{t.settings.imageManagerEnabledDescription}</Text>
          </BlockStack>
        </InlineStack>

        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <ToggleSwitch checked={autoAltText.value} onChange={autoAltText.set} />
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">{t.settings.imageManagerAutoAltText}</Text>
            <Text as="p" variant="bodySm" tone="subdued">{t.settings.imageManagerAutoAltTextDescription}</Text>
          </BlockStack>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
