/**
 * OptionsField - Component for translating product options
 *
 * - Product options (Size, Color, Material, etc.)
 * - Read-only view in primary locale
 * - Editable translation fields in foreign locales
 * - AI translation support (per field + entire option)
 * - Color-coded backgrounds (orange = not translated) matching AIEditableField styling
 * - Distinguishes regular options (name + values translatable)
 *   from linked/metaobject options (only name translatable here)
 */

import { Card, BlockStack, Text, TextField, Button, Divider, Badge, Banner } from "@shopify/polaris";
import "../../styles/AIEditableField.css";

export interface OptionValueData {
  id: string;  // gid://shopify/ProductOptionValue/...
  name: string;
  linked?: boolean;  // true = metaobject-linked value
}

export interface OptionData {
  id: string;
  name: string;
  position: number;
  values: OptionValueData[];
  isLinked?: boolean;  // true = metaobject-linked option
}

export interface OptionTranslation {
  name: string;
  values: string[];  // Translated value strings, indexed same as option.values
}

interface OptionsFieldProps {
  /** Array of options */
  options: OptionData[];

  /** Whether user is on primary locale */
  isPrimaryLocale: boolean;

  /** Current language code */
  currentLanguage: string;

  /** Translation data (indexed by option ID) */
  translations: Record<string, OptionTranslation>;

  /** Callback to translate entire option */
  onTranslate: (optionId: string) => void;

  /** Callback to translate a single field (option name or value) */
  onTranslateField?: (optionId: string, fieldType: "name" | "value", valueIndex?: number) => void;

  /** Callback when option name changes */
  onOptionNameChange: (optionId: string, value: string) => void;

  /** Callback when option value changes */
  onOptionValueChange: (optionId: string, valueIndex: number, value: string) => void;

  /** Whether translation is in progress */
  isTranslating: boolean;

  /** ID of the option currently being translated */
  translatingOptionId?: string;

  /** ID of the specific field being translated (e.g. "optId:name" or "optId:value:0") */
  translatingFieldId?: string;

  /** Translation strings */
  t?: {
    title?: string;
    notEditableInPrimary?: string;
    translateInstruction?: string;
    optionNameLabel?: string;
    valuesLabel?: string;
    valueLabel?: string;
    translateButton?: string;
    originalLabel?: string;
    linkedOptionHint?: string;
    linkedBadge?: string;
  };
}

export function OptionsField({
  options,
  isPrimaryLocale,
  currentLanguage,
  translations,
  onTranslate,
  onTranslateField,
  onOptionNameChange,
  onOptionValueChange,
  isTranslating,
  translatingOptionId,
  translatingFieldId,
  t = {},
}: OptionsFieldProps) {
  if (!options || options.length === 0) {
    return null;
  }

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h3" variant="headingMd" fontWeight="bold">
          {t.title || "Product Options"}
        </Text>

        {isPrimaryLocale ? (
          // Read-only display in primary language
          <BlockStack gap="300">
            <Text as="p" variant="bodySm" tone="subdued">
              {t.notEditableInPrimary || "Options are managed in Shopify and cannot be edited here."}
            </Text>
            {options.map((option, index) => (
              <div key={option.id}>
                {index > 0 && <Divider />}
                <BlockStack gap="200">
                  <div style={{ padding: "0.75rem", background: "#f6f6f7", borderRadius: "8px" }}>
                    <BlockStack gap="200">
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {option.name}
                        </Text>
                        {option.isLinked && (
                          <Badge tone="info">{t.linkedBadge || "Metaobject"}</Badge>
                        )}
                      </div>
                      <div>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.valuesLabel || "Values"}: {option.values.map(v => v.name).join(", ")}
                        </Text>
                      </div>
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
              {t.translateInstruction || `Translate the option names and values for ${currentLanguage}.`}
            </Text>
            {options.map((option, index) => {
              const translation = translations[option.id] || { name: "", values: [] };
              const nameFieldId = `${option.id}:name`;

              return (
                <div key={option.id}>
                  {index > 0 && <Divider />}
                  <Card>
                    <BlockStack gap="300">
                      {/* Original values as reference */}
                      <div style={{ padding: "0.75rem", background: "#f6f6f7", borderRadius: "8px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: option.isLinked ? "4px" : "0" }}>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {t.originalLabel || "Original"}: <strong>{option.name}</strong> → {option.values.map(v => v.name).join(", ")}
                          </Text>
                          {option.isLinked && (
                            <Badge tone="info">{t.linkedBadge || "Metaobject"}</Badge>
                          )}
                        </div>
                      </div>

                      {/* Option Name Translation — always available */}
                      <div>
                        <div className={`ai-editable-field-wrapper ${translation.name ? "bg-white" : "bg-untranslated"}`}>
                          <TextField
                            label={t.optionNameLabel || "Option name (translated)"}
                            value={translation.name || ""}
                            onChange={(value) => onOptionNameChange(option.id, value)}
                            autoComplete="off"
                          />
                        </div>
                        {onTranslateField && (
                          <div className="ai-field-footer">
                            <div className="ai-field-footer-left" />
                            <div className="ai-field-footer-right">
                              <Button
                                size="slim"
                                onClick={() => onTranslateField(option.id, "name")}
                                loading={isTranslating && translatingFieldId === nameFieldId}
                                disabled={isTranslating}
                              >
                                🌍 Translate
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Option Values Translation — only for regular (non-linked) options */}
                      {!option.isLinked ? (
                        <BlockStack gap="200">
                          <Text as="p" variant="bodyMd" fontWeight="medium">
                            {t.valuesLabel || "Values"} ({currentLanguage})
                          </Text>
                          {option.values.map((optVal, valueIndex) => {
                            const valueFieldId = `${option.id}:value:${valueIndex}`;
                            return (
                              <div key={optVal.id || valueIndex}>
                                <div className={`ai-editable-field-wrapper ${translation.values[valueIndex] ? "bg-white" : "bg-untranslated"}`}>
                                  <TextField
                                    label={`${t.valueLabel || "Value"} ${valueIndex + 1}: "${optVal.name}"`}
                                    value={translation.values[valueIndex] || ""}
                                    onChange={(newValue) => onOptionValueChange(option.id, valueIndex, newValue)}
                                    autoComplete="off"
                                  />
                                </div>
                                {onTranslateField && (
                                  <div className="ai-field-footer">
                                    <div className="ai-field-footer-left" />
                                    <div className="ai-field-footer-right">
                                      <Button
                                        size="slim"
                                        onClick={() => onTranslateField(option.id, "value", valueIndex)}
                                        loading={isTranslating && translatingFieldId === valueFieldId}
                                        disabled={isTranslating}
                                      >
                                        🌍 Translate
                                      </Button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </BlockStack>
                      ) : (
                        <Banner tone="info">
                          <p>
                            {t.linkedOptionHint || "The values of this option are metaobjects and are translated separately under Metaobjects."}
                          </p>
                        </Banner>
                      )}

                      {/* Translate Entire Option Button */}
                      <div className="ai-field-footer">
                        <div className="ai-field-footer-left" />
                        <div className="ai-field-footer-right">
                          <Button
                            size="slim"
                            onClick={() => onTranslate(option.id)}
                            loading={isTranslating && translatingOptionId === option.id && !translatingFieldId}
                            disabled={isTranslating}
                          >
                            🌍 {t.translateButton || "Translate entire option"}
                          </Button>
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
