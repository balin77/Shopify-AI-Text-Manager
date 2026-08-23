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
 * Two placements, and they are not a matter of taste. A row in a SETTINGS LIST
 * spreads: the labels line up on the left and every switch on the right, so a
 * column of them can be read as a column of states. A single decision inside a
 * FORM leads with its switch, where a checkbox would have been — it sits among
 * fields, not among other switches, and pushing it to the far right of a wide
 * dialog puts the control an eye-movement away from the words it answers.
 */

import { InlineStack, Text } from "@shopify/polaris";
import { HelpPopover } from "./HelpTrigger";
import { ToggleSwitch } from "./ToggleSwitch";

export interface ToggleRowProps {
  label: string;
  /** The explanation behind the ❓. Absent ⇒ no question mark. */
  help?: string;
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
      {help && (
        /* The shared ❓ ([HelpTrigger.tsx](HelpTrigger.tsx)) — it owns the
           scroll lock an overlay needs inside this app's inner scroll
           containers, and the popover width every other help panel uses. */
        <HelpPopover label={label} preferredPosition={helpPosition}>
          <Text as="p" variant="bodySm">{help}</Text>
        </HelpPopover>
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
