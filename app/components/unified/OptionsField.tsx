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
import type { ShopLocale } from "../../types/content-editor.types";
import { VariantOptionsEditor } from "./VariantOptionsEditor";
import "../../styles/AIEditableField.css";

export interface OptionValueData {
  id: string;  // gid://shopify/ProductOptionValue/...
  name: string;
  linked?: boolean;  // true = metaobject-linked value
  /** The METAOBJECT GID behind a linked value. The only identifier that
   *  addresses the entry itself — the option's `linkedMetafieldKey` is a
   *  metafield namespace/key and only coincides with the metaobject type for
   *  Shopify's own standard definitions. */
  linkedValue?: string;
}

export interface OptionData {
  id: string;
  name: string;
  position: number;
  values: OptionValueData[];
  isLinked?: boolean;  // true = metaobject-linked option
  /** The linked METAFIELD's `namespace--key` — see the note on OptionData in
   *  content-editor.types.ts. Not the metaobject definition type. */
  linkedMetafieldKey?: string;
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

  /** Bumped on every landed save, so the card can drop cached variant counts. */
  savedNonce?: number;
  /** Rendered inside the variants card, below a divider. */
  footer?: React.ReactNode;
  /** The product's GID — the variants editor asks how many variants hang off a
   *  value before offering to delete it. */
  productId?: string;
  /** Pending structural edits, so the card can show them before the save. */
  valuesToAdd?: Record<string, string[]>;
  linkedValuesToAdd?: Record<string, Array<{ id: string; name: string }>>;
  valuesToDelete?: Record<string, string[]>;
  optionsToCreate?: Array<{ name: string; values: string[] }>;
  optionsToDelete?: string[];
  onAddOptionValue?: (optionId: string, name: string) => void;
  onAddLinkedOptionValue?: (optionId: string, entry: { id: string; name: string }) => void;
  onRemoveLinkedOptionValue?: (optionId: string, entryId: string) => void;
  onRemoveOptionValue?: (optionId: string, valueId: string, addedIndex?: number) => void;
  onEditPendingValue?: (optionId: string, index: number, name: string) => void;
  onCreateOption?: (name: string, values: string[]) => void;
  onCancelCreateOption?: (index: number) => void;
  onDeleteOption?: (optionId: string) => void;
  onReorderOptions?: (orderedIds: string[]) => void;
  onReorderOptionValues?: (optionId: string, orderedValueIds: string[]) => void;

  /** Set of field IDs currently being translated (e.g. "optId:name", "optId:value:0") */
  translatingFieldIds?: Set<string>;

  /** Set of option/value IDs that have missing translations in at least one foreign locale.
   *  Only used in primary locale view to show blue highlight. */
  missingTranslationIds?: Set<string>;

  /** Translation strings */
  t?: {
    title?: string;
    /** Heading for a product that has no options yet — see VariantOptionsEditor. */
    titleNoVariants?: string;
    notEditableInPrimary?: string;
    editInstructionPrimary?: string;
    translateInstruction?: string;
    optionNameLabel?: string;
    valuesLabel?: string;
    valueLabel?: string;
    /** Header button: translates the option name AND its values in one call.
     *  Not shown for metaobject-linked options — see the header comment. */
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
    /** The variants card's own vocabulary. */
    addOption?: string;
    optionNamePlaceholder?: string;
    deleteOption?: string;
    deleteOptionTitle?: string;
    editMetaobject?: string;
    choicesUnavailable?: string;
    choicesAllUsed?: string;
    choicesTruncated?: string;
    choicesSyncedAt?: string;
    loading?: string;
    deleteValueTitle?: string;
    deleteOptionConfirm?: string;
    deleteValueCount?: string;
    deleteValueUnknown?: string;
    pendingBadge?: string;
    done?: string;
    cancel?: string;
    add?: string;
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
  productId = "",
  savedNonce = 0,
  footer,
  valuesToAdd = {},
  linkedValuesToAdd = {},
  valuesToDelete = {},
  optionsToCreate = [],
  optionsToDelete = [],
  onAddOptionValue,
  onAddLinkedOptionValue,
  onRemoveLinkedOptionValue,
  onRemoveOptionValue,
  onEditPendingValue,
  onCreateOption,
  onCancelCreateOption,
  onDeleteOption,
  onReorderOptions,
  onReorderOptionValues,
  translatingFieldIds = new Set(),
  missingTranslationIds,
  t = {},
}: OptionsFieldProps) {
  const { locale: appLocale } = useI18n();
  const { handleNavigate } = useAppNavigation();

  // Navigate to metaobjects page with optional type pre-selection
  const navigateToMetaobjects = (option: OptionData) => {
    // The entry's own GID first: it addresses one metaobject unambiguously and
    // lands the merchant ON it. `linkedMetafieldKey` is a metafield
    // namespace/key ("custom--material") and equals the metaobject type only
    // for Shopify's standard definitions, where the two happen to be spelled
    // the same; for a custom one it matches nothing and the page opens blank.
    const linkedGid = option.values.find((v) => v.linkedValue)?.linkedValue;
    const selectValue = linkedGid || option.linkedMetafieldKey || option.name;
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

  // A product without options still gets the primary card: that is where "add
  // a variant" lives, and a single-variant product is the one that needs it.
  // In a foreign locale there is nothing to translate, so nothing renders.
  if ((!options || options.length === 0) && !isPrimaryLocale) {
    return null;
  }

  // The primary editor brings its own Card: its header row hosts the "add"
  // button, which a shared wrapper could not. The FOREIGN branch below is a
  // different job — it edits TRANSLATIONS of the same values, and must not
  // gain a delete button.
  if (isPrimaryLocale) {
    return (
      <VariantOptionsEditor
        productId={productId}
        options={options}
        primaryOptions={primaryOptions}
        valuesToAdd={valuesToAdd}
        linkedValuesToAdd={linkedValuesToAdd}
        valuesToDelete={valuesToDelete}
        optionsToCreate={optionsToCreate}
        optionsToDelete={optionsToDelete}
        onNameChange={(id, value) => onPrimaryOptionNameChange?.(id, value)}
        onValuesChange={(id, values) => onPrimaryOptionValuesChange?.(id, values)}
        onAddValue={(id, name) => onAddOptionValue?.(id, name)}
        onAddLinkedValue={(id, entry) => onAddLinkedOptionValue?.(id, entry)}
        onRemoveLinkedValue={(id, entryId) => onRemoveLinkedOptionValue?.(id, entryId)}
        onRemoveValue={(id, valueId, addedIndex) => onRemoveOptionValue?.(id, valueId, addedIndex)}
        onEditPendingValue={(id, index, name) => onEditPendingValue?.(id, index, name)}
        onCreateOption={(name, values) => onCreateOption?.(name, values)}
        onCancelCreateOption={(index) => onCancelCreateOption?.(index)}
        onDeleteOption={(id) => onDeleteOption?.(id)}
        onReorder={(ids) => onReorderOptions?.(ids)}
        onReorderValues={(id, valueIds) => onReorderOptionValues?.(id, valueIds)}
        onOpenMetaobjects={navigateToMetaobjects}
        onTranslate={onTranslate}
        translatingFieldIds={translatingFieldIds}
        savedNonce={savedNonce}
        footer={footer}
        t={t as Record<string, string | undefined>}
      />
    );
  }

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h3" variant="headingMd" fontWeight="bold">
          {t.title || "Variants"}
        </Text>

        {(
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
                          {/* The option's own NAME, not "Option 1". A position
                              names where a card sits, which the merchant can
                              already see; the name says what is being edited. */}
                          <Text as="p" variant="bodyMd" fontWeight="semibold" breakWord={false}>
                            {option.name}
                          </Text>
                          {option.isLinked && (
                            <Badge tone="info">{t.linkedBadge || "Metaobject"}</Badge>
                          )}
                        </div>
                        {/* Same as in the primary view: redundant for a linked
                            option, whose name field carries the identical action. */}
                        {!option.isLinked && (
                          <Button
                            size="slim"
                            onClick={() => onTranslate(option.id)}
                            loading={translatingFieldIds.has(entireFieldId)}
                          >
                            🌍 {t.translateButton || "Translate option"}
                          </Button>
                        )}
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
