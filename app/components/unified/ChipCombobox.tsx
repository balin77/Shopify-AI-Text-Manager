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
import { useScrollLock } from "../../hooks/useScrollLock";

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
   * Show the options with the input empty AND the field not focused.
   *
   * It decides two things now, because the dropdown opens on focus (see `open`
   * below) and an empty query with the cursor in the box therefore always
   * offers the list: what an UNFOCUSED field shows, and how long the list may
   * be. It marks the case where the option list is small, closed and MEASURED
   * -- the metaobject taxonomy pickers, 19 colours and 51 patterns -- where the
   * whole list is worth offering, which is why it also raises the cap. A
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
  /**
   * Is the dropdown open?
   *
   * Polaris owns the popover and exposes no state, so this MIRRORS what
   * `Combobox` does with it: open on focus, open on every keystroke, close on
   * blur and on Escape. `allowMultiple` below is what stops Polaris closing it
   * after a pick, which is right for a field that collects several values and
   * also keeps the mirror honest.
   *
   * It is not bookkeeping. The list is offered on focus -- that is what makes a
   * click open the dropdown at all -- and the page is frozen while it is up.
   */
  const [open, setOpen] = useState(false);

  /**
   * The one box that may keep scrolling while the page behind the dropdown is
   * frozen: Polaris' popover pane.
   *
   * It is looked up per event rather than held in a real ref, because this
   * component does not render the pane — Polaris portals it out of the tree the
   * moment the popover opens, and there is nothing here to attach a ref to. A
   * `RefObject` whose `current` is a getter is exactly what `useScrollLock`
   * reads (it asks at EVENT time, never at lock time), so the query runs only
   * while a dropdown is actually up, and it can never go stale against a pane
   * that was re-rendered underneath it.
   */
  const paneRef = useMemo(
    () => ({
      get current() {
        return document.querySelector<HTMLElement>(".Polaris-PositionedOverlay .Polaris-Popover__Pane");
      },
    }),
    [],
  );

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
   * With a query it filters; with the field merely FOCUSED it offers the list
   * as it stands. That second half is what makes a click open the dropdown:
   * Polaris' `Combobox` opens its popover on focus but renders nothing when
   * there are no options, so an empty list on focus reads as a control that
   * ignored the click. Already-chosen values drop out either way — offering to
   * add what is already added is a dead click.
   *
   * Closed and unfocused it still offers nothing (unless `suggestAtRest`), so
   * an idle card is one row per field and not a wall of options.
   */
  const suggestions = useMemo(() => {
    const query = input.trim().toLowerCase();
    if (!query && !open && !suggestAtRest) return [];
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
  }, [input, open, options, chosen, suggestAtRest]);

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
   * The dropdown is positioned ONCE against this field and then portalled out,
   * while the editor scrolls inside frames Polaris cannot see — so a scroll
   * under an open list leaves it hanging over nothing. The same freeze the
   * category picker already uses, for the same reason, with the popover's own
   * pane as the one box that may still scroll.
   *
   * Gated on there being options: with none Polaris renders no popover at all,
   * and freezing the page around a dropdown that is not there is the one
   * outcome that reads as the app having hung.
   */
  useScrollLock(open && suggestions.length > 0, paneRef);

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
      fieldLabel={label}
    >
      {/* Label, then the box, then everything else. The chips used to sit
          BETWEEN the label and the input, so this field's box sat however many
          chip rows lower than the plain text field beside it — in a card whose
          whole point is that the boxes line up across the row. A chip is what
          the field already HOLDS; it reads perfectly well under the control
          that adds the next one. */}
      <BlockStack gap="200">
        <FieldLabel label={label} helpKey={helpKey} />

        {readOnly ? (
          selected.length === 0 && emptyText ? (
            <Text as="p" variant="bodySm" tone="subdued">{emptyText}</Text>
          ) : null
        ) : (
          // Enter is how anyone types a list, and Polaris' TextField exposes no
          // key handler — so it is caught on the wrapper, the same way the old
          // tag field did it. It commits only what was TYPED: a half-typed word
          // must not become a value just because focus moved on. Escape is
          // caught for the mirror above: Polaris closes its own popover on it
          // and would otherwise leave this component holding the page scroll.
          <div
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setOpen(false);
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (allowFreeText) add(input);
              else if (suggestions.length === 1) add(suggestions[0].value);
            }}
          >
            <Autocomplete
              options={suggestions}
              selected={[]}
              // Polaris closes the popover after a pick unless this is set, and
              // a field that collects SEVERAL values should stay open for the
              // next one — adding three tags meant clicking back in twice.
              // `selected` stays empty on purpose: what is chosen shows as
              // chips below, not as ticks in the list, and the list already
              // drops what is chosen.
              allowMultiple
              onSelect={(picked) => picked.forEach(add)}
              textField={
                <Autocomplete.TextField
                  label={label}
                  labelHidden
                  value={input}
                  onChange={(value) => {
                    setInput(value);
                    setOpen(true);
                  }}
                  onFocus={() => setOpen(true)}
                  onBlur={() => setOpen(false)}
                  placeholder={placeholder}
                  helpText={helpText}
                  autoComplete="off"
                />
              }
            />
          </div>
        )}

        {selected.length > 0 && (
          <InlineStack gap="100" wrap>{chips}</InlineStack>
        )}
      </BlockStack>
    </FieldClearOverlay>
  );
}
