import { Card, Text, BlockStack, Badge, TextField, InlineStack, Banner } from "@shopify/polaris";
import { useState } from "react";

interface ThemeContentViewerProps {
  themeResource: any;
  currentLanguage: string;
  shopLocales: any[];
}

export function ThemeContentViewer({ themeResource, currentLanguage, shopLocales }: ThemeContentViewerProps) {
  const [searchTerm, setSearchTerm] = useState("");

  if (!themeResource || !themeResource.translatableContent) {
    return (
      <Banner tone="info">
        <p>No translatable content available for this resource.</p>
      </Banner>
    );
  }

  // Filter translatable content by search term
  const filteredContent = themeResource.translatableContent.filter((item: any) =>
    item.key.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.value?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Get translations for the current language
  const currentTranslations = themeResource.translations?.filter(
    (t: any) => t.locale === currentLanguage
  ) || [];

  // Helper function to get translation for a key
  const getTranslation = (key: string) => {
    const translation = currentTranslations.find((t: any) => t.key === key);
    return translation?.value || "";
  };

  const currentLocaleName = shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage;
  const isPrimaryLocale = shopLocales.find((l: any) => l.locale === currentLanguage)?.primary || false;

  return (
    <BlockStack gap="400">
      {/* Info Banner */}
      <Banner tone="info">
        <BlockStack gap="200">
          <Text as="p" fontWeight="semibold">Theme Resource: {themeResource.resourceTypeLabel}</Text>
          <Text as="p" variant="bodySm">
            This resource contains {themeResource.contentCount} translatable fields from your theme.
            These are theme-level translations (labels, defaults, etc.) - not merchant-entered content.
          </Text>
        </BlockStack>
      </Banner>

      {/* Search */}
      <TextField
        label="Search translatable content"
        value={searchTerm}
        onChange={setSearchTerm}
        placeholder="Search by key or value..."
        autoComplete="off"
        clearButton
        onClearButtonClick={() => setSearchTerm("")}
      />

      {/* Stats */}
      <InlineStack gap="200">
        <Badge tone="info">
          {filteredContent.length} of {themeResource.contentCount} fields
        </Badge>
        <Badge tone={isPrimaryLocale ? "success" : "attention"}>
          {currentLocaleName} {isPrimaryLocale && "(Primary)"}
        </Badge>
      </InlineStack>

      {/* Content List */}
      <div style={{ maxHeight: "600px", overflowY: "auto" }}>
        <BlockStack gap="300">
          {filteredContent.length > 0 ? (
            filteredContent.map((item: any, index: number) => (
              <Card key={index}>
                <BlockStack gap="200">
                  {/* Key */}
                  <Text as="p" variant="bodySm" fontWeight="semibold" tone="subdued">
                    {item.key}
                  </Text>

                  {/* Primary Locale Value */}
                  {isPrimaryLocale && (
                    <div style={{ background: "#f6f6f7", padding: "12px", borderRadius: "8px" }}>
                      <Text as="p" variant="bodyMd">
                        {item.value || <Text as="span" tone="subdued">(empty)</Text>}
                      </Text>
                    </div>
                  )}

                  {/* Translation Value (Non-Primary Locales) */}
                  {!isPrimaryLocale && (
                    <div style={{ background: getTranslation(item.key) ? "#f1f8f5" : "#fff4e5", padding: "12px", borderRadius: "8px" }}>
                      {getTranslation(item.key) ? (
                        <>
                          <Text as="p" variant="bodyMd">
                            {getTranslation(item.key)}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued" fontWeight="regular">
                            Original: {item.value}
                          </Text>
                        </>
                      ) : (
                        <>
                          <Text as="p" variant="bodyMd" tone="subdued">
                            <em>Not translated</em>
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Original: {item.value}
                          </Text>
                        </>
                      )}
                    </div>
                  )}
                </BlockStack>
              </Card>
            ))
          ) : (
            <Card>
              <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                No matching content found
              </Text>
            </Card>
          )}
        </BlockStack>
      </div>

      {/* Read-Only Notice */}
      <Banner tone="warning">
        <p>
          <strong>Read-Only View:</strong> Theme translations are currently displayed for reference only.
          To edit these translations, use Shopify's "Translate & Adapt" app or edit the theme's locale files directly.
        </p>
      </Banner>
    </BlockStack>
  );
}
