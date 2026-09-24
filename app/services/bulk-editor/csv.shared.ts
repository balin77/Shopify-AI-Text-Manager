/**
 * Bulk editor — CSV export/import, pure pieces (docs/plans/PLAN_BULK_EDITOR.md
 * §8.1/§8.2).
 *
 * MUST STAY CLIENT-SAFE (same contract as columns.shared.ts): the route uses
 * the size limits and delimiter helper in client code, and the unit tests
 * exercise everything here without a server. The I/O halves live in
 * csv-export.server.ts (reading rows, building the file) and
 * csv-import.server.ts (resolving rows against the DB, computing the diff).
 *
 * Format decisions (§8.1), fixed here so export and import stay symmetric:
 * - UTF-8 **with BOM** — Excel misreads German umlauts without it.
 * - Delimiter `;` when the APP language is de/es, `,` for en (Excel's locale
 *   default); the import auto-detects `;`/`,`/tab regardless.
 * - CRLF line endings (RFC 4180, and what Excel writes back).
 * - Column headers are the **ColumnDescriptor.id** values ("field.title",
 *   "mf.custom.material", "var.price"), NOT localized labels — that makes the
 *   header ↔ column mapping on re-import exact instead of a translation
 *   guessing game. First column is always `id` (the GID); the second is the
 *   handle column (`field.handle`, doubling as recognition AND an editable
 *   column). Variant rows have no handle — they export product/variant title
 *   and SKU as recognition context and re-import resolves by `id` only.
 * - Money values are exported in the normalized dot form ("1299.90") — it is
 *   unambiguous across locales, and the grid's diff normalizes any localized
 *   form back anyway (parseMoney).
 * - Formula-injection guard: cell values starting with = + - @ are prefixed
 *   with a leading apostrophe on export (the file opens in Excel!); the
 *   import strips exactly that prefix again so a round trip is lossless (a
 *   value that already starts with `'=` gets a second apostrophe for the
 *   same reason).
 */

import type { ColumnDescriptor } from "./columns.shared";

// ─── Limits (§8.2 hard caps, §8.1 export ceiling) ──────────────────────────

/** Import file hard cap (5 MB) — checked client-side before reading AND
 * server-side on the posted text length. */
export const CSV_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Import row hard cap (data rows, header excluded). */
export const CSV_IMPORT_MAX_ROWS = 10_000;

/**
 * Synchronous export ceiling. The plan (§8.1) foresees a Task with a download
 * link beyond 5.000 rows — but the Task infrastructure has NO result-file
 * delivery mechanism (Task.result is a DB text column; there is no file
 * storage or download endpoint). Building half of one would be worse than
 * being honest: exports above this cap are refused with a clear "narrow your
 * filter" message instead. Documented deviation from §8.1.
 */
export const CSV_EXPORT_MAX_ROWS = 5_000;

/** UTF-8 byte-order mark — prepended to every export (§8.1). */
export const CSV_BOM = "\uFEFF";

export type CsvDelimiter = "," | ";" | "\t";

/** Delimiter by APP language (§8.1): de/es Excel expects `;`, en `,`. */
export function delimiterForAppLanguage(language: string): CsvDelimiter {
  const lang = language.toLowerCase().split(/[-_]/)[0];
  return lang === "de" || lang === "es" ? ";" : ",";
}

// ─── Cell encoding (RFC 4180 + formula-injection guard) ────────────────────

/** True when the raw value would be interpreted as a formula by Excel/Sheets.
 * Covers the formula starters = + - @ plus leading TAB / CR: a spreadsheet
 * strips leading whitespace before evaluating, so `\t=cmd` is just as live as
 * `=cmd` (OWASP CSV-injection guidance). */
const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;
/** A value that ALREADY starts with apostrophes in front of a formula starter
 * (`'=abc` is real content). It gets the export prefix too, or the import —
 * which strips exactly one apostrophe — would turn it into `=abc`. */
const PREFIXED_FORMULA_RE = /^'+[=+\-@\t\r]/;

/**
 * Encodes one cell for CSV output: apostrophe-prefixes formula starters, then
 * RFC-4180-quotes when the value contains the delimiter, a quote or a line
 * break (embedded quotes double).
 */
export function encodeCsvCell(value: string, delimiter: CsvDelimiter): string {
  let v = value;
  if (FORMULA_PREFIX_RE.test(v) || PREFIXED_FORMULA_RE.test(v)) v = `'${v}`;
  if (v.includes(delimiter) || v.includes('"') || v.includes("\n") || v.includes("\r")) {
    v = `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** Reverses the formula-injection prefix on import: ONE leading `'` in front
 * of (further apostrophes and) = + - @ is OUR export artifact and is
 * stripped; any other apostrophe is real content and stays. */
export function decodeCsvCell(value: string): string {
  return PREFIXED_FORMULA_RE.test(value) ? value.slice(1) : value;
}

/** Builds the complete CSV text: BOM + header + rows, CRLF-joined. */
export function buildCsv(header: string[], rows: string[][], delimiter: CsvDelimiter): string {
  const lines = [header, ...rows].map((cells) =>
    cells.map((c) => encodeCsvCell(c, delimiter)).join(delimiter),
  );
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

// ─── Parsing (import, §8.2 step 1) ─────────────────────────────────────────

/** Which text encoding an import file was READ as — anything but "utf8" is
 * named in the preview, so the merchant checks the umlauts before saving. */
export type CsvFileEncoding = "utf8" | "utf16" | "windows1252";

/**
 * Decodes an import file's bytes. A plain `file.text()` always decodes UTF-8,
 * and Excel's DEFAULT "CSV (Trennzeichen-getrennt)" writes Windows-1252: every
 * ü/ß/é of such a file became U+FFFD, differed from the DB, and was written to
 * Shopify as "Gr\uFFFDner Tee". Order: a UTF-16 BOM (Excel's "Unicode text")
 * decides first; then STRICT UTF-8, which cannot accidentally succeed on
 * Windows-1252 umlauts (a lone 0xFC is not valid UTF-8); only a file that is
 * not valid UTF-8 falls back to Windows-1252 — the encoding every Excel on a
 * Western-European install writes, and the one Shopify merchants in this
 * app's three languages actually produce.
 */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: CsvFileEncoding } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf16" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf16" };
  }
  // UTF-16 LE WITHOUT a BOM: our header starts with ASCII ("id…"), which
  // that encoding writes as <letter> 0x00 — a pattern valid UTF-8 would carry
  // as a NUL character, which no CSV of ours contains.
  if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0) {
    return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf16" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows1252" };
  }
}

export function stripBom(text: string): string {
  return text.startsWith(CSV_BOM) ? text.slice(1) : text;
}

/**
 * Detects the delimiter (`;` / `,` / tab) from the first data line by
 * counting occurrences OUTSIDE quoted sections — the most frequent wins, ties
 * resolved in the order `;` → `,` → tab (a German export full of commas in
 * the text but `;`-separated must not flip to comma).
 */
export function detectCsvDelimiter(text: string): CsvDelimiter {
  const source = stripBom(text);
  const firstLine = source.slice(0, indexOfLineEnd(source));
  const counts: Record<CsvDelimiter, number> = { ";": 0, ",": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === ";" || ch === "," || ch === "\t")) counts[ch as CsvDelimiter]++;
  }
  let best: CsvDelimiter = ";";
  for (const candidate of [";", ",", "\t"] as const) {
    if (counts[candidate] > counts[best]) best = candidate;
  }
  return best;
}

function indexOfLineEnd(text: string): number {
  // First \r or \n outside quotes — the header line may contain quoted breaks.
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) return i;
  }
  return text.length;
}

/**
 * RFC-4180 parser: quoted cells (embedded delimiters, doubled quotes, line
 * breaks inside cells), tolerant of \r\n, \n and \r endings. A trailing
 * newline does not produce a phantom empty record. No external dependency —
 * the format is small and package.json carries no CSV library (checked);
 * pulling one in for ~60 lines would be the heavier choice.
 */
export function parseCsv(text: string, delimiter?: CsvDelimiter): string[][] {
  const source = stripBom(text);
  const delim = delimiter ?? detectCsvDelimiter(source);
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  const endCell = () => {
    record.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    records.push(record);
    record = [];
  };

  while (i < source.length) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delim) {
      endCell();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endRecord();
      if (ch === "\r" && source[i + 1] === "\n") i += 2;
      else i++;
      continue;
    }
    cell += ch;
    i++;
  }
  // Flush the final record unless the file ended exactly on a newline.
  if (cell !== "" || record.length > 0) endRecord();
  return records;
}

// ─── Header mapping (§8.2 step 1) ──────────────────────────────────────────

/** Header of the id column — always the FIRST exported column. */
export const CSV_ID_HEADER = "id";

/** Separator of the id header's scope marker (`id@de@gid://shopify/Market/1`).
 * "@" occurs in no locale code and no GID, so a plain split is exact. */
const CSV_SCOPE_SEPARATOR = "@";
/** Scope marker of a PRIMARY-language export — a locale code can never be
 * this word, so it cannot collide with a real foreign locale. */
const CSV_PRIMARY_SCOPE = "primary";

/**
 * The id header an export writes: `id@primary`, `id@de` or
 * `id@de@<Market GID>`. A file carries no other trace of the language it was
 * exported in — only the filename, which says nothing about the market and is
 * gone the moment a merchant renames it — and the import always writes into
 * the language the GRID is on. Without the marker, a German export edited in
 * Excel and imported while the grid shows the primary language overwrote the
 * primary texts with German ones, and the preview had no way to notice.
 */
export function csvIdHeaderFor(locale: string, marketId: string): string {
  if (locale === "") return `${CSV_ID_HEADER}${CSV_SCOPE_SEPARATOR}${CSV_PRIMARY_SCOPE}`;
  return marketId === ""
    ? `${CSV_ID_HEADER}${CSV_SCOPE_SEPARATOR}${locale}`
    : `${CSV_ID_HEADER}${CSV_SCOPE_SEPARATOR}${locale}${CSV_SCOPE_SEPARATOR}${marketId}`;
}

/** The language/market layer a file was exported from — `null` for an
 * UNMARKED `id` header (a hand-built file, or one exported before the marker
 * existed), which the import accepts as-is. */
export interface CsvFileScope {
  /** "" = primary. */
  locale: string;
  /** "" = global. */
  marketId: string;
}

/** Recognises an id header (marked or not). `undefined` = not an id header at
 * all; `null` = the plain, unmarked `id`. */
export function parseCsvIdHeader(name: string): CsvFileScope | null | undefined {
  if (name === CSV_ID_HEADER) return null;
  const prefix = `${CSV_ID_HEADER}${CSV_SCOPE_SEPARATOR}`;
  if (!name.startsWith(prefix)) return undefined;
  const [locale, ...market] = name.slice(prefix.length).split(CSV_SCOPE_SEPARATOR);
  if (!locale) return undefined;
  if (locale === CSV_PRIMARY_SCOPE) return { locale: "", marketId: "" };
  return { locale, marketId: market.join(CSV_SCOPE_SEPARATOR) };
}

export interface CsvHeaderMapping {
  /** Index of the `id` column, -1 when absent. */
  idIndex: number;
  /** The layer the id header names (`id@de`), `null` when unmarked. */
  fileScope: CsvFileScope | null;
  /** column-index → editable column descriptor, for every mapped column. */
  columns: { index: number; column: ColumnDescriptor }[];
  /** Headers that match NO column of the current type — REPORTED in the
   * dialog, never silently ignored (§8.2). */
  unknown: string[];
  /** Headers of known columns that are not editable in the current view
   * (read-only columns, or non-translatable columns while a foreign locale is
   * selected) — reported as "ignored", separately from unknown. */
  ignored: string[];
}

/**
 * Maps CSV headers onto ColumnDescriptor.ids. `columns` MUST be the
 * server-built universe of the row type (buildServerColumnsByType) — that is
 * what makes "which columns may this merchant edit" a server truth (§8.2).
 * With `foreign` set, only translatable columns map as editable (the same
 * rule the grid applies).
 */
export function mapCsvHeader(
  header: string[],
  columns: ColumnDescriptor[],
  opts: { foreign: boolean },
): CsvHeaderMapping {
  const byId = new Map(columns.map((c) => [c.id, c] as const));
  const mapping: CsvHeaderMapping = { idIndex: -1, fileScope: null, columns: [], unknown: [], ignored: [] };
  header.forEach((rawName, index) => {
    const name = rawName.trim();
    if (name === "") return; // trailing empty header cells (Excel artifacts)
    const scope = parseCsvIdHeader(name);
    if (scope !== undefined) {
      if (mapping.idIndex === -1) {
        mapping.idIndex = index;
        mapping.fileScope = scope;
      }
      return;
    }
    const column = byId.get(name);
    if (!column) {
      mapping.unknown.push(name);
      return;
    }
    if (!column.editable || (opts.foreign && !column.translatable)) {
      mapping.ignored.push(name);
      return;
    }
    mapping.columns.push({ index, column });
  });
  return mapping;
}

// ─── Row resolution (§8.2 step 2 — pure part) ──────────────────────────────

export type CsvRowErrorKind =
  | "missingId"
  | "unknownId"
  | "unknownHandle"
  | "ambiguousHandle"
  /** A second line resolving to a row an earlier line already named. */
  | "duplicateRow";

export interface CsvRowError {
  /** 1-based CSV line (header = line 1, first data row = 2). */
  line: number;
  kind: CsvRowErrorKind;
  /** The offending id/handle (may be "" for missingId). */
  value: string;
}

/**
 * Resolves one CSV record to a row id: the `id` column wins; an empty id
 * falls back to the handle column. An ambiguous handle (several rows share
 * it) is an ERROR, never a guess (§8.2). `knownIds` is the set of ids that
 * exist in the DB for this shop+type; `idsByHandle` maps handle → all ids
 * carrying it.
 */
export function resolveCsvRowId(
  record: { id: string; handle: string; line: number },
  knownIds: ReadonlySet<string>,
  idsByHandle: ReadonlyMap<string, string[]>,
): { ok: true; rowId: string } | { ok: false; error: CsvRowError } {
  const id = record.id.trim();
  if (id !== "") {
    if (!knownIds.has(id)) {
      return { ok: false, error: { line: record.line, kind: "unknownId", value: id } };
    }
    return { ok: true, rowId: id };
  }
  const handle = record.handle.trim();
  if (handle === "") {
    return { ok: false, error: { line: record.line, kind: "missingId", value: "" } };
  }
  const ids = idsByHandle.get(handle) ?? [];
  if (ids.length === 0) {
    return { ok: false, error: { line: record.line, kind: "unknownHandle", value: handle } };
  }
  if (ids.length > 1) {
    return { ok: false, error: { line: record.line, kind: "ambiguousHandle", value: handle } };
  }
  return { ok: true, rowId: ids[0] };
}

// ─── Edit-map construction (§8.2 step 3 — pure part) ───────────────────────

/**
 * Turns parsed CSV records into EXACTLY the edit map that typing the same
 * values into the grid would produce — `${rowId}|${locale}|${marketId}|
 * ${columnId}` keys with the decoded cell text as value. The import then runs
 * the SAME computeDiff over it (no own write path, §8.2): identical inputs ⇒
 * identical diff, which is what the "Import-Diff = Grid-Diff" test locks.
 *
 * Note the spreadsheet semantics this implies: every mapped cell of a
 * resolved row lands in the map, so an EMPTY cell over existing content is a
 * deliberate clear — exactly like clearing the cell in the grid. The preview
 * dialog says so explicitly before anything is saved.
 */
export function editsFromCsvRecords(
  records: { rowId: string; cells: string[] }[],
  mapping: CsvHeaderMapping,
  locale: string,
  marketId: string,
): Record<string, string> {
  const edits: Record<string, string> = {};
  for (const record of records) {
    for (const { index, column } of mapping.columns) {
      const raw = record.cells[index];
      if (raw === undefined) continue; // short record — no cell, no edit
      edits[`${record.rowId}|${locale}|${marketId}|${column.id}`] = decodeCsvCell(raw);
    }
  }
  return edits;
}
