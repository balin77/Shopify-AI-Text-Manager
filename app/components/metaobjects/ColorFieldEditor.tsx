/**
 * The editor for a metaobject field of Shopify type `color`.
 *
 * Two controls on ONE value: a native colour picker (what a merchant reaches
 * for) and a hex text field (what they paste from a brand guide). Validation
 * uses `METAOBJECT_HEX_PATTERN`, which is the SAME shape `resolveSwatch`
 * accepts -- so a value this app writes is always one its own swatch preview
 * can paint. A second regex here would be free to drift into accepting colours
 * the preview then refuses to show.
 *
 * A colour has ONE value per shop, not one per locale, so this control is
 * read-only outside the primary language: its `translationKey` is empty and
 * `resolve()` short-circuits that to the primary value. Editable in a foreign
 * locale it would take the merchant's input and write it to the shop-wide
 * value -- a save that looks like a translation and changes something else.
 */

import { useMemo } from "react";
import { BlockStack, InlineStack, Text, TextField } from "@shopify/polaris";
import { METAOBJECT_HEX_PATTERN } from "~/services/metaobject-fields.shared";
import type { FieldRenderProps } from "~/types/content-editor.types";

/** The value the native `<input type="color">` can show: it accepts #rrggbb
 *  only, so #rgb is expanded and #rrggbbaa has its alpha dropped for the
 *  PICKER — the text field keeps the merchant's exact value either way. */
function pickerValue(raw: string): string {
  const trimmed = raw.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!METAOBJECT_HEX_PATTERN.test(withHash)) return "#000000";
  const body = withHash.slice(1);
  if (body.length === 3) return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  return `#${body.slice(0, 6)}`;
}

export function ColorFieldEditor({
  field,
  value,
  onChange,
  isPrimaryLocale = true,
  readOnly: editorReadOnly = false,
  t,
}: FieldRenderProps) {
  // Two independent reasons to lock: a foreign locale (a colour has ONE value
  // per shop) and the editor's own verdict (§7.2 — the definition refuses our
  // writes). Either is enough.
  const readOnly = !isPrimaryLocale || editorReadOnly;
  const invalid = useMemo(() => {
    if (value.trim() === "") return false;
    const withHash = value.trim().startsWith("#") ? value.trim() : `#${value.trim()}`;
    return !METAOBJECT_HEX_PATTERN.test(withHash);
  }, [value]);

  const content = (t as { content?: Record<string, string> } | undefined)?.content ?? {};

  return (
    <BlockStack gap="150">
      <Text as="span" variant="bodyMd" fontWeight="medium">
        {field.label}
      </Text>
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        <input
          type="color"
          aria-label={field.label}
          value={pickerValue(value)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "40px",
            height: "34px",
            padding: 0,
            border: "1px solid var(--p-color-border)",
            borderRadius: "6px",
            background: "none",
            cursor: readOnly ? "not-allowed" : "pointer",
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextField
            label={field.label}
            labelHidden
            value={value}
            onChange={onChange}
            autoComplete="off"
            disabled={readOnly}
            placeholder="#A1B2C3"
            error={invalid ? content.metaobjectEntryColorInvalid || "Enter a hex colour, e.g. #A1B2C3." : undefined}
          />
        </div>
      </InlineStack>
      {readOnly && (
        <Text as="span" variant="bodySm" tone="subdued">
          {/* Two causes, two different sentences. "Exists once per shop" is
              true of a foreign locale and FALSE of a §7.2 lock in the primary
              one, where the field is not writable at all. */}
          {!isPrimaryLocale
            ? content.attributesForeignLocale || "This value exists once per shop, not per language."
            : content.metaobjectEntryReadOnlyDefinition ||
              "This app cannot change entries of this definition."}
        </Text>
      )}
    </BlockStack>
  );
}
