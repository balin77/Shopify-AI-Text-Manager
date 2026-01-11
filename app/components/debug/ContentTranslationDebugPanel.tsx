import { Card, Text, BlockStack, InlineStack, Badge, Collapsible, Button } from "@shopify/polaris";
import { useState } from "react";

interface Translation {
  key: string;
  value: string;
  locale: string;
}

interface ContentItem {
  id: string;
  title: string;
  handle?: string;
  body?: string;
  descriptionHtml?: string;
  seo?: {
    title?: string | null;
    description?: string | null;
  };
  translations: Translation[];
}

interface ContentTranslationDebugPanelProps {
  contentItem: ContentItem;
  contentType: "collections" | "blogs" | "pages";
  shopLocales: Array<{ locale: string; name: string; primary: boolean }>;
}

export function ContentTranslationDebugPanel({ contentItem, contentType, shopLocales }: ContentTranslationDebugPanelProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Group translations by locale
  const translationsByLocale: Record<string, Record<string, string>> = {};

  for (const translation of contentItem.translations) {
    if (!translationsByLocale[translation.locale]) {
      translationsByLocale[translation.locale] = {};
    }
    translationsByLocale[translation.locale][translation.key] = translation.value;
  }

  // Primary locale data (not in translations table)
  const primaryLocale = shopLocales.find(l => l.primary);

  // Define expected keys based on content type
  let expectedKeys: string[] = [];
  let primaryData: Record<string, string> = {};

  if (contentType === "pages") {
    expectedKeys = ["title", "body"];
    primaryData = {
      title: contentItem.title,
      body: contentItem.body || "",
    };
  } else if (contentType === "collections") {
    expectedKeys = ["title", "description", "handle", "seo_title", "seo_description"];
    primaryData = {
      title: contentItem.title,
      description: contentItem.descriptionHtml || "",
      handle: contentItem.handle || "",
      seo_title: contentItem.seo?.title || "",
      seo_description: contentItem.seo?.description || "",
    };
  } else if (contentType === "blogs") {
    expectedKeys = ["title", "body_html", "handle", "seo_title", "seo_description"];
    primaryData = {
      title: contentItem.title,
      body_html: contentItem.body || "",
      handle: contentItem.handle || "",
      seo_title: contentItem.seo?.title || "",
      seo_description: contentItem.seo?.description || "",
    };
  }

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Translation Debug Panel ({contentType})
          </Text>
          <Button onClick={() => setIsOpen(!isOpen)} plain>
            {isOpen ? "Hide" : "Show"} Details
          </Button>
        </InlineStack>

        <Collapsible
          open={isOpen}
          id="content-translation-debug-collapsible"
          transition={{ duration: "150ms", timingFunction: "ease" }}
        >
          <BlockStack gap="400">
            <Text as="p" tone="subdued">
              Content ID: {contentItem.id}
            </Text>
            <Text as="p" tone="subdued">
              Total translations in DB: {contentItem.translations.length}
            </Text>

            {/* Primary Locale */}
            {primaryLocale && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      {primaryLocale.locale} (Primary - {primaryLocale.name})
                    </Text>
                    <Badge tone="info">From Content Fields</Badge>
                  </InlineStack>

                  <BlockStack gap="200">
                    {expectedKeys.map(key => {
                      const value = primaryData[key] || "";
                      const hasValue = !!value;

                      return (
                        <InlineStack key={key} gap="200" blockAlign="center">
                          <div style={{ minWidth: "150px" }}>
                            <Text as="span" fontWeight="semibold">{key}:</Text>
                          </div>
                          <Badge tone={hasValue ? "success" : "warning"}>
                            {hasValue ? "✓" : "Empty"}
                          </Badge>
                          {hasValue && (
                            <Text as="span" tone="subdued" truncate>
                              {value.substring(0, 60)}{value.length > 60 ? "..." : ""}
                            </Text>
                          )}
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              </Card>
            )}

            {/* Other Locales */}
            {shopLocales.filter(l => !l.primary).map(locale => {
              const translations = translationsByLocale[locale.locale] || {};
              const translationCount = Object.keys(translations).length;

              return (
                <Card key={locale.locale}>
                  <BlockStack gap="300">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingSm">
                        {locale.locale} ({locale.name})
                      </Text>
                      <Badge tone={translationCount > 0 ? "success" : "critical"}>
                        {translationCount} fields
                      </Badge>
                    </InlineStack>

                    <BlockStack gap="200">
                      {expectedKeys.map(key => {
                        const value = translations[key];
                        const hasValue = !!value;

                        return (
                          <InlineStack key={key} gap="200" blockAlign="center">
                            <div style={{ minWidth: "150px" }}>
                              <Text as="span" fontWeight="semibold">{key}:</Text>
                            </div>
                            <Badge tone={hasValue ? "success" : "critical"}>
                              {hasValue ? "✓" : "Missing"}
                            </Badge>
                            {hasValue && (
                              <Text as="span" tone="subdued" truncate>
                                {value.substring(0, 60)}{value.length > 60 ? "..." : ""}
                              </Text>
                            )}
                          </InlineStack>
                        );
                      })}
                    </BlockStack>

                    {/* Show unexpected keys */}
                    {Object.keys(translations).filter(k => !expectedKeys.includes(k)).length > 0 && (
                      <BlockStack gap="200">
                        <Text as="p" tone="caution">
                          Unexpected keys found:
                        </Text>
                        {Object.keys(translations)
                          .filter(k => !expectedKeys.includes(k))
                          .map(key => (
                            <InlineStack key={key} gap="200" blockAlign="center">
                              <div style={{ minWidth: "150px" }}>
                                <Text as="span" fontWeight="semibold">{key}:</Text>
                              </div>
                              <Badge tone="attention">Unknown</Badge>
                              <Text as="span" tone="subdued" truncate>
                                {translations[key].substring(0, 60)}
                                {translations[key].length > 60 ? "..." : ""}
                              </Text>
                            </InlineStack>
                          ))}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>
              );
            })}

            {/* Summary */}
            <Card background="bg-surface-success">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Missing Fields Summary
                </Text>
                {shopLocales.filter(l => !l.primary).map(locale => {
                  const translations = translationsByLocale[locale.locale] || {};
                  const missingFields = expectedKeys.filter(key => !translations[key]);

                  if (missingFields.length === 0) {
                    return (
                      <Text key={locale.locale} tone="success">
                        ✓ {locale.locale}: All fields present
                      </Text>
                    );
                  }

                  return (
                    <Text key={locale.locale} tone="critical">
                      ✗ {locale.locale}: Missing {missingFields.join(", ")}
                    </Text>
                  );
                })}
              </BlockStack>
            </Card>
          </BlockStack>
        </Collapsible>
      </BlockStack>
    </Card>
  );
}
