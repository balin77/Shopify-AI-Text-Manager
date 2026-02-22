/**
 * MetafieldsField - Component for editing and translating product metafields
 *
 * Shows translatable metafields (text-based types only):
 * - Editable fields in primary locale (direct value editing)
 * - Editable translation fields in foreign locales
 * - AI translation support per metafield
 * - Color-coded backgrounds (orange = not translated)
 */

import { Card, BlockStack, Text, TextField, Button, Divider, Badge } from "@shopify/polaris";
import "../../styles/AIEditableField.css";

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

  /** Callback when primary metafield value changes (optional, for primary locale editing) */
  onPrimaryMetafieldChange?: (metafieldId: string, value: string) => void;

  /** Primary metafield values (indexed by metafield ID) - used when editing primary locale */
  primaryValues?: Record<string, string>;

  /** Set of field IDs currently being translated */
  translatingFieldIds?: Set<string>;

  /** Translation strings */
  t?: {
    title?: string;
    notEditableInPrimary?: string;
    translateInstruction?: string;
    translateButton?: string;
    originalLabel?: string;
    editInstructionPrimary?: string;
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
  onPrimaryMetafieldChange,
  primaryValues = {},
  translatingFieldIds = new Set(),
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
          // Editable fields in primary language
          <BlockStack gap="300">
            <Text as="p" variant="bodySm" tone="subdued">
              {t.editInstructionPrimary || "Edit the metafield values in the primary language."}
            </Text>
            {metafields.map((mf, index) => {
              const currentValue = primaryValues[mf.id] !== undefined ? primaryValues[mf.id] : mf.value;
              const fieldId = mf.id;

              return (
                <div key={mf.id}>
                  {index > 0 && <Divider />}
                  <Card>
                    <BlockStack gap="200">
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {mf.namespace}.{mf.key}
                        </Text>
                        <Badge tone="info">{TYPE_LABELS[mf.type] || mf.type}</Badge>
                      </div>
                      <TextField
                        label={`${mf.namespace}.${mf.key}`}
                        labelHidden
                        value={currentValue}
                        onChange={(value) => onPrimaryMetafieldChange?.(mf.id, value)}
                        autoComplete="off"
                        multiline={mf.type === "multi_line_text_field" || mf.type === "rich_text_field" ? 3 : undefined}
                      />
                      {onTranslate && (
                        <div className="ai-field-footer">
                          <div className="ai-field-footer-left" />
                          <div className="ai-field-footer-right">
                            <Button
                              size="slim"
                              onClick={() => onTranslate(mf.id)}
                              loading={translatingFieldIds.has(fieldId)}
                            >
                              🌍 {t.translateButton || "Translate"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </BlockStack>
                  </Card>
                </div>
              );
            })}
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
              const fieldId = mf.id;

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
                      <div>
                        <div className={`ai-editable-field-wrapper ${hasTranslation ? "bg-white" : "bg-untranslated"}`}>
                          <TextField
                            label={`${mf.namespace}.${mf.key} (${currentLanguage})`}
                            value={translation}
                            onChange={(value) => onMetafieldChange(mf.id, value)}
                            autoComplete="off"
                            multiline={mf.type === "multi_line_text_field" || mf.type === "rich_text_field" ? 3 : undefined}
                          />
                        </div>
                        <div className="ai-field-footer">
                          <div className="ai-field-footer-left" />
                          <div className="ai-field-footer-right">
                            <Button
                              size="slim"
                              onClick={() => onTranslate(mf.id)}
                              loading={translatingFieldIds.has(fieldId)}
                            >
                              🌍 {t.translateButton || "Translate"}
                            </Button>
                          </div>
                        </div>
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
