/**
 * A hex colour, as two controls on one value.
 *
 * A native colour picker (what a merchant reaches for) and a hex text field
 * (what they paste from a brand guide). Validation uses `METAOBJECT_HEX_PATTERN`,
 * the SAME shape `resolveSwatch` accepts -- so a value written here is always
 * one this app's own swatch preview can paint. A second regex would be free to
 * drift into accepting colours the preview then refuses to show.
 *
 * ONE control, two hosts: the entry editor's `ColorFieldEditor` and the CREATE
 * modal both render it. They used to be one control and no control -- the
 * create form offered no colour field at all, so a new colour entry came out
 * without its colour and had to be edited straight afterwards. Two separate
 * implementations would have come to disagree about what a valid hex is, which
 * is the same rule the taxonomy picker follows.
 */

import { InlineStack, TextField } from "@shopify/polaris";
import { METAOBJECT_HEX_PATTERN } from "~/services/metaobject-fields.shared";

/** The value the native `<input type="color">` can show: it accepts #rrggbb
 *  only, so #rgb is expanded and #rrggbbaa has its alpha dropped for the
 *  PICKER — the text field keeps the merchant's exact value either way. */
export function hexPickerValue(raw: string): string {
  const trimmed = (raw ?? "").trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!METAOBJECT_HEX_PATTERN.test(withHash)) return "#000000";
  const body = withHash.slice(1);
  if (body.length === 3) return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  return `#${body.slice(0, 6)}`;
}

/** True for a non-empty value that is not a hex colour. Empty is not invalid —
 *  it means "not set", and Shopify's own required-field validation decides
 *  whether that is allowed. */
export function hexIsInvalid(raw: string): boolean {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return false;
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return !METAOBJECT_HEX_PATTERN.test(withHash);
}

export interface HexColorInputProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Shown under the field. A host may pass its own validation message. */
  error?: string;
  /** Overrides the built-in "that is not a hex colour" message. */
  invalidMessage?: string;
  helpText?: string;
}

export function HexColorInput({
  label,
  value,
  onChange,
  disabled = false,
  error,
  invalidMessage,
  helpText,
}: HexColorInputProps) {
  const invalid = hexIsInvalid(value);
  return (
    <InlineStack gap="200" blockAlign="center" wrap={false}>
      <input
        type="color"
        aria-label={label}
        value={hexPickerValue(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "40px",
          height: "34px",
          padding: 0,
          border: "1px solid var(--p-color-border)",
          borderRadius: "6px",
          background: "none",
          cursor: disabled ? "not-allowed" : "pointer",
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <TextField
          label={label}
          labelHidden
          value={value}
          onChange={onChange}
          autoComplete="off"
          disabled={disabled}
          placeholder="#A1B2C3"
          helpText={helpText}
          error={error || (invalid ? invalidMessage || "Enter a hex colour, e.g. #A1B2C3." : undefined)}
        />
      </div>
    </InlineStack>
  );
}
