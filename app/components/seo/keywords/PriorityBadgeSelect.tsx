/**
 * PriorityBadgeSelect — the priority cell of the keyword table.
 *
 * The table used to show two different things for the same value: a plain
 * Polaris `<Select>` inside a real group and a tone-coloured `<Badge>` in the
 * "Alle" / "Ohne Gruppe" views. The badge read better (1/2/3 is a severity,
 * and colour says that faster than a dropdown does) but was not editable,
 * while the dropdown was editable but looked like a form field in a table of
 * data. This is both: a native `<select>` styled as the badge.
 *
 * A native select on purpose — keyboard handling, mobile pickers and screen
 * readers come for free, where a Popover + ActionList per row would mean
 * per-row open state and a hand-rolled listbox. The pill styling lives in
 * KeywordsPage.css so the tone tokens stay next to the rest of the section's
 * colours.
 *
 * Priority is a property of the KEYWORD, not of its group membership, so this
 * is editable from the pseudo views too — a keyword's importance does not
 * depend on which list you happen to be looking at it from.
 */

import type { Translation } from "../../../i18n/de";

type KeywordsPageStrings = Translation["seo"]["keywordsPage"];

export interface PriorityBadgeSelectProps {
  k: KeywordsPageStrings;
  /** Current priority: 1 (high) / 2 (medium) / 3 (low). */
  value: number;
  options: { label: string; value: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
  /** Names the row for screen readers, since the label is visually hidden. */
  keyword: string;
}

export function PriorityBadgeSelect({
  k,
  value,
  options,
  disabled = false,
  onChange,
  keyword,
}: PriorityBadgeSelectProps) {
  // Anything outside 1–3 falls back to the neutral tone rather than rendering
  // an unstyled pill.
  const tone = value === 1 || value === 2 || value === 3 ? value : 3;

  return (
    <span className={`priority-badge priority-badge--${tone}`}>
      <select
        className="priority-badge__select"
        value={String(value)}
        disabled={disabled}
        aria-label={k.priorityForKeyword.replace("{keyword}", keyword)}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className="priority-badge__caret">
        ▾
      </span>
    </span>
  );
}
