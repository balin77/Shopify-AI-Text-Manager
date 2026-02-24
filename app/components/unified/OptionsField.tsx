/**
 * OptionsField - Component for editing and translating product options
 *
 * - Product options (Size, Color, Material, etc.)
 * - Editable fields in primary locale (direct value editing)
 * - Editable translation fields in foreign locales
 * - AI translation support (per field + entire option)
 * - Color-coded backgrounds (orange = not translated) matching AIEditableField styling
 * - Distinguishes regular options (name + values translatable)
 *   from linked/metaobject options (excluded from primary editing)
 */

import { Card, BlockStack, Text, TextField, Button, Divider, Badge, Banner, Icon, InlineStack } from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { useI18n } from "../../contexts/I18nContext";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";
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
  linkedMetaobjectType?: string;  // metaobject definition type handle (e.g. "color")
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

  /** Shop locales array for language name resolution */
  shopLocales: any[];

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

  /** Callback when primary option name changes (optional, for primary locale editing) */
  onPrimaryOptionNameChange?: (optionId: string, value: string) => void;

  /** Callback when primary option values change (optional, for primary locale editing) */
  onPrimaryOptionValuesChange?: (optionId: string, values: string[]) => void;

  /** Primary option data (indexed by option ID) - used when editing primary locale */
  primaryOptions?: Record<string, { name: string; values: string[] }>;

  /** Set of field IDs currently being translated (e.g. "optId:name", "optId:value:0") */
  translatingFieldIds?: Set<string>;

  /** Translation strings */
  t?: {
    title?: string;
    notEditableInPrimary?: string;
    editInstructionPrimary?: string;
    translateInstruction?: string;
    optionNameLabel?: string;
    valuesLabel?: string;
    valueLabel?: string;
    translateButton?: string;
    translateFieldButton?: string;
    originalLabel?: string;
    linkedOptionHint?: string;
    linkedOptionHintBefore?: string;
    linkedOptionHintAfter?: string;
    linkedBadge?: string;
    addValue?: string;
    removeValue?: string;
    linkedNotEditableHint?: string;
    linkedNotEditableHintBefore?: string;
    linkedNotEditableHintAfter?: string;
    metaobjectsLinkText?: string;
    optionPositionLabel?: string;
    clearButton?: string;
  };
}

export function OptionsField({
  options,
  isPrimaryLocale,
  currentLanguage,
  shopLocales,
  translations,
  onTranslate,
  onTranslateField,
  onOptionNameChange,
  onOptionValueChange,
  onPrimaryOptionNameChange,
  onPrimaryOptionValuesChange,
  primaryOptions = {},
  translatingFieldIds = new Set(),
  t = {},
}: OptionsFieldProps) {
  const { locale: appLocale } = useI18n();
  const { handleNavigate } = useAppNavigation();

  // Navigate to metaobjects page with optional type pre-selection
  const navigateToMetaobjects = (option: OptionData) => {
    const selectValue = option.linkedMetaobjectType || option.name;
    handleNavigate("/app/metaobjects", {
      searchParams: new URLSearchParams({ select: selectValue }),
    });
  };

  // Get localized language name (e.g., "English", "German" instead of "en", "de")
  const localeName = getLocalizedLanguageName(
    currentLanguage,
    appLocale,
    shopLocales.find((l: any) => l.locale === currentLanguage)?.name
  );

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
          // Editable fields in primary language
          <BlockStack gap="300">
            {options.map((option, index) => {
              // Get current values from primaryOptions state, fallback to original option data
              const currentName = primaryOptions[option.id]?.name !== undefined
                ? primaryOptions[option.id].name
                : option.name;
              const currentValues = primaryOptions[option.id]?.values !== undefined
                ? primaryOptions[option.id].values
                : option.values.map(v => v.name);

              // Handler for individual value changes (no add/remove)
              const handleValueChange = (valueIndex: number, newValue: string) => {
                const updatedValues = [...currentValues];
                updatedValues[valueIndex] = newValue;
                onPrimaryOptionValuesChange?.(option.id, updatedValues);
              };

              const nameFieldId = `${option.id}:name`;

              return (
                <div key={option.id}>
                  <Card>
                    <BlockStack gap="300">
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {t.optionPositionLabel || "Option"} {option.position}
                          </Text>
                          {option.isLinked && (
                            <Badge tone="info">{t.linkedBadge || "Metaobject"}</Badge>
                          )}
                        </div>
                        {/* Translate Entire Option Button — on same line as Option header */}
                        {onTranslate && (
                          <Button
                            size="slim"
                            onClick={() => onTranslate(option.id)}
                            loading={translatingFieldIds.has(`${option.id}:entire`)}
                          >
                            🌍 {t.translateButton || (option.isLinked ? "Translate option name" : "Translate entire option")}
                          </Button>
                        )}
                      </div>

                      {option.isLinked ? (
                        // Metaobject-linked options: Only option name is editable, values are not
                        <>
                          {/* Option Name — editable for metaobjects */}
                          <div>
                            <div className="ai-editable-field-wrapper bg-white" style={{ position: "relative" }}>
                              {currentName && (
                                <div style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
                                  <Button
                                    size="slim"
                                    onClick={() => onPrimaryOptionNameChange?.(option.id, "")}
                                    tone="critical"
                                    variant="plain"
                                  >
                                    {t.clearButton || "Clear"}
                                  </Button>
                                </div>
                              )}
                              <TextField
                                label={
                                  <span style={{ fontWeight: 600 }}>
                                    {t.optionNameLabel || "Name"} <span style={{ color: 'var(--p-color-text-critical)' }}>*</span>
                                  </span>
                                }
                                value={currentName}
                                onChange={(value) => onPrimaryOptionNameChange?.(option.id, value)}
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
                                    loading={translatingFieldIds.has(nameFieldId)}
                                  >
                                    🌍 {t.translateFieldButton || t.translateButton || "Translate"}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Info banner about values — link to metaobjects page */}
                          <Banner tone="info">
                            <p>
                              {t.linkedNotEditableHintBefore || "The values of this option are linked to metaobjects. You can edit them under "}
                              <span
                                role="link"
                                tabIndex={0}
                                onClick={() => navigateToMetaobjects(option)}
                                onKeyDown={(e) => e.key === "Enter" && navigateToMetaobjects(option)}
                                style={{ textDecoration: "underline", color: "var(--p-color-text-interactive)", cursor: "pointer" }}
                              >
                                {t.metaobjectsLinkText || "Metaobjects"}
                              </span>
                              {t.linkedNotEditableHintAfter || "."}
                            </p>
                          </Banner>
                        </>
                      ) : (
                        <>
                          {/* Option Name */}
                          <div>
                            <div className="ai-editable-field-wrapper bg-white" style={{ position: "relative" }}>
                              {currentName && (
                                <div style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
                                  <Button
                                    size="slim"
                                    onClick={() => onPrimaryOptionNameChange?.(option.id, "")}
                                    tone="critical"
                                    variant="plain"
                                  >
                                    {t.clearButton || "Clear"}
                                  </Button>
                                </div>
                              )}
                              <TextField
                                label={
                                  <span style={{ fontWeight: 600 }}>
                                    {t.optionNameLabel || "Name"} <span style={{ color: 'var(--p-color-text-critical)' }}>*</span>
                                  </span>
                                }
                                value={currentName}
                                onChange={(value) => onPrimaryOptionNameChange?.(option.id, value)}
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
                                    loading={translatingFieldIds.has(nameFieldId)}
                                  >
                                    🌍 {t.translateFieldButton || t.translateButton || "Translate"}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Option Values */}
                          <BlockStack gap="200">
                            <Text as="p" variant="bodyMd" fontWeight="semibold">
                              {t.valuesLabel || "Values"} <span style={{ color: 'var(--p-color-text-critical)' }}>*</span>
                            </Text>
                            {currentValues.map((value, valueIndex) => {
                              const valueFieldId = `${option.id}:value:${valueIndex}`;
                              const originalValue = option.values[valueIndex]?.name;
                              return (
                                <div key={valueIndex}>
                                  <div className="ai-editable-field-wrapper bg-white" style={{ position: "relative" }}>
                                    {value && (
                                      <div style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
                                        <Button
                                          size="slim"
                                          onClick={() => handleValueChange(valueIndex, "")}
                                          tone="critical"
                                          variant="plain"
                                        >
                                          Clear
                                        </Button>
                                      </div>
                                    )}
                                    <TextField
                                      label={`${t.valueLabel || "Value"} ${valueIndex + 1}`}
                                      value={value}
                                      onChange={(newValue) => handleValueChange(valueIndex, newValue)}
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
                                          loading={translatingFieldIds.has(valueFieldId)}
                                        >
                                          🌍 {t.translateFieldButton || t.translateButton || "Translate"}
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </BlockStack>
                        </>
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
            {options.map((option, index) => {
              const translation = translations[option.id] || { name: "", values: [] };
              const nameFieldId = `${option.id}:name`;

              return (
                <div key={option.id}>
                  <Card>
                    <BlockStack gap="300">
                      {/* Option header with translate button */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {t.optionPositionLabel || "Option"} {option.position}
                          </Text>
                          {option.isLinked && (
                            <Badge tone="info">{t.linkedBadge || "Metaobject"}</Badge>
                          )}
                        </div>
                        <Button
                          size="slim"
                          onClick={() => onTranslate(option.id)}
                          loading={translatingFieldIds.has(`${option.id}:entire`)}
                        >
                          🌍 {t.translateButton || "Translate entire option"}
                        </Button>
                      </div>

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
                        <div className={`ai-editable-field-wrapper ${translation.name ? "bg-white" : "bg-untranslated"}`} style={{ position: "relative" }}>
                          {translation.name && (
                            <div style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
                              <Button
                                size="slim"
                                onClick={() => onOptionNameChange(option.id, "")}
                                tone="critical"
                                variant="plain"
                              >
                                Clear
                              </Button>
                            </div>
                          )}
                          <TextField
                            label={
                              <span style={{ fontWeight: 600 }}>
                                {t.optionNameLabel || `Name (${localeName})`}
                              </span>
                            }
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
                                loading={translatingFieldIds.has(nameFieldId)}
                              >
                                🌍 {t.translateFieldButton || t.translateButton || "Translate"}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Option Values Translation — only for regular (non-linked) options */}
                      {!option.isLinked ? (
                        <BlockStack gap="200">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {t.valuesLabel || "Values"} ({localeName})
                          </Text>
                          {option.values.map((optVal, valueIndex) => {
                            const valueFieldId = `${option.id}:value:${valueIndex}`;
                            return (
                              <div key={optVal.id || valueIndex}>
                                <div className={`ai-editable-field-wrapper ${translation.values[valueIndex] ? "bg-white" : "bg-untranslated"}`} style={{ position: "relative" }}>
                                  {translation.values[valueIndex] && (
                                    <div style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
                                      <Button
                                        size="slim"
                                        onClick={() => onOptionValueChange(option.id, valueIndex, "")}
                                        tone="critical"
                                        variant="plain"
                                      >
                                        {t.clearButton || "Clear"}
                                      </Button>
                                    </div>
                                  )}
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
                                        loading={translatingFieldIds.has(valueFieldId)}
                                      >
                                        🌍 {t.translateFieldButton || t.translateButton || "Translate"}
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
                            {t.linkedOptionHintBefore || "The values of this option are metaobjects and can be translated under "}
                            <span
                              role="link"
                              tabIndex={0}
                              onClick={() => navigateToMetaobjects(option)}
                              onKeyDown={(e) => e.key === "Enter" && navigateToMetaobjects(option)}
                              style={{ textDecoration: "underline", color: "var(--p-color-text-interactive)", cursor: "pointer" }}
                            >
                              {t.metaobjectsLinkText || "Metaobjects"}
                            </span>
                            {t.linkedOptionHintAfter || "."}
                          </p>
                        </Banner>
                      )}

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
