/**
 * One field, N chosen values, one line.
 *
 * Tags and collection memberships are the same interaction wearing two shapes,
 * and both had grown into walls: the tag field printed every tag as a chip plus
 * a permanently visible row of up to twelve suggestion buttons, and the
 * membership picker printed one checkbox row per collection IN THE SHOP. On a
 * shop with fifty collections the item's actual text was pushed off the screen
 * by a list of boxes that were almost all unticked.
 *
 * So this is Shopify's own pattern: the chosen values sit as small chips INSIDE
 * the control, and options appear only while typing. Idle height is one row
 * plus however many chips are genuinely set.
 *
 * ── The one rule that is not cosmetic ───────────────────────────────────────
 * An option can be LOCKED: shown, listed, but neither removable nor selectable,
 * with a reason. That is what carries the collection picker's rule — a
 * rule-based membership must not be offered for removal, because the rule would
 * put the product back within seconds and the merchant would be looking at a
 * save that apparently did nothing. A chip with no remove button says that
 * better than a disabled checkbox did.
 */

import { useMemo, useState } from "react";
import {
  Autocomplete,
  BlockStack,
  InlineStack,
  Tag,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { FieldClearOverlay, FieldLabel } from "./FieldChrome";

export interface ChipOption {
  value: string;
  label: string;
  /** Set ⇒ the option cannot be added or removed, and this says why. */
  lockedReason?: string;
}

export interface ChipComboboxProps {
  label: string;
  /** Key into `t.help` — the question mark beside the label. */
  helpKey?: string;
  /** Currently chosen values. */
  selected: string[];
  /** Everything selectable. May be empty — free-text entry still works. */
  options: ChipOption[];
  onChange: (next: string[]) => void;
  /** No control at all, only the chips — a foreign locale or an unsynced row. */
  readOnly?: boolean;
  /**
   * Accept values that are not in `options`. True for tags (a merchant invents
   * them), false for memberships (a collection this app does not know is not
   * one it can join).
   */
  allowFreeText?: boolean;
  placeholder?: string;
  /**
   * Show the options with the input still EMPTY.
   *
   * Off by default, which is the whole point of this control for tags and
   * collection memberships: those lists are open-ended and a dropdown of
   * everything is the wall it replaced. It is ON where the option list is
   * small, closed and MEASURED -- the metaobject taxonomy pickers, 19 colours
   * and 51 patterns -- because there the merchant cannot know what to type. A
   * required field rendered as an empty box whose values are only reachable by
   * guessing an English substring is not a picker, and a German or Spanish
   * merchant has no way into it at all.
   */
  suggestAtRest?: boolean;
  helpText?: string;
  /** Rendered when nothing is chosen and nothing can be. */
  emptyText?: string;
}

export function ChipCombobox({
  label,
  helpKey,
  selected,
  options,
  onChange,
  readOnly,
  allowFreeText,
  placeholder,
  suggestAtRest,
  helpText,
  emptyText,
}: ChipComboboxProps) {
  const [input, setInput] = useState("");

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const chosen = useMemo(() => new Set(selected), [selected]);
  /** Case-INSENSITIVE, because Shopify collapses "Sale" and "sale" into one
   *  tag. Without it, typing the other casing cleared the input and added
   *  nothing, with no sign that anything had been refused. */
  const chosenFolded = useMemo(
    () => new Set(selected.map((v) => v.trim().toLowerCase())),
    [selected],
  );

  /**
   * What the dropdown offers.
   *
   * Deliberately NOT the whole list at rest: with the field empty this shows
   * nothing, which is the entire point of the change. Once the merchant types,
   * it filters what is left — already-chosen values drop out, because offering
   * to add what is already added is a dead click.
   */
  const suggestions = useMemo(() => {
    const query = input.trim().toLowerCase();
    if (!query && !suggestAtRest) return [];
    return options
      .filter((o) => !chosen.has(o.value) && (!query || o.label.toLowerCase().includes(query)))
      // A wider cap when the whole list is on show: `suggestAtRest` is only set
      // for closed, MEASURED lists, and cutting one of those at 20 would hide
      // permitted values behind a limit that exists for open-ended tag lists.
      .slice(0, suggestAtRest ? 100 : 20)
      .map((o) => ({
        value: o.value,
        // A locked option stays LISTED and carries its reason. Filtering it out
        // would leave the merchant searching for a collection that is right
        // there; offering it as a plain row made the click do nothing at all,
        // with nothing said. Polaris has no disabled state here, so the reason
        // rides in the label.
        label: o.lockedReason ? `${o.label} — ${o.lockedReason}` : o.label,
      }));
  }, [input, options, chosen, suggestAtRest]);

  const add = (value: string) => {
    const clean = value.trim();
    if (!clean) return;
    const option = byValue.get(clean);
    // A locked option is not selectable either — the lock is about the VALUE,
    // not about which direction it is being changed in.
    if (option?.lockedReason) return;
    if (!option && !allowFreeText) return;
    if (chosenFolded.has(clean.toLowerCase())) return;
    onChange([...selected, clean]);
    setInput("");
  };

  const remove = (value: string) => {
    if (byValue.get(value)?.lockedReason) return;
    onChange(selected.filter((v) => v !== value));
  };

  /**
   * Empty the field — the locked entries EXCEPTED.
   *
   * A locked value is one the merchant may not remove one at a time (a
   * rule-based collection membership), and a button that removed it in bulk
   * would be the same refused write with a different label on it. So "clear"
   * means "remove everything that is mine to remove", and it disappears once
   * nothing is left that qualifies — a button that visibly does nothing reads
   * as a bug.
   */
  const removable = selected.filter((v) => !byValue.get(v)?.lockedReason);
  const clearAll = () => onChange(selected.filter((v) => byValue.get(v)?.lockedReason));

  const chips = selected.map((value) => {
    const option = byValue.get(value);
    const chip = (
      <Tag key={value} onRemove={readOnly || option?.lockedReason ? undefined : () => remove(value)}>
        {option?.label ?? value}
      </Tag>
    );
    // The reason travels with the chip. A chip that simply cannot be removed,
    // with nothing said, reads as a bug.
    return option?.lockedReason ? (
      <Tooltip key={value} content={option.lockedReason}>
        <span>{chip}</span>
      </Tooltip>
    ) : (
      chip
    );
  });

  return (
    <FieldClearOverlay
      onClear={readOnly ? undefined : clearAll}
      hasValue={removable.length > 0}
    >
      <BlockStack gap="200">
        <FieldLabel label={label} helpKey={helpKey} />

        {selected.length > 0 && (
          <InlineStack gap="100" wrap>{chips}</InlineStack>
        )}

        {readOnly ? (
          selected.length === 0 && emptyText ? (
            <Text as="p" variant="bodySm" tone="subdued">{emptyText}</Text>
          ) : null
        ) : (
          // Enter is how anyone types a list, and Polaris' TextField exposes no
          // key handler — so it is caught on the wrapper, the same way the old
          // tag field did it. It commits only what was TYPED: a half-typed word
          // must not become a value just because focus moved on.
          <div
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (allowFreeText) add(input);
              else if (suggestions.length === 1) add(suggestions[0].value);
            }}
          >
            <Autocomplete
              options={suggestions}
              selected={[]}
              onSelect={(picked) => picked.forEach(add)}
              textField={
                <Autocomplete.TextField
                  label={label}
                  labelHidden
                  value={input}
                  onChange={setInput}
                  placeholder={placeholder}
                  helpText={helpText}
                  autoComplete="off"
                />
              }
            />
          </div>
        )}
      </BlockStack>
    </FieldClearOverlay>
  );
}
