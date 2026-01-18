/**
 * OptionsField - Optional field for managing product options/variants
 *
 * Reusable component for content types that have options (primarily Products):
 * - Product options (Size, Color, Material, etc.)
 * - Read-only view in primary locale
 * - Editable translation fields in foreign locales
 * - AI translation support
 * - Color-coded backgrounds (orange = not translated)
 *
 * Can be extended for other content types that need similar structures.
 */

import { Card, BlockStack, Text, TextField, Button, Divider } from "@shopify/polaris";

export interface OptionData {
  id: string;
  name: string;
  position: number;
  values: string[];
}

export interface OptionTranslation {
  name: string;
  values: string[];
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

  /** Callback when option name changes */
  onOptionNameChange: (optionId: string, value: string) => void;

  /** Callback when option value changes */
  onOptionValueChange: (optionId: string, valueIndex: number, value: string) => void;

  /** Whether translation is in progress */
  isTranslating: boolean;

  /** ID of the option currently being translated */
  translatingOptionId?: string;

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
  };
}

export function OptionsField({
  options,
  isPrimaryLocale,
  currentLanguage,
  translations,
  onTranslate,
  onOptionNameChange,
  onOptionValueChange,
  isTranslating,
  translatingOptionId,
  t = {},
}: OptionsFieldProps) {
  if (!options || options.length === 0) {
    return null;
  }

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h3" variant="headingMd" fontWeight="bold">
          {t.title || "Options"}
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
                      <div>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {option.name}
                        </Text>
                      </div>
                      <div>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.valuesLabel || "Values"}: {option.values.join(", ")}
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
              const hasTranslation = translation.name || translation.values.some(v => v);

              return (
                <div key={option.id}>
                  {index > 0 && <Divider />}
                  <Card>
                    <BlockStack gap="300">
                      {/* Original values as reference */}
                      <div style={{ padding: "0.75rem", background: "#f6f6f7", borderRadius: "8px" }}>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.originalLabel || "Original"}: <strong>{option.name}</strong> → {option.values.join(", ")}
                        </Text>
                      </div>

                      {/* Option Name Translation */}
                      <div
                        style={{
                          background: hasTranslation ? "white" : "#fff4e5",
                          borderRadius: "8px",
                          padding: "1px",
                        }}
                      >
                        <TextField
                          label={t.optionNameLabel || "Option name (translated)"}
                          value={translation.name || ""}
                          onChange={(value) => onOptionNameChange(option.id, value)}
                          autoComplete="off"
                        />
                      </div>

                      {/* Option Values Translation */}
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd" fontWeight="medium">
                          {t.valuesLabel || "Values"} ({currentLanguage})
                        </Text>
                        {option.values.map((value, valueIndex) => (
                          <div
                            key={valueIndex}
                            style={{
                              background: hasTranslation ? "white" : "#fff4e5",
                              borderRadius: "8px",
                              padding: "1px",
                            }}
                          >
                            <TextField
                              label={`${t.valueLabel || "Value"} ${valueIndex + 1}: "${value}"`}
                              value={translation.values[valueIndex] || ""}
                              onChange={(newValue) => onOptionValueChange(option.id, valueIndex, newValue)}
                              autoComplete="off"
                            />
                          </div>
                        ))}
                      </BlockStack>

                      {/* Translate Button */}
                      <div>
                        <Button
                          onClick={() => onTranslate(option.id)}
                          loading={isTranslating && translatingOptionId === option.id}
                        >
                          {t.translateButton || "Translate entire option"}
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
