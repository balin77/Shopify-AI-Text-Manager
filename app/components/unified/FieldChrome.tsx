/**
 * The chrome every editable field wears: its LABEL and its CLEAR button.
 *
 * Both used to be written per component, and both had drifted. `AIEditableField`
 * hand-wrote `fontWeight: 600` around the label it hands Polaris and drew a
 * "Leeren" button as an absolute overlay in the label row; `AttributeField`,
 * `ChipCombobox`, `CollectionsField` and `TaxonomyField` printed a plain
 * regular-weight label, and only the taxonomy picker had any way to empty
 * itself — inline, in a different place. So in one card the merchant saw two
 * label weights and one clear button out of four.
 *
 * The numbers live in responsive.css with every other piece of app-wide
 * formatting (`--app-field-label-weight`, spent through the `.app-field-label`
 * class); this module owns the SHAPE:
 *
 *   - a label is bold, and carries its question mark right after the words,
 *   - a field that can be emptied says so in the top-right corner of its own
 *     label row, in the same place, in every card.
 *
 * `HelpTooltip` renders nothing when the key has no entry in the language
 * bundle, so a field may always name one — the bubble appears once the text is
 * written, and never as an empty circle in the meantime.
 */

import type { ReactNode } from "react";
import { Button, InlineStack, Text } from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { HelpTooltip } from "../HelpTooltip";
import { HelpPopover } from "../HelpTrigger";
import { useI18n } from "../../contexts/I18nContext";

export interface FieldLabelProps {
  label: string;
  /** Key into `t.help`. Absent, or unknown, ⇒ no question mark. */
  helpKey?: string;
  /**
   * The explanation as TEXT, for a surface whose strings do not live in
   * `t.help`.
   *
   * The create modal is the one: it takes its whole vocabulary as a `t` prop
   * (it is rendered for six resource types and phrases their fields from one
   * block), so it has no key to name. It still has to wear the same label —
   * bold, red asterisk, question mark right after the words — which is why
   * this is a second INPUT to the one shape rather than a second shape.
   * `helpKey` wins if both are given.
   */
  help?: string;
  /** The red asterisk Polaris draws for a required field. */
  requiredIndicator?: boolean;
}

/**
 * The label of one field.
 *
 * Rendered as a `span`, never a `label` element: it goes INSIDE what Polaris
 * already wraps in one (the `label` prop of TextField / Select), and a nested
 * label is invalid markup that also breaks the click-to-focus behaviour.
 */
export function FieldLabel({ label, helpKey, help, requiredIndicator }: FieldLabelProps) {
  return (
    // The wrapper is what `.field-clear-overlay ~ * .app-field-label-row`
    // reaches for on mobile: a self-drawn label row has no Polaris
    // LabelWrapper, so without a class of its own the inflated touch-target
    // button would land on the control below it.
    <div className="app-field-label-row">
      <InlineStack gap="100" blockAlign="center" wrap={false}>
        <Text as="span" variant="bodyMd">
          <span className="app-field-label">
            {label}
            {requiredIndicator && <span style={{ color: "var(--p-color-text-critical)" }}> *</span>}
          </span>
        </Text>
        {(helpKey || help) && (
          /**
           * `preventDefault` because this row is handed to Polaris as a
           * control's `label` prop, so Polaris wraps it in `<label htmlFor>`
           * — and a click anywhere in a label ACTIVATES the control it names.
           * On a `Select` that meant the "?" opened the help popover and the
           * native option list on top of it. Cancelling the click's default
           * action leaves the trigger's own handler (which already ran, on the
           * target) untouched and only drops the label's activation.
           */
          <span onClick={(event) => event.preventDefault()}>
            {helpKey ? (
              <HelpTooltip helpKey={helpKey} />
            ) : (
              <HelpPopover label={label}>
                <Text as="p" variant="bodySm">{help}</Text>
              </HelpPopover>
            )}
          </span>
        )}
      </InlineStack>
    </div>
  );
}

export interface FieldClearOverlayProps {
  /** Absent ⇒ this field cannot be emptied (an enum has no empty value). */
  onClear?: () => void;
  /**
   * Is there anything to clear? The button is drawn only when there is — but
   * the WRAPPER is always rendered, because responsive.css reserves the label
   * row for it on mobile and a row that appeared on the first keystroke would
   * shove the input down as the merchant typed.
   */
  hasValue: boolean;
  /**
   * The field this button empties, for its accessible NAME.
   *
   * The button shows a bin and no words, so the accessible name is the ONLY
   * name it has — and four of these sit in one Details row (vendor, product
   * type, collections, tags), where four buttons called "Leeren" tell a screen
   * reader nothing apart. Sighted users have the field the icon sits in, which
   * is exactly what the accessible name was missing.
   */
  fieldLabel?: string;
  children: ReactNode;
}

/**
 * Puts the clear button in the top-right corner of the field it wraps — the
 * label row's own line, which is empty on every field this app draws.
 *
 * Absolutely positioned rather than laid out beside the label: the label is
 * inside a Polaris control for most fields, and a button in there would be part
 * of the `<label>` element, i.e. a click target that also focuses the input.
 *
 * A red BIN and no word. "Leeren" / "Clear" / "Vaciar" is up to seven
 * characters of button sitting on the label's line, and since every field in
 * the Details card became its own card there are up to six of them on one
 * screen — each eating the width its own label wanted. The bin is the symbol
 * this app already uses for deleting, and the word moves into the accessible
 * name, where it is worth more anyway (see `fieldLabel`).
 */
export function FieldClearOverlay({ onClear, hasValue, fieldLabel, children }: FieldClearOverlayProps) {
  const { t } = useI18n();
  const clearWord = t.common?.clear || "Clear";
  return (
    <div style={{ position: "relative" }}>
      {onClear && (
        <div className="field-clear-overlay" style={{ position: "absolute", top: 0, right: 0, zIndex: 10 }}>
          {hasValue && (
            <Button
              size="slim"
              onClick={onClear}
              tone="critical"
              // `plain` is what makes it borderless — a bin in a bordered box
              // reads as a second control beside the field rather than as an
              // affordance of it.
              variant="plain"
              icon={DeleteIcon}
              // Never undefined: with no text inside the button, an absent
              // accessible name leaves a control a screen reader can only call
              // "button".
              accessibilityLabel={fieldLabel ? `${clearWord}: ${fieldLabel}` : clearWord}
            />
          )}
        </div>
      )}
      {children}
    </div>
  );
}
