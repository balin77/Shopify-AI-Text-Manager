import { BlockStack, Card, Text, Banner } from "@shopify/polaris";
import type { Translation as I18nTranslation } from "~/i18n/de";
import { SettingsTranslationsTab } from "./SettingsTranslationsTab";
import { SettingsSkuTab } from "./SettingsSkuTab";

interface GroupedFieldTranslationEntry {
  id: string;
  fieldKey: string;
  sourceLocale: string;
  sourceValueNorm: string;
  sourceValue: string;
  targetLocale: string;
  translatedValue: string;
  source: string;
  updatedAt: string | Date;
}

interface OptionValueMemoryEntry {
  optionValue: string;
  savedAs: string;
}

interface Props {
  groupedFieldTranslations: GroupedFieldTranslationEntry[];
  optionValueMemory: OptionValueMemoryEntry[];
  primaryShopLocale: string;
  showSkuTab: boolean;
  t: I18nTranslation;
}

// Groups the two "AI generates once, then reuses across products" caches:
// productType translations (GroupedFieldTranslation) and variant option-value
// keys (OptionValueMemory). Both are merchant-editable overrides.
export function SettingsRecurringValuesTab({
  groupedFieldTranslations,
  optionValueMemory,
  primaryShopLocale,
  showSkuTab,
  t,
}: Props) {
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingLg">
            {t.settings.recurringValues || "Wiederkehrende Werte"}
          </Text>
          <Text as="p" tone="subdued" variant="bodyMd">
            {t.settings.recurringValuesDescription}
          </Text>
        </BlockStack>
      </Card>

      <SettingsTranslationsTab
        groupedFieldTranslations={groupedFieldTranslations}
        primaryShopLocale={primaryShopLocale}
        t={t}
      />

      {showSkuTab ? (
        <SettingsSkuTab optionValueMemory={optionValueMemory} t={t} />
      ) : (
        // Free/Basic still see the SKU section so they understand the feature
        // exists, but it's read-only with an upgrade hint. Rendering the
        // component read-only would need larger prop plumbing, so we render a
        // banner-only placeholder instead.
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingLg">
              {t.settings.sku}
            </Text>
            <Banner tone="info">
              <Text as="p">
                {t.settings.recurringValuesSkuProGate ||
                  "Optionswert-Schlüssel sind ab dem Pro-Plan verfügbar."}
              </Text>
            </Banner>
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
