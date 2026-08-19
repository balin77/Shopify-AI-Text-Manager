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

import { BlockStack, Text } from "@shopify/polaris";
import { FieldLabel } from "../unified/FieldChrome";
import { HexColorInput } from "./HexColorInput";
import type { FieldRenderProps } from "~/types/content-editor.types";

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
  const content = (t as { content?: Record<string, string> } | undefined)?.content ?? {};

  return (
    <BlockStack gap="150">
      <FieldLabel label={field.label} />
      <HexColorInput
        label={field.label}
        value={value}
        onChange={onChange}
        disabled={readOnly}
        invalidMessage={content.metaobjectEntryColorInvalid || "Enter a hex colour, e.g. #A1B2C3."}
        showBaseColors={!readOnly}
        baseColorsLabel={content.metaobjectColorBasePalette}
        conventionHint={content.metaobjectColorBaseConvention}
      />
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
