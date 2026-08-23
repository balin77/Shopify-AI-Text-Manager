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

export interface FieldClearButtonProps {
  onClear: () => void;
  /** The field this button empties, for its accessible NAME. See above. */
  fieldLabel?: string;
}

/**
 * The control that empties a field: the WORD where the field is wide enough for
 * it, a red BIN where it is not.
 *
 * The word came first and is still the better label. The bin was introduced
 * because "Leeren" / "Clear" / "Vaciar" is up to seven characters sitting on
 * the label's own line, and on a short field — a vendor, a theme template, one
 * cell of the Details grid — it collided with the label it shares that line
 * with. That was a fix for SHORT fields that then applied to every field in the
 * app, including a product title with 700px of empty label row beside it.
 *
 * So the shape is a LAYOUT question, and it is answered by the layout: a
 * container query on the field's own width (`.app-field-clear-scope` in
 * responsive.css), not by a prop each caller has to remember and not by the
 * viewport — the Details card's fields are narrow on the widest desktop there
 * is, which is precisely the case a media query cannot see.
 *
 * BOTH shapes are rendered and CSS shows one. That looks like waste and is not:
 * Polaris derives its padding from the PROPS (`icon && children == null` ⇒
 * `iconOnly`), and only the icon-only plain button gets the 32px minimum touch
 * target. One button morphing between the two shapes would silently lose it on
 * exactly the narrow fields the bin exists for. `display: none` also takes the
 * hidden one out of the accessibility tree, so a screen reader is offered one
 * control, not two.
 */
export function FieldClearButton({ onClear, fieldLabel }: FieldClearButtonProps) {
  const { t } = useI18n();
  const clearWord = t.common?.clear || "Clear";
  // Never undefined on the icon variant: with no text inside the button, an
  // absent accessible name leaves a control a screen reader can only call
  // "button". Carried on the word variant too, because four "Leeren" buttons
  // in one Details row tell a screen reader nothing apart — and it OPENS with
  // the visible word, which is what WCAG's "Label in Name" asks for.
  const name = fieldLabel ? `${clearWord}: ${fieldLabel}` : clearWord;
  // `plain` is what makes it borderless — a bin (or a word) in a bordered box
  // reads as a second control beside the field rather than as an affordance
  // of it.
  const shared = { size: "slim", onClick: onClear, tone: "critical", variant: "plain" } as const;
  return (
    <span className="app-field-clear">
      <span className="app-field-clear--icon">
        <Button {...shared} icon={DeleteIcon} accessibilityLabel={name} />
      </span>
      <span className="app-field-clear--word">
        <Button {...shared} accessibilityLabel={name}>
          {clearWord}
        </Button>
      </span>
    </span>
  );
}

/**
 * Puts the clear control in the top-right corner of the field it wraps — the
 * label row's own line, which is empty on every field this app draws.
 *
 * Absolutely positioned rather than laid out beside the label: the label is
 * inside a Polaris control for most fields, and a button in there would be part
 * of the `<label>` element, i.e. a click target that also focuses the input.
 *
 * The wrapper is also the QUERY CONTAINER the word/bin decision reads
 * (`app-field-clear-scope`): it is the field's own box, so the control knows
 * how much room the label row has without anyone passing it down.
 */
export function FieldClearOverlay({ onClear, hasValue, fieldLabel, children }: FieldClearOverlayProps) {
  return (
    <div className="app-field-clear-scope" style={{ position: "relative" }}>
      {onClear && (
        <div className="field-clear-overlay" style={{ position: "absolute", top: 0, right: 0, zIndex: 10 }}>
          {hasValue && <FieldClearButton onClear={onClear} fieldLabel={fieldLabel} />}
        </div>
      )}
      {children}
    </div>
  );
}
