import { Card, BlockStack, Text, TextField, Button, InlineStack, Divider } from "@shopify/polaris";
import { useState } from "react";

interface ProductOption {
  id: string;
  name: string;
  position: number;
  values: string[];
}

interface ProductOptionsProps {
  options: ProductOption[];
  isPrimaryLocale: boolean;
  currentLanguage: string;
  translations: Record<string, { name: string; values: string[] }>;
  onTranslate: (optionId: string) => void;
  onOptionNameChange: (optionId: string, value: string) => void;
  onOptionValueChange: (optionId: string, valueIndex: number, value: string) => void;
  isTranslating: boolean;
  translatingOptionId?: string;
}

export function ProductOptions({
  options,
  isPrimaryLocale,
  currentLanguage,
  translations,
  onTranslate,
  onOptionNameChange,
  onOptionValueChange,
  isTranslating,
  translatingOptionId,
}: ProductOptionsProps) {
  if (!options || options.length === 0) {
    return null;
  }

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h3" variant="headingMd">
          Produktoptionen
        </Text>

        {isPrimaryLocale ? (
          // Read-only display in primary language
          <BlockStack gap="300">
            <Text as="p" variant="bodySm" tone="subdued">
              Optionen werden in der Hauptsprache nicht bearbeitet. Wechseln Sie zu einer Fremdsprache, um Übersetzungen hinzuzufügen.
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
                          Werte: {option.values.join(", ")}
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
              Übersetzen Sie die Optionsnamen und -werte für {currentLanguage}.
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
                          Original: <strong>{option.name}</strong> → {option.values.join(", ")}
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
                          label="Optionsname (übersetzt)"
                          value={translation.name || ""}
                          onChange={(value) => onOptionNameChange(option.id, value)}
                          autoComplete="off"
                        />
                      </div>

                      {/* Option Values Translation */}
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd" fontWeight="medium">
                          Werte (übersetzt)
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
                              label={`Wert ${valueIndex + 1}: "${value}"`}
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
                          Gesamte Option übersetzen
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
