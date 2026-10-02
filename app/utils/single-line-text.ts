/**
 * Single-line values in an auto-growing box.
 *
 * A title, an SEO title, a handle or an alt text is ONE line of text, but a
 * long one ran off the right edge of a one-line `<input>` and had to be
 * scrolled inside the box. Those fields are now rendered as a `<textarea>`
 * that WRAPS and grows with its content (`SingleLineTextField`,
 * `AutoGrowTextarea`) — and a textarea accepts line breaks, which none of
 * these values may ever carry (a "\n" in a handle or an SEO title is a broken
 * URL / a broken `<title>`). These helpers are the guard: typing or pasting
 * never ADDS a line break (a value already stored with one is left as it is —
 * see `normalizeSingleLineChange`):
 *
 * - `toSingleLine` collapses every line break in a CHANGED value (a paste, an
 *   IME commit, a drag-and-drop) into ONE space. An `<input>` would have
 *   stripped them; a space is the safer reading of "two lines pasted into one
 *   field" (two words would otherwise be glued together).
 * - `isLineBreakKey` answers "would this keydown insert a line break?", so the
 *   box can cancel it. Enter during an IME composition COMMITS the
 *   composition, so it is never treated as a line break.
 *
 * Import-free on purpose: it is used on both sides of the bundle.
 */

/** Matches one line break of any platform spelling (CRLF counts as ONE). */
const LINE_BREAK = /\r\n|\r|\n|\u2028|\u2029/g;

/** Collapses every line break into one space. Values without one come back unchanged. */
export function toSingleLine(value: string): string {
  if (!value) return value;
  return value.replace(LINE_BREAK, " ");
}

/** True when the value already holds a line break. */
export function hasLineBreak(value: string | null | undefined): boolean {
  return !!value && /[\r\n\u2028\u2029]/.test(value);
}

/**
 * The value an auto-growing single-line box hands on after a change.
 *
 * Collapses line breaks — UNLESS the value the box was showing already held
 * one. Such a value is stored multi-line (a theme string that carries a
 * break, say); the old `<input>` silently stripped its breaks on the first
 * keystroke, and the textarea can now show it faithfully, so an edit
 * elsewhere in it must not flatten it. Enter stays blocked either way, so no
 * NEW break can be typed.
 */
export function normalizeSingleLineChange(next: string, previous: string | null | undefined): string {
  return hasLineBreak(previous) ? next : toSingleLine(next);
}

/** The fields of a keyboard event this check reads (React's synthetic event and the DOM one both carry them). */
export interface LineBreakKeyEventLike {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

/**
 * True when the keydown would insert a line break into a textarea: Enter
 * (plain, Shift, Ctrl/Alt — all of them insert or do nothing useful in a
 * single-line value) outside an IME composition.
 */
export function isLineBreakKey(event: LineBreakKeyEventLike): boolean {
  if (event.key !== "Enter") return false;
  // keyCode 229 is the "IME is processing this key" marker some browsers send
  // instead of / as well as isComposing.
  if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return false;
  return true;
}
