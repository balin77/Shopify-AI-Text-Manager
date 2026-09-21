/**
 * One switch, its label and the ❓ that explains it — the shape every on/off
 * decision in this app wears.
 *
 * This app does not use plain checkboxes (see CLAUDE.md, "Field chrome"):
 * a decision is a pill switch, its words sit beside it, and what it MEANS
 * lives in the question mark rather than in a line of help text under the
 * control. Two surfaces had grown their own copy of that row — the
 * direct-translations settings and the create dialog — which is one copy too
 * many for a shape that is supposed to look identical everywhere.
 *
 * The label is text, not a `<label>` element: the switch inside
 * [ToggleSwitch.tsx](ToggleSwitch.tsx) already IS one, and nesting labels is
 * invalid markup that also breaks click-to-focus. The words are wired to the
 * control through `ariaLabel` instead, which is the only accessible name the
 * switch has.
 *
 * Two placements, and they are not a matter of taste. `inline` leads with the
 * switch, where a checkbox would have been: that is the row style the SETTINGS
 * page uses throughout (see the pill rows in
 * [SettingsSEOTab.tsx](SettingsSEOTab.tsx)) and what a single decision standing
 * among FORM FIELDS wants — pushing the control to the far right of a wide
 * dialog puts it an eye-movement away from the words it answers. `spread` puts
 * the labels left and every switch on the right, so a column of them reads as a
 * column of states; it is the default for historic reasons and is what the
 * direct-translations card uses. A new row on the Settings page takes `inline`.
 */

import { InlineStack, Text } from "@shopify/polaris";
import { HelpPopover } from "./HelpTrigger";
import { HelpTooltip } from "./HelpTooltip";
import { ToggleSwitch } from "./ToggleSwitch";

export interface ToggleRowProps {
  label: string;
  /**
   * The explanation behind the ❓, as raw TEXT — for a caller with no `t.help`
   * entry to name (the create dialog phrases six resource types out of one `t`
   * prop). Absent ⇒ no question mark.
   *
   * Prefer `helpKey` wherever the explanation is longer than a few sentences:
   * a wall of text in a popover is the same problem as a wall of text under
   * the switch, one click further away.
   */
  help?: string;
  /**
   * A `t.help.<key>` entry instead of raw text — the shape that already carries
   * a SHORT summary, optional bullet tips and a "Mehr erfahren" modal for the
   * long version (`HelpTooltip`). This is what a switch whose full explanation
   * runs to a paragraph should name, so the popover stays readable and the
   * detail is one click away rather than in the merchant's face.
   *
   * Wins over `help` when both are given; a key the language bundle does not
   * carry renders nothing, so a key may be named before its text is written.
   */
  helpKey?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Where the help popover opens. `below` inside a scrolling panel, which is
   *  what the settings rows want; `above` is Polaris' own default. */
  helpPosition?: "above" | "below";
  /**
   * `spread` (default) — label left, switch at the right edge: a row in a list
   * of settings. `inline` — switch first, then the words: a single decision
   * standing among form fields.
   */
  layout?: "spread" | "inline";
}

export function ToggleRow({
  label,
  help,
  helpKey,
  checked,
  onChange,
  disabled = false,
  helpPosition = "below",
  layout = "spread",
}: ToggleRowProps) {
  const words = (
    <InlineStack gap="100" blockAlign="center">
      <Text as="p" variant="bodyMd" tone={disabled ? "subdued" : undefined}>
        {label}
      </Text>
      {/* The shared ❓ ([HelpTrigger.tsx](HelpTrigger.tsx)) — it owns the
          scroll lock an overlay needs inside this app's inner scroll
          containers, and the popover width every other help panel uses.
          `helpKey` routes through [HelpTooltip.tsx](HelpTooltip.tsx), which is
          the same icon plus the summary/tips/"Mehr erfahren" shape the field
          help already has; a second copy of that shape is what this avoids. */}
      {helpKey ? (
        <HelpTooltip helpKey={helpKey} position={helpPosition} />
      ) : (
        help && (
          <HelpPopover label={label} preferredPosition={helpPosition}>
            <Text as="p" variant="bodySm">{help}</Text>
          </HelpPopover>
        )
      )}
    </InlineStack>
  );
  const control = (
    <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} ariaLabel={label} />
  );

  if (layout === "inline") {
    return (
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        {control}
        {words}
      </InlineStack>
    );
  }

  return (
    <InlineStack align="space-between" blockAlign="center" gap="200">
      {words}
      {control}
    </InlineStack>
  );
}
