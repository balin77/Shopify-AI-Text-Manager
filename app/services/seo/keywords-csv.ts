/**
 * CSV parser for the keyword-group importer (PLAN_KEYWORDS_EXPANSION.md §5.3).
 * Pure — no Remix/React deps — reusing the battle-tested grid/delimiter/header
 * machinery from redirects-csv.ts, so German `;`-Excel files, quoted fields
 * and CRLF endings behave identically across both importers.
 *
 * Expected columns: `keyword` (required), `priority` (optional 1/2/3),
 * `intent` (optional), `locale` (optional). NO resourceId column — assignment
 * happens after import via AI distribution or manually (plan §5.3).
 * A headerless single-column file is treated as a plain keyword list.
 */

import { parseCsvGrid, detectDelimiter, normHeader } from "./redirects-csv";
import { normalizeKeyword, MAX_KEYWORD_LENGTH } from "./keywords.service";

export interface KeywordCsvRow {
  keyword: string; // normalized (lowercased, single-spaced)
  /** 1/2/3 when the file explicitly sets one; undefined otherwise. The
   *  distinction matters downstream: an explicit value overrides an existing
   *  keyword's priority, an absent one must NOT reset it to the default. */
  priority?: number;
  intent: string | null;
  locale: string; // "" = primary
  /** 1-based row number in the source CSV, for error reporting. */
  csvRow: number;
}

export interface KeywordCsvError {
  row: number;
  keyword: string;
  /** i18n error code (see `t.seo.keywordsPage.csvErrors.*`). */
  error: string;
}

export interface KeywordCsvResult {
  rows: KeywordCsvRow[];
  errors: KeywordCsvError[];
}

const KEYWORD_HEADERS = new Set(["keyword", "keywords", "query", "suchbegriff", "suchanfrage", "palabraclave"]);
const PRIORITY_HEADERS = new Set(["priority", "prio", "prioritaet", "priorität", "prioridad"]);
const INTENT_HEADERS = new Set(["intent", "searchintent", "suchintention", "intencion", "intención"]);
const LOCALE_HEADERS = new Set(["locale", "lang", "language", "sprache", "idioma"]);

const VALID_INTENTS = new Set(["informational", "commercial", "transactional", "navigational"]);

export function parseKeywordsCsv(
  text: string,
  /** Published secondary locale codes (lowercased). A row naming any other
   *  non-empty locale errors instead of silently creating keywords under a
   *  locale the shop doesn't have. */
  validLocales: Set<string>,
): KeywordCsvResult {
  const rows: KeywordCsvRow[] = [];
  const errors: KeywordCsvError[] = [];

  const firstNewline = text.search(/[\r\n]/);
  const firstLine = firstNewline >= 0 ? text.slice(0, firstNewline) : text;
  const delimiter = detectDelimiter(firstLine);

  const grid = parseCsvGrid(text, delimiter);
  if (grid.length === 0) return { rows, errors };

  // Header detection: same philosophy as redirects-csv — only skip row 1 when
  // a cell matches a known alias; otherwise the file is headerless and column
  // 0 is the keyword.
  const headerRow = grid[0].map(normHeader);
  let keywordIdx = -1;
  let priorityIdx = -1;
  let intentIdx = -1;
  let localeIdx = -1;
  for (let i = 0; i < headerRow.length; i++) {
    const h = headerRow[i];
    if (keywordIdx < 0 && KEYWORD_HEADERS.has(h)) keywordIdx = i;
    else if (priorityIdx < 0 && PRIORITY_HEADERS.has(h)) priorityIdx = i;
    else if (intentIdx < 0 && INTENT_HEADERS.has(h)) intentIdx = i;
    else if (localeIdx < 0 && LOCALE_HEADERS.has(h)) localeIdx = i;
  }
  const isHeader = keywordIdx >= 0 || priorityIdx >= 0 || intentIdx >= 0 || localeIdx >= 0;
  if (keywordIdx < 0) keywordIdx = 0;
  const startRow = isHeader ? 1 : 0;

  const seen = new Set<string>(); // dedupe within the file by (keyword, locale)
  for (let idx = startRow; idx < grid.length; idx++) {
    const raw = grid[idx];
    const keywordCell = (raw[keywordIdx] ?? "").trim();
    if (!keywordCell) continue; // empty line / padding row
    const csvRow = idx + 1;

    const keyword = normalizeKeyword(keywordCell);
    if (!keyword) continue;
    if (keyword.length > MAX_KEYWORD_LENGTH) {
      errors.push({ row: csvRow, keyword: keywordCell, error: "tooLong" });
      continue;
    }

    let priority: number | undefined;
    if (priorityIdx >= 0) {
      const p = (raw[priorityIdx] ?? "").trim();
      if (p) {
        const n = Number(p);
        if (n === 1 || n === 2 || n === 3) priority = n;
        else {
          errors.push({ row: csvRow, keyword: keywordCell, error: "badPriority" });
          continue;
        }
      }
    }

    let intent: string | null = null;
    if (intentIdx >= 0) {
      const i = (raw[intentIdx] ?? "").trim().toLowerCase();
      if (i) {
        if (!VALID_INTENTS.has(i)) {
          errors.push({ row: csvRow, keyword: keywordCell, error: "badIntent" });
          continue;
        }
        intent = i;
      }
    }

    let locale = "";
    if (localeIdx >= 0) {
      const l = (raw[localeIdx] ?? "").trim().toLowerCase();
      if (l && !validLocales.has(l)) {
        errors.push({ row: csvRow, keyword: keywordCell, error: "badLocale" });
        continue;
      }
      locale = l;
    }

    const dedupeKey = `${keyword}::${locale}`;
    if (seen.has(dedupeKey)) continue; // silent within-file dedupe
    seen.add(dedupeKey);

    rows.push({ keyword, priority, intent, locale, csvRow });
  }

  return { rows, errors };
}
