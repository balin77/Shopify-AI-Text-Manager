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
import { useSingleLocaleHint } from "../../contexts/LocaleAvailabilityContext";
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";
import type { ShopLocale } from "../../types/content-editor.types";
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
  shopLocales: ShopLocale[];

  /** Translation data (indexed by option ID) */
  translations: Record<string, OptionTranslation>;

  /**
   * Resource GIDs (option.id for the name, value.id for a value) whose shown
   * value is inherited from the global value while a market is selected — greyed
   * out + italic, like the main fields.
   */
  fallbackResourceIds?: Set<string>;

  /** Callback to translate entire option */
  onTranslate: (optionId: string) => void;

  /** Callback to translate a single field (option name or value) */
  onTranslateField?: (optionId: string, fieldType: "name" | "value", valueIndex?: number) => void;

  /** Callback to copy the primary locale value to the current foreign locale */
  onCopyField?: (optionId: string, fieldType: "name" | "value", valueIndex?: number) => void;

  /** Callback to copy the primary locale value to all foreign locales */
  onCopyFieldToAllLocales?: (optionId: string, fieldType: "name" | "value", valueIndex?: number) => void;

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

  /** Set of option/value IDs that have missing translations in at least one foreign locale.
   *  Only used in primary locale view to show blue highlight. */
  missingTranslationIds?: Set<string>;

  /** Translation strings */
  t?: {
    title?: string;
    notEditableInPrimary?: string;
    editInstructionPrimary?: string;
    translateInstruction?: string;
    optionNameLabel?: string;
    valuesLabel?: string;
    valueLabel?: string;
    /** Header button, unlinked option: translates name AND values. */
    translateButton?: string;
    /** Header button, metaobject-linked option: only the name is translatable. */
    translateOptionNameButton?: string;
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
    copyButton?: string;
    copyToAllLocalesButton?: string;
  };
}

export function OptionsField({
  options,
  isPrimaryLocale,
  currentLanguage,
  shopLocales,
  translations,
  fallbackResourceIds,
  onTranslate,
  onTranslateField,
  onCopyField,
  onCopyFieldToAllLocales,
  onOptionNameChange,
  onOptionValueChange,
  onPrimaryOptionNameChange,
  onPrimaryOptionValuesChange,
  primaryOptions = {},
  translatingFieldIds = new Set(),
  missingTranslationIds,
  t = {},
}: OptionsFieldProps) {
  const { locale: appLocale } = useI18n();
  const { handleNavigate } = useAppNavigation();
  // Single-language shop → the option translate buttons have no target locale.
  const singleLocaleHint = useSingleLocaleHint();

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
    shopLocales.find((l: ShopLocale) => l.locale === currentLanguage)?.name
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
              const entireFieldId = `${option.id}:entire`;

              return (
                <div key={option.id}>
                  <Card>
                    <BlockStack gap="300">
                      {/* `flexWrap` lets the button drop to its own line on a
                          phone instead of squeezing "Option 1" into two lines;
                          the title itself never breaks. */}
                      <div className="option-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                          <Text as="p" variant="bodyMd" fontWeight="semibold" breakWord={false}>
                            <span style={{ whiteSpace: "nowrap" }}>
                              {t.optionPositionLabel || "Option"} {option.position}
                            </span>
                          </Text>
                          {option.isLinked && (
                            <Badge tone="info">{t.linkedBadge || "Metaobject"}</Badge>
                          )}
                        </div>
                        {/* Translate Entire Option Button — on same line as Option header.
                            A metaobject-linked option only has its NAME to translate
                            (the values live in the metaobjects), so it says so. */}
                        {onTranslate && (
                          <DisabledActionTooltip hint={singleLocaleHint}>
                            <Button
                              size="slim"
                              onClick={() => onTranslate(option.id)}
                              loading={translatingFieldIds.has(entireFieldId)}
                              disabled={!!singleLocaleHint}
                            >
                              🌍 {option.isLinked
                                ? (t.translateOptionNameButton || "Translate name")
                                : (t.translateButton || "Translate option")}
                            </Button>
                          </DisabledActionTooltip>
                        )}
                      </div>

                      {option.isLinked ? (
                        // Metaobject-linked options: Only option name is editable, values are not
                        <>
                          {/* Option Name — editable for metaobjects */}
                          <div>
                            <div className={`ai-editable-field-wrapper ${missingTranslationIds?.has(option.id) ? "bg-missing-translation" : "bg-white"}`} style={{ position: "relative" }}>
                              <div className="field-clear-overlay" style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
                                {currentName && (
                                  <Button
                                    size="slim"
                                    onClick={() => onPrimaryOptionNameChange?.(option.id, "")}
                                    tone="critical"
                                    variant="plain"
                                  >
                                    {t.clearButton || "Clear"}
                                  </Button>
                                )}
                              </div>
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
                            {(onTranslateField || onCopyFieldToAllLocales) && (
                              <div className="ai-field-footer">
                                <div className="ai-field-footer-left" />
                                <div className="ai-field-footer-right">
                                  {onTranslateField && (
                                    <DisabledActionTooltip hint={singleLocaleHint}>
                                      <Button
                                        size="slim"
                                        onClick={() => onTranslateField(option.id, "name")}
                                        loading={translatingFieldIds.has(nameFieldId) || translatingFieldIds.has(entireFieldId)}
                                        disabled={!!singleLocaleHint}
                                      >
                                        🌍 {t.translateFieldButton || t.translateButton || "Translate"}
                                      </Button>
                                    </DisabledActionTooltip>
                                  )}
                                  {onCopyFieldToAllLocales && (
                                    <DisabledActionTooltip hint={singleLocaleHint}>
                                      <Button
                                        size="slim"
                                        onClick={() => onCopyFieldToAllLocales(option.id, "name")}
                                        loading={translatingFieldIds.has(nameFieldId) || translatingFieldIds.has(entireFieldId)}
                                        disabled={!currentName || translatingFieldIds.has(nameFieldId) || translatingFieldIds.has(entireFieldId) || !!singleLocaleHint}
                                      >
                                        📋 {t.copyToAllLocalesButton || "Copy to all languages"}
                                      </Button>
                                    </DisabledActionTooltip>
                                  )}
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
                            <div className={`ai-editable-field-wrapper ${missingTranslationIds?.has(option.id) ? "bg-missing-translation" : "bg-white"}`} style={{ position: "relative" }}>
                              <div className="field-clear-overlay" style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
                                {currentName && (
                                  <Button
                                    size="slim"
                                    onClick={() => onPrimaryOptionNameChange?.(option.id, "")}
                                    tone="critical"
                                    variant="plain"
                                  >
                                    {t.clearButton || "Clear"}
                                  </Button>
                                )}
                              </div>
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
                            {(onTranslateField || onCopyFieldToAllLocales) && (
                              <div className="ai-field-footer">
                                <div className="ai-field-footer-left" />
                                <div className="ai-field-footer-right">
                                  {onTranslateField && (
                                    <DisabledActionTooltip hint={singleLocaleHint}>
                                      <Button
                                        size="slim"
                                        onClick={() => onTranslateField(option.id, "name")}
                                        loading={translatingFieldIds.has(nameFieldId) || translatingFieldIds.has(entireFieldId)}
                                        disabled={!!singleLocaleHint}
                                      >
                                        🌍 {t.translateFieldButton || t.translateButton || "Translate"}
                                      </Button>
                                    </DisabledActionTooltip>
                                  )}
                                  {onCopyFieldToAllLocales && (
                                    <DisabledActionTooltip hint={singleLocaleHint}>
                                      <Button
                                        size="slim"
                                        onClick={() => onCopyFieldToAllLocales(option.id, "name")}
                                        loading={translatingFieldIds.has(nameFieldId) || translatingFieldIds.has(entireFieldId)}
                                        disabled={!currentName || translatingFieldIds.has(nameFieldId) || translatingFieldIds.has(entireFieldId) || !!singleLocaleHint}
                                      >
                                        📋 {t.copyToAllLocalesButton || "Copy to all languages"}
                                      </Button>
                                    </DisabledActionTooltip>
                                  )}
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
                                  <div className={`ai-editable-field-wrapper ${missingTranslationIds?.has(option.values[valueIndex]?.id) ? "bg-missing-translation" : "bg-white"}`} style={{ position: "relative" }}>
                                    <div className="field-clear-overlay" style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
                                      {value && (
                                        <Button
                                          size="slim"
                                          onClick={() => handleValueChange(valueIndex, "")}
                                          tone="critical"
                                          variant="plain"
                                        >
                                          {t.clearButton || "Clear"}
                                        </Button>
                                      )}
                                    </div>
                                    <TextField
                                      label={`${t.valueLabel || "Value"} ${valueIndex + 1}`}
                                      value={value}
                                      onChange={(newValue) => handleValueChange(valueIndex, newValue)}
                                      autoComplete="off"
                                    />
                                  </div>
                                  {(onTranslateField || onCopyFieldToAllLocales) && (
                                    <div className="ai-field-footer">
                                      <div className="ai-field-footer-left" />
                                      <div className="ai-field-footer-right">
                                        {onTranslateField && (
                                          <DisabledActionTooltip hint={singleLocaleHint}>
                                            <Button
                                              size="slim"
                                              onClick={() => onTranslateField(option.id, "value", valueIndex)}
                                              loading={translatingFieldIds.has(valueFieldId) || translatingFieldIds.has(entireFieldId)}
                                              disabled={!!singleLocaleHint}
                                            >
                                              🌍 {t.translateFieldButton || t.translateButton || "Translate"}
                                            </Button>
                                          </DisabledActionTooltip>
                                        )}
                                        {onCopyFieldToAllLocales && (
                                          <DisabledActionTooltip hint={singleLocaleHint}>
                                            <Button
                                              size="slim"
                                              onClick={() => onCopyFieldToAllLocales(option.id, "value", valueIndex)}
                                              loading={translatingFieldIds.has(valueFieldId) || translatingFieldIds.has(entireFieldId)}
                                              disabled={!value || translatingFieldIds.has(valueFieldId) || translatingFieldIds.has(entireFieldId) || !!singleLocaleHint}
                                            >
                                              📋 {t.copyToAllLocalesButton || "Copy to all languages"}
                                            </Button>
                                          </DisabledActionTooltip>
                                        )}
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
              const entireFieldId = `${option.id}:entire`;

              return (
                <div key={option.id}>
                  <Card>
                    <BlockStack gap="300">
                      {/* Option header with translate button (same wrapping
                          rules as the primary-locale header above) */}
                      <div className="option-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                          <Text as="p" variant="bodyMd" fontWeight="semibold" breakWord={false}>
                            <span style={{ whiteSpace: "nowrap" }}>
                              {t.optionPositionLabel || "Option"} {option.position}
                            </span>
                          </Text>
                          {option.isLinked && (
                            <Badge tone="info">{t.linkedBadge || "Metaobject"}</Badge>
                          )}
                        </div>
                        <Button
                          size="slim"
                          onClick={() => onTranslate(option.id)}
                          loading={translatingFieldIds.has(entireFieldId)}
                        >
                          🌍 {option.isLinked
                            ? (t.translateOptionNameButton || "Translate name")
                            : (t.translateButton || "Translate option")}
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
                        <div className={`ai-editable-field-wrapper ${fallbackResourceIds?.has(option.id) ? "bg-fallback" : (translation.name ? "bg-white" : "bg-untranslated")}`} style={{ position: "relative" }}>
                          <div className="field-clear-overlay" style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
                            {translation.name && (
                              <Button
                                size="slim"
                                onClick={() => onOptionNameChange(option.id, "")}
                                tone="critical"
                                variant="plain"
                              >
                                {t.clearButton || "Clear"}
                              </Button>
                            )}
                          </div>
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
                        {(onTranslateField || onCopyField) && (
                          <div className="ai-field-footer">
                            <div className="ai-field-footer-left" />
                            <div className="ai-field-footer-right">
                              {onTranslateField && (
                                <Button
                                  size="slim"
                                  onClick={() => onTranslateField(option.id, "name")}
                                  loading={translatingFieldIds.has(nameFieldId) || translatingFieldIds.has(entireFieldId)}
                                >
                                  🌍 {t.translateFieldButton || t.translateButton || "Translate"}
                                </Button>
                              )}
                              {onCopyField && (
                                <Button
                                  size="slim"
                                  onClick={() => onCopyField(option.id, "name")}
                                  loading={translatingFieldIds.has(nameFieldId) || translatingFieldIds.has(entireFieldId)}
                                  disabled={!option.name || translatingFieldIds.has(nameFieldId) || translatingFieldIds.has(entireFieldId)}
                                >
                                  📋 {t.copyButton || "Copy"}
                                </Button>
                              )}
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
                                <div className={`ai-editable-field-wrapper ${fallbackResourceIds?.has(optVal.id) ? "bg-fallback" : (translation.values[valueIndex] ? "bg-white" : "bg-untranslated")}`} style={{ position: "relative" }}>
                                  <div className="field-clear-overlay" style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
                                    {translation.values[valueIndex] && (
                                      <Button
                                        size="slim"
                                        onClick={() => onOptionValueChange(option.id, valueIndex, "")}
                                        tone="critical"
                                        variant="plain"
                                      >
                                        {t.clearButton || "Clear"}
                                      </Button>
                                    )}
                                  </div>
                                  <TextField
                                    label={`${t.valueLabel || "Value"} ${valueIndex + 1}: "${optVal.name}"`}
                                    value={translation.values[valueIndex] || ""}
                                    onChange={(newValue) => onOptionValueChange(option.id, valueIndex, newValue)}
                                    autoComplete="off"
                                  />
                                </div>
                                {(onTranslateField || onCopyField) && (
                                  <div className="ai-field-footer">
                                    <div className="ai-field-footer-left" />
                                    <div className="ai-field-footer-right">
                                      {onTranslateField && (
                                        <Button
                                          size="slim"
                                          onClick={() => onTranslateField(option.id, "value", valueIndex)}
                                          loading={translatingFieldIds.has(valueFieldId) || translatingFieldIds.has(entireFieldId)}
                                        >
                                          🌍 {t.translateFieldButton || t.translateButton || "Translate"}
                                        </Button>
                                      )}
                                      {onCopyField && (
                                        <Button
                                          size="slim"
                                          onClick={() => onCopyField(option.id, "value", valueIndex)}
                                          loading={translatingFieldIds.has(valueFieldId) || translatingFieldIds.has(entireFieldId)}
                                          disabled={!optVal.name || translatingFieldIds.has(valueFieldId) || translatingFieldIds.has(entireFieldId)}
                                        >
                                          📋 {t.copyButton || "Copy"}
                                        </Button>
                                      )}
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
