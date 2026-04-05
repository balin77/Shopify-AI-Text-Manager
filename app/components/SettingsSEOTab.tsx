import { useState, useEffect } from "react";
import type { FetcherWithComponents } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
  TextField,
  Banner,
  Checkbox,
  InlineStack,
} from "@shopify/polaris";
import { SaveDiscardButtons } from "./SaveDiscardButtons";

interface Settings {
  seoTitleSuffixEnabled: boolean;
  seoTitleSuffix: string;
}

interface SettingsSEOTabProps {
  settings: Settings;
  fetcher: FetcherWithComponents<any>;
  t: any;
  shopDisplayName?: string;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export function SettingsSEOTab({
  settings,
  fetcher,
  t,
  shopDisplayName = "",
  onHasChangesChange,
}: SettingsSEOTabProps) {
  const [seoTitleSuffixEnabled, setSeoTitleSuffixEnabled] = useState(
    settings.seoTitleSuffixEnabled ?? false
  );
  const [seoTitleSuffix, setSeoTitleSuffix] = useState(settings.seoTitleSuffix || "");
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    const changed =
      seoTitleSuffixEnabled !== (settings.seoTitleSuffixEnabled ?? false) ||
      seoTitleSuffix !== (settings.seoTitleSuffix || "");
    setHasChanges(changed);
    if (onHasChangesChange) onHasChangesChange(changed);
  }, [seoTitleSuffixEnabled, seoTitleSuffix, settings, onHasChangesChange]);

  const handleSave = () => {
    if (!hasChanges) return;
    fetcher.submit(
      {
        actionType: "saveSeoSettings",
        seoTitleSuffixEnabled: String(seoTitleSuffixEnabled),
        seoTitleSuffix,
      },
      { method: "POST" }
    );
  };

  const handleDiscard = () => {
    setSeoTitleSuffixEnabled(settings.seoTitleSuffixEnabled ?? false);
    setSeoTitleSuffix(settings.seoTitleSuffix || "");
  };

  return (
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingLg">
            {t.settings.seoSettings || "SEO"}
          </Text>
          <div style={{ marginLeft: "auto" }}>
            <SaveDiscardButtons
              hasChanges={hasChanges}
              onSave={handleSave}
              onDiscard={handleDiscard}
              saveText={t.products?.saveChanges || "Speichern"}
              discardText={t.content?.discardChanges || "Verwerfen"}
              action="saveSeoSettings"
              fetcherState={fetcher.state}
              fetcherFormData={fetcher.formData}
            />
          </div>
        </InlineStack>

        <Text as="p" variant="bodyMd" tone="subdued">
          {t.settings.seoTitleSuffixDescription ||
            "Aktiviere diese Option wenn Shopify automatisch den Shop-Namen an SEO-Titel anhängt. Die KI generiert dann kürzere Titel, damit die Gesamtlänge 60 Zeichen nicht überschreitet."}
        </Text>

        <BlockStack gap="400">
          <Text as="h3" variant="headingMd">
            {t.settings.seoTitleSuffix || "SEO-Titel Shop-Suffix"}
          </Text>

          <Checkbox
            label={
              t.settings.seoTitleSuffixLabel ||
              "Shopify hängt Shop-Namen an SEO-Titel an"
            }
            checked={seoTitleSuffixEnabled}
            onChange={(checked) => {
              setSeoTitleSuffixEnabled(checked);
              if (checked && !seoTitleSuffix && shopDisplayName) {
                setSeoTitleSuffix(` \u2013 ${shopDisplayName}`);
              }
            }}
          />

          {seoTitleSuffixEnabled && (
            <BlockStack gap="200">
              <TextField
                label={
                  t.settings.seoTitleSuffixField ||
                  "Angefügter Text (inkl. Trennzeichen)"
                }
                value={seoTitleSuffix}
                onChange={setSeoTitleSuffix}
                placeholder={
                  shopDisplayName ? ` \u2013 ${shopDisplayName}` : " – Shop Name"
                }
                helpText={
                  seoTitleSuffix
                    ? (
                        t.settings.seoTitleSuffixHint ||
                        "Effektives Zeichenlimit: {limit} Zeichen (von 60)"
                      ).replace("{limit}", String(60 - seoTitleSuffix.length))
                    : undefined
                }
                autoComplete="off"
                maxLength={60}
              />
              <Banner tone="info">
                <Text as="p">
                  {t.settings.seoTitleSuffixNote ||
                    "Dieser Text wird von Shopify angefügt und wird nicht im SEO-Titel gespeichert. Er dient nur zur Berechnung des effektiven Zeichenlimits."}
                </Text>
              </Banner>
            </BlockStack>
          )}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}
