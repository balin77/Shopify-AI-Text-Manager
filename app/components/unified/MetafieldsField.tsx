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
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { useSingleLocaleHint } from "../../contexts/LocaleAvailabilityContext";
import { SingleLineTextField } from "./SingleLineTextField";
import { FieldClearButton } from "./FieldChrome";
import {
  isListMetafieldType,
  isMetafieldValueEditable,
  isPrimaryMetafieldUnsaved,
  metafieldDisplayValue,
  metafieldInputErrors,
  type ListEntryError,
} from "../../services/product-metafields.shared";
import { isBatchTranslatableValueType } from "../../services/metaobject-fields.shared";
import "../../styles/AIEditableField.css";

/** A metafield whose value is multi-line by type; every other one is ONE line that wraps as it grows. */
function isMultiLineMetafield(type: string): boolean {
  return type === "multi_line_text_field" || type === "rich_text_field";
}

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

  /**
   * Metafields deleted on Shopify whose field is kept (cleared slots,
   * product-metafields.shared.ts). Shown in the PRIMARY language only, empty,
   * so a new value can be typed; never a translation target.
   */
  clearedMetafields?: MetafieldData[];

  /** Whether user is on primary locale */
  isPrimaryLocale: boolean;

  /** Current language code */
  currentLanguage: string;

  /** Translation data (indexed by metafield ID) */
  translations: Record<string, string>;

  /**
   * Metafield GIDs whose shown value is inherited from the global value while a
   * market is selected — greyed out + italic, like the main fields.
   */
  fallbackResourceIds?: Set<string>;

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

  /**
   * A primary save landed and the reload with the saved text has not: every
   * 🌍 would translate the text from BEFORE the save
   * (`SubResourceState.metafieldTranslationBlocked`).
   */
  translationBlocked?: boolean;

  /** Translation strings */
  t?: {
    title?: string;
    notEditableInPrimary?: string;
    translateInstruction?: string;
    translateButton?: string;
    originalLabel?: string;
    editInstructionPrimary?: string;
    /** "One entry per line." — the list editor's placeholder. */
    listHint?: string;
    /** Why a list is shown read-only. */
    listReadOnly?: string;
    /** Under a field whose metafield was deleted (a cleared slot). */
    clearedHint?: string;
    /** "Line {line}: {message}" */
    listErrorLine?: string;
    /** One message per `ListEntryErrorCode`, `{entry}` = the refused entry. */
    listErrors?: Partial<Record<ListEntryError["code"], string>>;
    /** Why the primary translate button waits: the field has an unsaved edit. */
    saveFirstSource?: string;
    /** Why translating waits while a landed save's reload is still out. */
    sourceReloading?: string;
    /** Why a 🌍 is off for a metafield that is not single-line text. */
    typeNotTranslatable?: string;
  };
}

/** Stable, locale-free order (codepoints — identical on server and client). */
function byMetafieldKey(a: MetafieldData, b: MetafieldData): number {
  const ka = `${a.namespace}.${a.key}`;
  const kb = `${b.namespace}.${b.key}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** The entry errors of a list field, phrased for the field itself. */
function listErrorMessages(errors: ListEntryError[], t: NonNullable<MetafieldsFieldProps["t"]>): string[] {
  return errors.map((error) => {
    const message = (t.listErrors?.[error.code] || error.code).replace("{entry}", error.entry);
    return error.line > 0
      ? (t.listErrorLine || "Line {line}: {message}")
          .replace("{line}", String(error.line))
          .replace("{message}", message)
      : message;
  });
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
  clearedMetafields = [],
  isPrimaryLocale,
  currentLanguage,
  translations,
  fallbackResourceIds,
  onTranslate,
  onMetafieldChange,
  onPrimaryMetafieldChange,
  primaryValues = {},
  translatingFieldIds = new Set(),
  translationBlocked = false,
  t = {},
}: MetafieldsFieldProps) {
  // Single-language shop → the metafield translate button has no target locale.
  const singleLocaleHint = useSingleLocaleHint();

  // The primary card shows the cleared fields too, in one order with the rest,
  // so a field the merchant just emptied stays where it was.
  const shown = isPrimaryLocale
    ? [...(metafields ?? []), ...clearedMetafields].sort(byMetafieldKey)
    : [...(metafields ?? [])].sort(byMetafieldKey);
  const clearedIds = new Set(clearedMetafields.map((mf) => mf.id));

  if (shown.length === 0) {
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
            {shown.map((mf, index) => {
              const currentValue = primaryValues[mf.id] !== undefined ? primaryValues[mf.id] : metafieldDisplayValue(mf);
              const fieldId = mf.id;
              const fieldLabel = `${mf.namespace}.${mf.key}`;
              const isList = isListMetafieldType(mf.type);
              const editable = isMetafieldValueEditable(mf);
              const isCleared = clearedIds.has(mf.id);
              // Translating to every language starts from the SAVED value: an
              // unsaved edit would be purged or re-translated by its own Save.
              // After a landed save the same holds until the reload brings the
              // saved text — the button would send the old one.
              // An unsaved edit is named first (it still blocks after the
              // reload); a reload alone only asks for a moment.
              const saveFirstHint = isPrimaryMetafieldUnsaved(mf, primaryValues[mf.id])
                ? t.saveFirstSource || "Save first — the main-language text has unsaved changes."
                : translationBlocked
                  ? t.sourceReloading || "One moment — the saved text is reloading."
                  : undefined;
              const translateHint = singleLocaleHint ?? saveFirstHint ?? typeTranslateHint(mf.type, t);
              const errors = editable ? listErrorMessages(metafieldInputErrors(mf.type, currentValue), t) : [];
              const errorNode = errors.length > 0 ? (
                <>
                  {errors.map((message, i) => (
                    <div key={i}>{message}</div>
                  ))}
                </>
              ) : undefined;

              return (
                <div key={mf.id}>
                  {index > 0 && <Divider />}
                  <Card>
                    <BlockStack gap="200">
                      {/* The header row is the clear button's scope: the
                          button sits on the label's line, the field below. */}
                      <div
                        className="app-field-clear-scope"
                        style={{ display: "flex", alignItems: "center", gap: "8px", justifyContent: "space-between" }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {fieldLabel}
                          </Text>
                          <Badge tone="info">{TYPE_LABELS[mf.type] || mf.type}</Badge>
                        </div>
                        {editable && currentValue !== "" && onPrimaryMetafieldChange && (
                          <FieldClearButton
                            onClear={() => onPrimaryMetafieldChange(mf.id, "")}
                            fieldLabel={fieldLabel}
                          />
                        )}
                      </div>
                      {!editable ? (
                        // A list whose value the one-entry-per-line form could
                        // not carry back unchanged: shown, never rewritten.
                        <TextField
                          label={fieldLabel}
                          labelHidden
                          value={mf.value}
                          onChange={() => {}}
                          autoComplete="off"
                          multiline={2}
                          readOnly
                          helpText={t.listReadOnly || "This list cannot be edited here without changing its value."}
                        />
                      ) : isList ? (
                        <TextField
                          label={fieldLabel}
                          labelHidden
                          value={currentValue}
                          onChange={(value) => onPrimaryMetafieldChange?.(mf.id, value)}
                          autoComplete="off"
                          multiline={3}
                          spellCheck={false}
                          placeholder={t.listHint || "One entry per line."}
                          error={errorNode}
                        />
                      ) : isMultiLineMetafield(mf.type) ? (
                        <TextField
                          label={fieldLabel}
                          labelHidden
                          value={currentValue}
                          onChange={(value) => onPrimaryMetafieldChange?.(mf.id, value)}
                          autoComplete="off"
                          multiline={3}
                        />
                      ) : (
                        <SingleLineTextField
                          label={fieldLabel}
                          labelHidden
                          value={currentValue}
                          onChange={(value) => onPrimaryMetafieldChange?.(mf.id, value)}
                        />
                      )}
                      {isCleared && currentValue === "" && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.clearedHint || "This metafield no longer has a value. Enter a new value and save to set it again."}
                        </Text>
                      )}
                      {onTranslate && !isCleared && (
                        <div className="ai-field-footer">
                          <div className="ai-field-footer-left" />
                          <div className="ai-field-footer-right">
                            <DisabledActionTooltip hint={translateHint}>
                              <Button
                                size="slim"
                                onClick={() => onTranslate(mf.id)}
                                loading={translatingFieldIds.has(fieldId)}
                                disabled={!!translateHint}
                              >
                                🌍 {t.translateButton || "Translate"}
                              </Button>
                            </DisabledActionTooltip>
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
            {shown.map((mf, index) => {
              const translation = translations[mf.id] || "";
              const hasTranslation = !!translation;
              const fieldId = mf.id;
              // The source is the cached primary value: wrong while a primary
              // save's reload is pending, unusable for a non-single-line type.
              const foreignTranslateHint = translationBlocked
                ? t.sourceReloading || "One moment — the saved text is reloading."
                : typeTranslateHint(mf.type, t);

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
                        <div className={`ai-editable-field-wrapper ${fallbackResourceIds?.has(mf.id) ? "bg-fallback" : (hasTranslation ? "bg-white" : "bg-untranslated")}`}>
                          {isMultiLineMetafield(mf.type) ? (
                            <TextField
                              label={`${mf.namespace}.${mf.key} (${currentLanguage})`}
                              value={translation}
                              onChange={(value) => onMetafieldChange(mf.id, value)}
                              autoComplete="off"
                              multiline={3}
                            />
                          ) : (
                            <SingleLineTextField
                              label={`${mf.namespace}.${mf.key} (${currentLanguage})`}
                              value={translation}
                              onChange={(value) => onMetafieldChange(mf.id, value)}
                            />
                          )}
                        </div>
                        <div className="ai-field-footer">
                          <div className="ai-field-footer-left" />
                          <div className="ai-field-footer-right">
                            <DisabledActionTooltip hint={foreignTranslateHint}>
                              <Button
                                size="slim"
                                onClick={() => onTranslate(mf.id)}
                                loading={translatingFieldIds.has(fieldId)}
                                disabled={!!foreignTranslateHint}
                              >
                                🌍 {t.translateButton || "Translate"}
                              </Button>
                            </DisabledActionTooltip>
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

/**
 * Why the 🌍 of this metafield is off, or `undefined` when it may run. Only a
 * single-line text survives the generic value translator: a multi-line value
 * loses its line breaks there and a list or rich text its JSON structure
 * (`isBatchTranslatableValueType`; the server refuses the same types).
 */
function typeTranslateHint(type: string, t: MetafieldsFieldProps["t"]): string | undefined {
  if (isBatchTranslatableValueType(type)) return undefined;
  return t?.typeNotTranslatable || "This metafield type cannot be translated automatically. Enter the translation by hand.";
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
