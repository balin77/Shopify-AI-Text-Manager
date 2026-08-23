import { useState } from "react";
import { BlockStack, Card, InlineStack, Text } from "@shopify/polaris";
import type { FetcherWithComponents } from "react-router";
import type { Translation as I18nTranslation } from "~/i18n/de";
import { SettingsMetafieldsTab } from "./SettingsMetafieldsTab";
import { SettingsRichtextTab } from "./SettingsRichtextTab";
import { SettingsRecurringValuesTab } from "./SettingsRecurringValuesTab";
import { SettingsImageManagerTab } from "./SettingsImageManagerTab";

export type OtherSubTab = "metafields" | "richtext" | "recurring" | "imagemanager";

interface EnabledMetafieldDefinition {
  definitionId: string;
  namespace: string;
  key: string;
  patchedTranslatable: boolean;
}

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

interface ImageManagerSettings {
  enabled: boolean;
  autoAltText: boolean;
}

interface RichtextSettings {
  themeRichtextMode: string;
}

interface Props {
  t: I18nTranslation;
  fetcher: FetcherWithComponents<any>;
  initialSubTab?: OtherSubTab;

  // Metafields
  enabledMetafieldDefinitions: EnabledMetafieldDefinition[];
  metafieldsLastScanAt: string | null;
  onMetafieldHasChangesChange?: (hasChanges: boolean) => void;

  // Richtext
  richtextSettings: RichtextSettings;

  // Recurring values
  groupedFieldTranslations: GroupedFieldTranslationEntry[];
  optionValueMemory: OptionValueMemoryEntry[];
  primaryShopLocale: string;
  showSkuTab: boolean;

  // Image manager (only rendered when showImageManagerTab is true)
  showImageManagerTab: boolean;
  imageManagerSettings: ImageManagerSettings;
  shop: string;
}

// Groups the "less common" settings (Metafields, Rich-text formatting,
// Wiederkehrende Werte, and — Pro+ only — Image Manager) under a shared
// horizontal sub-tab strip, styled to match the sub-section switch inside
// AIInstructionsTabs. Each sub-tab renders its own Card and Save/Discard;
// this wrapper is only responsible for the strip + panel switching.
export function SettingsOtherTab({
  t,
  fetcher,
  initialSubTab,
  enabledMetafieldDefinitions,
  metafieldsLastScanAt,
  onMetafieldHasChangesChange,
  richtextSettings,
  groupedFieldTranslations,
  optionValueMemory,
  primaryShopLocale,
  showSkuTab,
  showImageManagerTab,
  imageManagerSettings,
  shop,
}: Props) {
  const ts = t.settings as unknown as Record<string, string>;

  const subTabs: { id: OtherSubTab; label: string }[] = [
    { id: "metafields", label: ts.metafields || "Metafields" },
    { id: "richtext", label: ts.richtextFormatting || "Rich-text formatting" },
    { id: "recurring", label: ts.recurringValues || "Wiederkehrende Werte" },
    ...(showImageManagerTab
      ? [{ id: "imagemanager" as OtherSubTab, label: "Image Manager" }]
      : []),
  ];

  const fallback: OtherSubTab = subTabs[0].id;
  const resolvedInitial: OtherSubTab =
    initialSubTab && subTabs.some((s) => s.id === initialSubTab) ? initialSubTab : fallback;
  const [selected, setSelected] = useState<OtherSubTab>(resolvedInitial);

  return (
    <BlockStack gap="400">
      {/* Slim nav Card. `padding="0"` avoids relying on Polaris' default Card
          inset to hide the strip's empty gutter; the buttons carry their own
          padding, and the container's 1px border-bottom is anchored to the
          Card edge — no negative margins required. */}
      <Card padding="0">
        <div style={{ borderBottom: "1px solid #e1e3e5" }}>
          <InlineStack gap="0">
            {subTabs.map((tab) => {
              const isActive = selected === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setSelected(tab.id)}
                  style={{
                    padding: "0.75rem 1.25rem",
                    background: "none",
                    border: "none",
                    borderBottom: isActive ? "3px solid #008060" : "3px solid transparent",
                    marginBottom: "-1px",
                    cursor: "pointer",
                  }}
                >
                  <Text
                    as="span"
                    variant="bodyMd"
                    fontWeight={isActive ? "bold" : "regular"}
                    tone={isActive ? "base" : "subdued"}
                  >
                    {tab.label}
                  </Text>
                </button>
              );
            })}
          </InlineStack>
        </div>
      </Card>

      {selected === "metafields" && (
        <SettingsMetafieldsTab
          enabledMetafieldDefinitions={enabledMetafieldDefinitions}
          metafieldsLastScanAt={metafieldsLastScanAt}
          t={t}
          onHasChangesChange={onMetafieldHasChangesChange}
        />
      )}

      {selected === "richtext" && (
        <SettingsRichtextTab settings={richtextSettings} t={t} />
      )}

      {selected === "recurring" && (
        <SettingsRecurringValuesTab
          groupedFieldTranslations={groupedFieldTranslations}
          optionValueMemory={optionValueMemory}
          primaryShopLocale={primaryShopLocale}
          showSkuTab={showSkuTab}
          t={t}
        />
      )}

      {selected === "imagemanager" && showImageManagerTab && (
        <SettingsImageManagerTab
          settings={{
            enabled: imageManagerSettings?.enabled ?? true,
            autoAltText: imageManagerSettings?.autoAltText ?? false,
          }}
          shop={shop}
        />
      )}
    </BlockStack>
  );
}
