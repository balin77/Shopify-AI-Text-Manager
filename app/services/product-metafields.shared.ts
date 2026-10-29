/**
 * Product metafields in the editor's "Options & metafields" card — the pure,
 * client-safe half (the card, the hook and the save action all import it).
 *
 * Two things live here.
 *
 * 1. CLEARED SLOTS. Emptying a metafield deletes it on Shopify
 *    (`metafieldsSet` refuses a blank value, so a clear is `metafieldsDelete`).
 *    The card lists metafields from the `ProductMetafield` cache, so deleting
 *    the cache row with it made the field vanish from the card until the next
 *    sync — the merchant could not type a new value. The row is therefore KEPT
 *    with `value: ""`: it still carries what re-creating the metafield needs
 *    (product, namespace, key, type). Shopify never stores a blank metafield
 *    value, so `""` cannot be a real value and is an unambiguous marker; every
 *    reader that wants real metafields filters it out (`value: { not: "" }`),
 *    and the sync keeps such a row only while Shopify has no metafield under
 *    that namespace/key (`upsertProductMetafields`). Its id is the DELETED
 *    metafield's GID — nothing may address Shopify with it; a save re-creates
 *    the metafield by (owner, namespace, key, type) and the row takes the GID
 *    Shopify echoes.
 *
 * 2. THE LIST EDITOR. A `list.*` metafield is stored as a JSON array; the card
 *    shows it ONE ENTRY PER LINE and builds the JSON on save. The stored form is
 *    read through the bulk editor's `listMetafieldEntries` / entry rule, so the
 *    grid's `A | B | C` cell and this editor cannot come to read a value
 *    differently. Each entry is checked against the list's ELEMENT type before
 *    anything is sent, on the client (so the error sits on the field) and again
 *    on the server (the action is directly POST-reachable).
 */

import {
  formatListMetafieldValue,
  listMetafieldEntries,
  parseListMetafieldEntries,
} from "./bulk-editor/columns.shared";

// ─── Cleared slots ──────────────────────────────────────────────────────────

/** The value a kept row holds once its metafield was deleted on Shopify. */
export const CLEARED_METAFIELD_VALUE = "";

export function isClearedMetafieldSlot(row: { value: string | null | undefined }): boolean {
  return (row.value ?? "") === CLEARED_METAFIELD_VALUE;
}

const slotKey = (row: { namespace: string; key: string }) => `${row.namespace}\u0000${row.key}`;

/**
 * Splits a product's cached metafield rows into the real metafields and the
 * cleared slots. A slot whose namespace/key also has a REAL row (a value was
 * set again elsewhere and the slot is not cleaned up yet) is dropped — the
 * card must never show one field twice — and so is a second slot of the same
 * namespace/key.
 */
export function splitClearedMetafieldSlots<T extends { namespace: string; key: string; value: string }>(
  rows: T[],
): { metafields: T[]; clearedMetafields: T[] } {
  const metafields = rows.filter((row) => !isClearedMetafieldSlot(row));
  const taken = new Set(metafields.map(slotKey));
  const clearedMetafields: T[] = [];
  for (const row of rows) {
    if (!isClearedMetafieldSlot(row)) continue;
    const key = slotKey(row);
    if (taken.has(key)) continue;
    taken.add(key);
    clearedMetafields.push(row);
  }
  return { metafields, clearedMetafields };
}

// ─── List metafields ────────────────────────────────────────────────────────

export const LIST_METAFIELD_PREFIX = "list.";

export function isListMetafieldType(type: string): boolean {
  return type.startsWith(LIST_METAFIELD_PREFIX);
}

/** `list.number_integer` → `number_integer`. */
export function listElementType(type: string): string {
  return isListMetafieldType(type) ? type.slice(LIST_METAFIELD_PREFIX.length) : type;
}

/**
 * The element types this editor can check AND serialise. Anything else is
 * refused rather than guessed: a reference list holds GIDs this card has no
 * picker for, and a measurement list holds JSON objects.
 *
 * Only `single_line_text_field` reaches the card today (the editor lists the
 * translatable text types only); the server re-checks every list type a POST
 * could name, so the rest are covered there.
 */
export const SUPPORTED_LIST_ELEMENT_TYPES = [
  "single_line_text_field",
  "url",
  "number_integer",
  "number_decimal",
  "date",
  "date_time",
  "color",
] as const;

export type ListEntryErrorCode =
  | "blank"
  | "emptyEntry"
  | "invalidInteger"
  | "invalidDecimal"
  | "invalidDate"
  | "invalidDateTime"
  | "invalidUrl"
  | "invalidColor"
  | "unsupportedType";

export interface ListEntryError {
  code: ListEntryErrorCode;
  /** 1-based line of the editor text; 0 when the error concerns the whole field. */
  line: number;
  entry: string;
}

const INVALID_CODE_BY_TYPE: Record<string, ListEntryErrorCode> = {
  number_integer: "invalidInteger",
  number_decimal: "invalidDecimal",
  date: "invalidDate",
  date_time: "invalidDateTime",
  url: "invalidUrl",
  color: "invalidColor",
};

const INTEGER_PATTERN = /^[+-]?\d+$/;
const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const URL_SCHEMES = new Set(["https:", "http:", "mailto:", "sms:", "tel:"]);

function isCalendarDate(entry: string): boolean {
  const match = DATE_PATTERN.exec(entry);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * One entry, normalised for its element type — or the reason it cannot be
 * stored. Decimals accept a decimal COMMA (German and Spanish merchants type
 * `4,5`), written back with a dot.
 */
export function normalizeListEntry(
  elementType: string,
  entry: string,
): { ok: true; value: string } | { ok: false; code: ListEntryErrorCode } {
  switch (elementType) {
    case "single_line_text_field":
      return { ok: true, value: entry };
    case "number_integer":
      return INTEGER_PATTERN.test(entry) && Number.isSafeInteger(Number(entry))
        ? { ok: true, value: String(Number(entry)) }
        : { ok: false, code: "invalidInteger" };
    case "number_decimal": {
      const dotted = /^[+-]?\d+,\d+$/.test(entry) ? entry.replace(",", ".") : entry;
      return DECIMAL_PATTERN.test(dotted) ? { ok: true, value: dotted } : { ok: false, code: "invalidDecimal" };
    }
    case "date":
      return isCalendarDate(entry) ? { ok: true, value: entry } : { ok: false, code: "invalidDate" };
    case "date_time":
      return DATE_TIME_PATTERN.test(entry) && Number.isFinite(Date.parse(entry))
        ? { ok: true, value: entry }
        : { ok: false, code: "invalidDateTime" };
    case "url": {
      try {
        const url = new URL(entry);
        return URL_SCHEMES.has(url.protocol) ? { ok: true, value: entry } : { ok: false, code: "invalidUrl" };
      } catch {
        return { ok: false, code: "invalidUrl" };
      }
    }
    case "color":
      return COLOR_PATTERN.test(entry) ? { ok: true, value: entry } : { ok: false, code: "invalidColor" };
    default:
      return { ok: false, code: "unsupportedType" };
  }
}

/**
 * Normalised entries → the JSON Shopify stores. Integers go as JSON numbers,
 * everything else as strings. NOT measured for the number and date element
 * types (none reaches the card today) — a shape Shopify refuses comes back as
 * a userError and the field is reported failed, never mirrored.
 */
function serializeListEntries(elementType: string, entries: string[]): string {
  return JSON.stringify(elementType === "number_integer" ? entries.map((e) => Number(e)) : entries);
}

/** The stored JSON as the editor shows it: one entry per line. */
export function formatListMetafieldLines(raw: string): string {
  return formatListMetafieldValue(raw, "\n");
}

/**
 * Whether the stored value can be shown one entry per line and written back
 * UNCHANGED. A value that is not a JSON array, or an entry that itself holds a
 * line break, would come back altered by the round trip — such a field is
 * shown read-only rather than silently rewritten on the next save.
 */
export function listValueSurvivesLines(raw: string): boolean {
  const entries = listMetafieldEntries(raw);
  return entries !== null && !entries.some((e) => /[\r\n]/.test(e));
}

export type ListLinesParse =
  | { ok: true; /** The JSON to store; `""` = clear (delete the metafield). */ value: string }
  | { ok: false; errors: ListEntryError[] };

/**
 * The editor's text (one entry per line) → the JSON to store.
 *
 * Blank lines are layout and are dropped; an entirely empty text is a CLEAR
 * (`""`); a text of spaces and line breaks only is refused (`blank`) — the
 * same rule as a single-line metafield, where only an explicitly emptied field
 * deletes. Every remaining entry must pass its element type; every failing
 * line is reported, not just the first.
 */
export function parseListMetafieldLines(type: string, text: string): ListLinesParse {
  if (text === "") return { ok: true, value: "" };
  if (text.trim() === "") return { ok: false, errors: [{ code: "blank", line: 0, entry: "" }] };
  const elementType = listElementType(type);
  if (!(SUPPORTED_LIST_ELEMENT_TYPES as readonly string[]).includes(elementType)) {
    return { ok: false, errors: [{ code: "unsupportedType", line: 0, entry: "" }] };
  }

  const lines = text.split(/\r?\n/);
  const kept: Array<{ line: number; entry: string }> = [];
  lines.forEach((raw, index) => {
    if (raw.trim() !== "") kept.push({ line: index + 1, entry: raw });
  });
  // The grid's entry rule (trimmed, none empty) — after dropping blank lines it
  // can only fail on a construct the split did not foresee, but it is the ONE
  // rule both editors apply, so it is applied here too.
  const entryRule = parseListMetafieldEntries(kept.map((k) => k.entry));
  if (!entryRule.ok) return { ok: false, errors: [{ code: "emptyEntry", line: 0, entry: "" }] };

  const errors: ListEntryError[] = [];
  const normalized: string[] = [];
  entryRule.values.forEach((entry, i) => {
    const result = normalizeListEntry(elementType, entry);
    if (result.ok) normalized.push(result.value);
    else errors.push({ code: result.code, line: kept[i].line, entry });
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: serializeListEntries(elementType, normalized) };
}

/**
 * Server-side check of a STORED list value (the JSON the client built): a JSON
 * array whose every entry passes its element type. `null` = fine.
 */
export function storedListMetafieldValueProblem(type: string, value: string): ListEntryErrorCode | null {
  const elementType = listElementType(type);
  if (!(SUPPORTED_LIST_ELEMENT_TYPES as readonly string[]).includes(elementType)) return "unsupportedType";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "emptyEntry";
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return "emptyEntry";
  for (const element of parsed) {
    if (typeof element !== "string" && typeof element !== "number") return "emptyEntry";
    const entry = String(element);
    if (entry.trim() === "" || entry !== entry.trim()) return "emptyEntry";
    if (/[\r\n]/.test(entry)) return "emptyEntry";
    const result = normalizeListEntry(elementType, entry);
    if (!result.ok) return result.code;
    // The client sends NORMALISED entries; a value that would still change
    // under normalisation (a decimal comma, "+5") was not built by this editor.
    if (result.value !== entry) return INVALID_CODE_BY_TYPE[elementType] ?? "emptyEntry";
  }
  return null;
}

// ─── The card's display form ────────────────────────────────────────────────

interface MetafieldLike {
  type: string;
  value: string;
}

/**
 * Whether the card may offer an editor for this metafield's value. A list is
 * editable only where the one-entry-per-line form can carry its value back
 * unchanged and its element type is one this editor checks; otherwise the
 * stored value is shown read-only rather than rewritten on the next save.
 */
export function isMetafieldValueEditable(mf: MetafieldLike): boolean {
  if (!isListMetafieldType(mf.type)) return true;
  if (!(SUPPORTED_LIST_ELEMENT_TYPES as readonly string[]).includes(listElementType(mf.type))) return false;
  return listValueSurvivesLines(mf.value);
}

/** The value as the card shows (and edits) it: a list one entry per line. */
export function metafieldDisplayValue(mf: MetafieldLike): string {
  return isListMetafieldType(mf.type) && listValueSurvivesLines(mf.value)
    ? formatListMetafieldLines(mf.value)
    : mf.value;
}

/**
 * The entry errors of a list field's CURRENT text, for the field itself; `[]`
 * for a non-list field or a valid list. The card shows them as the merchant
 * types, the save refuses on them.
 */
export function metafieldInputErrors(type: string, display: string): ListEntryError[] {
  if (!isListMetafieldType(type)) return [];
  const parsed = parseListMetafieldLines(type, display);
  return parsed.ok ? [] : parsed.errors;
}

export type PrimaryMetafieldChange =
  | { kind: "unchanged" }
  /** What to send; `""` = clear (the server deletes the metafield, keeps the field). */
  | { kind: "value"; value: string }
  | { kind: "refused"; reason: "blank" | "listInvalid"; errors: ListEntryError[] };

/**
 * One primary edit of the card (held in DISPLAY form) → what the save sends.
 *
 * Only an EXPLICITLY emptied field clears; spaces only are refused, because a
 * clear deletes the metafield and its translations on Shopify. A list is
 * compared by its stored JSON, so retyping the same entries is no change.
 */
export function primaryMetafieldChange(original: MetafieldLike, display: string): PrimaryMetafieldChange {
  if (!isListMetafieldType(original.type)) {
    if (display === original.value) return { kind: "unchanged" };
    if (display === "") return { kind: "value", value: "" };
    if (display.trim() === "") return { kind: "refused", reason: "blank", errors: [] };
    return { kind: "value", value: display };
  }
  if (display === metafieldDisplayValue(original)) return { kind: "unchanged" };
  const parsed = parseListMetafieldLines(original.type, display);
  if (!parsed.ok) {
    const blank = parsed.errors.some((e) => e.code === "blank");
    return { kind: "refused", reason: blank ? "blank" : "listInvalid", errors: parsed.errors };
  }
  if (parsed.value === original.value) return { kind: "unchanged" };
  return { kind: "value", value: parsed.value };
}
