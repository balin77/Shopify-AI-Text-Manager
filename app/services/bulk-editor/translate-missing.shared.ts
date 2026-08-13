/**
 * Bulk editor — "translate missing" selection model + limits.
 *
 * CLIENT-SAFE (no server imports): the page component, the loader and the
 * /api/ai handler all agree on the same selection semantics, so the server can
 * REBUILD the merchant's selection from a handful of URL/form params instead of
 * trusting a list of cells (same rule as the grid's diff: the column universe
 * and the candidate set are always re-derived server-side).
 *
 * The selection is deliberately NOT a list of ids. "Select all" must span every
 * page of the candidate list (a merchant with 4.000 products cannot tick 4.000
 * boxes), so it is stored as a DEFAULT plus the exceptions the merchant flipped:
 *
 *   mode "all"  → every (row, column) pair of the current filter set is on,
 *                 except the columns in `defaultOffColumnIds` (URL handles —
 *                 opt-in, they change the storefront URL of that language) and
 *                 except the pairs in `exceptions`.
 *   mode "none" → nothing is on except the pairs in `exceptions`.
 *
 * A "unit" is ONE (row × column × locale) translation — the thing that costs an
 * AI call and the thing MAX_TRANSLATE_UNITS caps. Rows and cells are useless as
 * a budget here: one row with 6 missing fields in 3 languages is 18 units.
 */

// ─── Limits ────────────────────────────────────────────────────────────────

/** Items per page of the candidate list. Each item expands into its missing
 * fields, so the page is much taller than its item count suggests. */
export const TRANSLATE_MISSING_PAGE_SIZE = 25;

/** Hard cap on ONE translate run, counted in UNITS (row × column × locale).
 * Everything above is reported to the merchant and left for the next run —
 * never silently dropped. */
export const MAX_TRANSLATE_UNITS = 2000;

/**
 * How many rows of the current filter set are scanned for candidates — the
 * same window MAX_BULK_TASK_ITEMS uses for the other task path. Beyond it the
 * list (and every run) covers the first N rows only and says so.
 *
 * Deliberately far below MAX_TRANSLATE_UNITS/row-count: every scan loads these
 * rows in full (a product row carries its description), and a row typically
 * contributes ~10 units, so 500 rows already overflow one run's unit budget.
 * Translated rows drop OUT of the candidate list, so the window walks forward
 * on its own with every completed run.
 */
export const MAX_TRANSLATE_SCAN_ROWS = 500;

/** Columns that are NOT preselected: a translated URL handle changes that
 * language's storefront URL, and many shops deliberately keep one handle across
 * all languages. Ticking it is an explicit act. */
export const TRANSLATE_DEFAULT_OFF_COLUMN_IDS = ["field.handle"];

/** Maximum length of a translated handle (Shopify's own limit is generous;
 * the AI prompt already asks for a short slug). */
const MAX_HANDLE_LENGTH = 200;

// ─── Candidate shape ───────────────────────────────────────────────────────

/** One missing FIELD of an item, with every published foreign locale that
 * lacks a translation for it. The list is deliberately NOT narrowed to the
 * currently active languages — the client filters for display, so toggling a
 * language never invalidates the exception bookkeeping. */
export interface MissingColumnEntry {
  columnId: string;
  locales: string[];
  /** The primary-locale text the AI translates. Filled ONLY for the task
   * (`withSources`) — the page's loader must never ship whole product
   * descriptions to the browser just to draw a checkbox. */
  source?: string;
}

/** One item (product, collection, …) with at least one missing translation. */
export interface MissingItem {
  rowId: string;
  title: string;
  /** Secondary line — handle, blog name, metaobject type … "" when unused. */
  subtitle: string;
  imageUrl?: string;
  columns: MissingColumnEntry[];
  /** Primary-locale handle — the duplicate-slug guard compares against it.
   * Same `withSources` rule as `MissingColumnEntry.source`. */
  primaryHandle?: string;
}

// ─── Selection ─────────────────────────────────────────────────────────────

export type TranslateSelectionMode = "all" | "none";

export interface TranslateSelection {
  mode: TranslateSelectionMode;
  /** Columns off by default in "all" mode. Emptied by an explicit "select
   * all", so the merchant can still get handles in one click. */
  defaultOffColumnIds: string[];
  /** Pair keys whose state is FLIPPED against the default above. */
  exceptions: Set<string>;
}

/** `${rowId}|${columnId}` — neither part can contain "|" (GIDs don't, and
 * column ids use "." as their separator; same reasoning as makeEditKey). */
export function translatePairKey(rowId: string, columnId: string): string {
  return `${rowId}|${columnId}`;
}

export function parseTranslatePairKey(key: string): { rowId: string; columnId: string } | null {
  const index = key.indexOf("|");
  if (index <= 0 || index === key.length - 1) return null;
  return { rowId: key.slice(0, index), columnId: key.slice(index + 1) };
}

export function initialTranslateSelection(): TranslateSelection {
  return { mode: "all", defaultOffColumnIds: [...TRANSLATE_DEFAULT_OFF_COLUMN_IDS], exceptions: new Set() };
}

/** State a pair has BEFORE its exceptions are applied. */
function baseSelected(selection: TranslateSelection, columnId: string): boolean {
  return selection.mode === "all" && !selection.defaultOffColumnIds.includes(columnId);
}

export function isPairSelected(selection: TranslateSelection, rowId: string, columnId: string): boolean {
  const base = baseSelected(selection, columnId);
  return selection.exceptions.has(translatePairKey(rowId, columnId)) ? !base : base;
}

/** Flips ONE pair. Exceptions that fall back onto the default are removed
 * again, so the set stays as small as the merchant's actual deviation. */
export function setPairSelected(
  selection: TranslateSelection,
  rowId: string,
  columnId: string,
  selected: boolean,
): TranslateSelection {
  const key = translatePairKey(rowId, columnId);
  const exceptions = new Set(selection.exceptions);
  if (selected === baseSelected(selection, columnId)) exceptions.delete(key);
  else exceptions.add(key);
  return { ...selection, exceptions };
}

/** Selecting/deselecting an ITEM applies to every missing field of it — the
 * parent checkbox owns its children (that is the whole point of the tree). */
export function setItemSelected(
  selection: TranslateSelection,
  item: MissingItem,
  selected: boolean,
): TranslateSelection {
  let next = selection;
  for (const column of item.columns) next = setPairSelected(next, item.rowId, column.columnId, selected);
  return next;
}

export type TriState = "checked" | "indeterminate" | "unchecked";

/** Item checkbox state, derived from its fields — never stored separately (a
 * stored parent state drifts from its children the moment one is flipped).
 * Only fields with a missing translation in an ACTIVE language count. */
export function itemSelectionState(
  selection: TranslateSelection,
  item: MissingItem,
  activeLocales: string[],
): TriState {
  let on = 0;
  let total = 0;
  for (const column of item.columns) {
    if (!column.locales.some((l) => activeLocales.includes(l))) continue;
    total++;
    if (isPairSelected(selection, item.rowId, column.columnId)) on++;
  }
  if (total === 0 || on === 0) return "unchecked";
  return on === total ? "checked" : "indeterminate";
}

/** Header checkbox: only "everything, without exceptions" reads as checked —
 * with a default-off column present it stays indeterminate, because it is NOT
 * the same thing as "all". */
export function allSelectionState(selection: TranslateSelection): TriState {
  if (selection.mode === "none" && selection.exceptions.size === 0) return "unchecked";
  if (selection.mode === "all" && selection.exceptions.size === 0 && selection.defaultOffColumnIds.length === 0) {
    return "checked";
  }
  return "indeterminate";
}

export function selectAllPairs(): TranslateSelection {
  return { mode: "all", defaultOffColumnIds: [], exceptions: new Set() };
}

export function deselectAllPairs(): TranslateSelection {
  return { mode: "none", defaultOffColumnIds: [], exceptions: new Set() };
}

/**
 * Exact number of selected units.
 *
 * `unitsByColumnLocale` is the server's aggregate over the WHOLE scan window
 * (columnId → locale → count), so the count is right for pages the merchant
 * never opened. Exceptions are corrections on top and are always pairs the
 * merchant saw, so their per-locale detail is known (`missingLocalesByPair`,
 * accumulated across pages by the caller).
 */
export function countSelectedUnits(
  selection: TranslateSelection,
  unitsByColumnLocale: Record<string, Record<string, number>>,
  activeLocales: string[],
  missingLocalesByPair: Map<string, string[]>,
): number {
  let units = 0;
  if (selection.mode === "all") {
    for (const [columnId, byLocale] of Object.entries(unitsByColumnLocale)) {
      if (selection.defaultOffColumnIds.includes(columnId)) continue;
      for (const locale of activeLocales) units += byLocale[locale] ?? 0;
    }
  }
  for (const key of selection.exceptions) {
    const parsed = parseTranslatePairKey(key);
    if (!parsed) continue;
    const missing = missingLocalesByPair.get(key);
    if (!missing) continue;
    const affected = missing.filter((l) => activeLocales.includes(l)).length;
    units += baseSelected(selection, parsed.columnId) ? -affected : affected;
  }
  return Math.max(0, units);
}

/** Items (rows) touched by the selection — only exact in "none" mode; in "all"
 * mode the row count comes from the server's scan total. */
export function countSelectedItemsInNoneMode(selection: TranslateSelection): number {
  const rows = new Set<string>();
  for (const key of selection.exceptions) {
    const parsed = parseTranslatePairKey(key);
    if (parsed) rows.add(parsed.rowId);
  }
  return rows.size;
}

// ─── Wire format (client → /api/ai) ────────────────────────────────────────

/** What the client sends. The server re-scans the candidate set with the same
 * filters and replays this selection over it — no cell list is trusted. */
export interface TranslateSelectionPayload {
  mode: TranslateSelectionMode;
  defaultOffColumnIds: string[];
  exceptions: string[];
}

export function serializeTranslateSelection(selection: TranslateSelection): TranslateSelectionPayload {
  return {
    mode: selection.mode,
    defaultOffColumnIds: [...selection.defaultOffColumnIds],
    exceptions: [...selection.exceptions],
  };
}

/** Server-side rebuild. Anything malformed collapses to "nothing selected" —
 * never to "everything" (a wrong default here would fan out AI calls over the
 * whole catalog). */
export function parseTranslateSelection(raw: unknown): TranslateSelection {
  const empty: TranslateSelection = { mode: "none", defaultOffColumnIds: [], exceptions: new Set() };
  if (!raw || typeof raw !== "object") return empty;
  const payload = raw as Partial<TranslateSelectionPayload>;
  if (payload.mode !== "all" && payload.mode !== "none") return empty;
  const defaultOffColumnIds = Array.isArray(payload.defaultOffColumnIds)
    ? payload.defaultOffColumnIds.filter((c): c is string => typeof c === "string")
    : [];
  const exceptions = Array.isArray(payload.exceptions)
    ? payload.exceptions.filter((e): e is string => typeof e === "string" && parseTranslatePairKey(e) !== null)
    : [];
  return { mode: payload.mode, defaultOffColumnIds, exceptions: new Set(exceptions) };
}

// ─── URL handles ───────────────────────────────────────────────────────────

/** German/Nordic letters Unicode decomposition does NOT expand ("ü" → "u", not
 * "ue") — a handle "buro" instead of "buero" is a different word. */
const HANDLE_TRANSLITERATION: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
  æ: "ae",
  ø: "oe",
  å: "aa",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
};

/**
 * AI output → a handle Shopify accepts: lowercase, a-z/0-9/"-" only.
 *
 * The prompt already asks for a slug, but a model that answers "Écharpe en
 * Soie" would otherwise be written verbatim and rejected by Shopify (or, worse,
 * accepted and turned into an unusable URL). Returns "" when nothing usable is
 * left — the caller then skips the cell instead of writing an empty handle.
 */
export function normalizeTranslatedHandle(value: string): string {
  const lowered = (value || "").trim().toLowerCase();
  if (!lowered) return "";
  let mapped = "";
  for (const char of lowered) mapped += HANDLE_TRANSLITERATION[char] ?? char;
  return mapped
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop the separated accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HANDLE_LENGTH)
    .replace(/-+$/g, "");
}

/**
 * Keeps handles unique WITHIN one run and locale: two products whose titles
 * translate to the same slug would otherwise fight over one URL. Mirrors
 * Shopify's own "-2" suffixing for primary handles.
 */
export function dedupeHandle(candidate: string, used: Set<string>): string {
  if (!candidate) return "";
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  for (let suffix = 2; suffix < 1000; suffix++) {
    const next = `${candidate}-${suffix}`;
    if (!used.has(next)) {
      used.add(next);
      return next;
    }
  }
  return "";
}
