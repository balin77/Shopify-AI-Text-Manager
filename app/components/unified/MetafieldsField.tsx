/**
 * MetafieldsField - Component for translating product metafields
 *
 * Shows translatable metafields (text-based types only):
 * - Read-only view in primary locale
 * - Editable translation fields in foreign locales
 * - AI translation support per metafield
 * - Color-coded backgrounds (orange = not translated)
 */

import { Card, BlockStack, Text, TextField, Button, Divider, Badge } from "@shopify/polaris";

export interface MetafieldData {
  id: string;       // gid://shopify/Metafield/...
  namespace: string;
  key: string;
  value: string;
  type: string;
}

interface MetafieldsFieldProps {
  /** Array of translatable metafields */
  metafields: MetafieldData[];

  /** Whether user is on primary locale */
  isPrimaryLocale: boolean;

  /** Current language code */
  currentLanguage: string;

  /** Translation data (indexed by metafield ID) */
  translations: Record<string, string>;

  /** Callback to translate a single metafield */
  onTranslate: (metafieldId: string) => void;

  /** Callback when metafield translation changes */
  onMetafieldChange: (metafieldId: string, value: string) => void;

  /** Whether translation is in progress */
  isTranslating: boolean;

  /** ID of the metafield currently being translated */
  translatingMetafieldId?: string;

  /** Translation strings */
  t?: {
    title?: string;
    notEditableInPrimary?: string;
    translateInstruction?: string;
    translateButton?: string;
    originalLabel?: string;
  };
}

/** Metafield type display names */
const TYPE_LABELS: Record<string, string> = {
  single_line_text_field: "Text",
  multi_line_text_field: "Multi-line",
  rich_text_field: "Rich text",
  "list.single_line_text_field": "Text list",
};

export function MetafieldsField({
  metafields,
  isPrimaryLocale,
  currentLanguage,
  translations,
  onTranslate,
  onMetafieldChange,
  isTranslating,
  translatingMetafieldId,
  t = {},
}: MetafieldsFieldProps) {
  if (!metafields || metafields.length === 0) {
    return null;
  }

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h3" variant="headingMd" fontWeight="bold">
          {t.title || "Metafields"}
        </Text>

        {isPrimaryLocale ? (
          // Read-only display in primary language
          <BlockStack gap="300">
            <Text as="p" variant="bodySm" tone="subdued">
              {t.notEditableInPrimary || "Metafield values are managed in Shopify and cannot be edited here."}
            </Text>
            {metafields.map((mf, index) => (
              <div key={mf.id}>
                {index > 0 && <Divider />}
                <BlockStack gap="200">
                  <div style={{ padding: "0.75rem", background: "#f6f6f7", borderRadius: "8px" }}>
                    <BlockStack gap="200">
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {mf.namespace}.{mf.key}
                        </Text>
                        <Badge tone="info">{TYPE_LABELS[mf.type] || mf.type}</Badge>
                      </div>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {truncateValue(mf.value, 200)}
                      </Text>
                    </BlockStack>
                  </div>
                </BlockStack>
              </div>
            ))}
          </BlockStack>
        ) : (
          // Editable translation fields in foreign languages
          <BlockStack gap="400">
            <Text as="p" variant="bodySm" tone="subdued">
              {t.translateInstruction || `Translate the metafield values for ${currentLanguage}.`}
            </Text>
            {metafields.map((mf, index) => {
              const translation = translations[mf.id] || "";
              const hasTranslation = !!translation;

              return (
                <div key={mf.id}>
                  {index > 0 && <Divider />}
                  <Card>
                    <BlockStack gap="300">
                      {/* Original value as reference */}
                      <div style={{ padding: "0.75rem", background: "#f6f6f7", borderRadius: "8px" }}>
                        <BlockStack gap="100">
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <Text as="p" variant="bodySm" fontWeight="semibold">
                              {mf.namespace}.{mf.key}
                            </Text>
                            <Badge tone="info">{TYPE_LABELS[mf.type] || mf.type}</Badge>
                          </div>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {t.originalLabel || "Original"}: {truncateValue(mf.value, 200)}
                          </Text>
                        </BlockStack>
                      </div>

                      {/* Translation input */}
                      <div
                        style={{
                          background: hasTranslation ? "white" : "#fff4e5",
                          borderRadius: "8px",
                          padding: "1px",
                        }}
                      >
                        <TextField
                          label={`${mf.namespace}.${mf.key} (${currentLanguage})`}
                          value={translation}
                          onChange={(value) => onMetafieldChange(mf.id, value)}
                          autoComplete="off"
                          multiline={mf.type === "multi_line_text_field" || mf.type === "rich_text_field" ? 3 : undefined}
                        />
                      </div>

                      {/* Translate Button */}
                      <div>
                        <Button
                          onClick={() => onTranslate(mf.id)}
                          loading={isTranslating && translatingMetafieldId === mf.id}
                        >
                          {t.translateButton || "Translate"}
                        </Button>
                      </div>
                    </BlockStack>
                  </Card>
                </div>
              );
            })}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

function truncateValue(value: string, maxLength: number): string {
  if (!value) return "";
  // For JSON values, try to make them readable
  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      const pretty = JSON.stringify(parsed);
      return pretty.length > maxLength ? pretty.substring(0, maxLength) + "..." : pretty;
    } catch {
      // Not valid JSON, show as-is
    }
  }
  return value.length > maxLength ? value.substring(0, maxLength) + "..." : value;
}
