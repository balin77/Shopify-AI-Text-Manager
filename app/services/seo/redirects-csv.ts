/**
 * CSV parser for the redirects importer. Pure — no Remix/React deps — so it's
 * unit-testable and used by both the client (to build the payload) and, in
 * principle, any future server-side importer.
 *
 * Compatibility goal: accept the app's own export (`path,target`) AND the
 * common third-party formats users try to bring over: Shopify's admin export
 * (`Redirect from,Redirect to`), Yoast / Rank Math / SEOPress WordPress
 * exports (`Source URL,Target URL,Type`), German Excel `;`-delimited CSVs,
 * and rows containing absolute URLs instead of relative paths.
 *
 * Non-goals: regex-typed rows are surfaced as an `unsupportedRegex` error —
 * Shopify's native URL redirects only support exact paths.
 */

export type RedirectCsvRow = {
  path: string;
  target: string;
  /** 1-based row number in the source CSV, for error reporting to the user. */
  csvRow: number;
};

export type RedirectCsvError = {
  /** 1-based row number in the source CSV. */
  row: number;
  path: string;
  /** i18n error code (see `t.seo.redirectsPage.errors.*`). */
  error: string;
};

export type RedirectCsvResult = {
  rows: RedirectCsvRow[];
  errors: RedirectCsvError[];
};

// Header aliases — normalized by lower-casing and stripping whitespace/`_`/`-`.
// Covers Shopify's own export, common WordPress SEO plugins, and generic
// spreadsheets. Order-agnostic: whichever column carries the recognized
// header wins, regardless of position.
const PATH_HEADERS = new Set([
  "path",
  "from",
  "source",
  "sourceurl",
  "redirectfrom",
  "oldurl",
  "old",
  "origin",
  "originalurl",
  "requesturl",
  "url",
]);
const TARGET_HEADERS = new Set([
  "target",
  "to",
  "destination",
  "targeturl",
  "redirectto",
  "newurl",
  "new",
  "destinationurl",
]);
const TYPE_HEADERS = new Set([
  "type",
  "code",
  "redirecttype",
  "statuscode",
  "status",
  "matchtype",
]);
const REGEX_TYPE_MARKERS = new Set(["regex", "regexp", "regularexpression"]);

function normHeader(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_\-]+/g, "");
}

/**
 * Auto-detect the field delimiter from the first line. German Excel writes
 * `;`; US Excel writes `,`; some SEO tools export tab-separated. We count
 * occurrences outside of quoted regions (approximate — a full state-machine
 * pass isn't worth it for header detection).
 */
function detectDelimiter(firstLine: string): string {
  let inQuotes = false;
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') {
      if (inQuotes && firstLine[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch in counts) counts[ch]++;
  }
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

/**
 * Split CSV text into a grid of cells, honoring quoted fields and escaped
 * quotes (`""`). Supports LF, CRLF, and lone-CR line endings.
 *
 * Empty lines are preserved as `[""]` rather than dropped — the caller
 * filters them by content, but keeping them in the grid means the row
 * index matches the line number the user sees in Excel (which matters for
 * error reporting on partially-broken imports).
 */
function parseCsvGrid(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Coerce a source-column value to a shop-relative path.
 *
 * - `https://any-host.com/foo?utm=x` → `/foo` (origin + query dropped;
 *   Shopify redirects are always shop-relative — the origin is meaningless
 *   for the source side).
 * - `/foo?x=1` → `/foo` (Shopify's redirect matcher ignores the query
 *   anyway, so keeping it would just cause validation surprises).
 * - `foo` (no leading slash) → `foo` (left as-is so `validateRedirect`
 *   surfaces `pathLeadingSlash` instead of silently prepending — that way
 *   the user is told what's malformed).
 */
export function coerceSourcePath(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return u.pathname || "/";
    } catch { /* fall through — treat as literal */ }
  }
  const qIdx = s.indexOf("?");
  const noQuery = qIdx >= 0 ? s.slice(0, qIdx) : s;
  const hIdx = noQuery.indexOf("#");
  return hIdx >= 0 ? noQuery.slice(0, hIdx) : noQuery;
}

/**
 * Coerce a target-column value. Absolute URLs are collapsed to a path the
 * same way as the source, because the overwhelmingly common third-party
 * export is same-domain (Yoast/Rank Math dump the shop's own origin on both
 * sides). Merchants who want a genuine external redirect can edit after
 * import — that's rarer and more visible than silently creating dozens of
 * cross-domain redirects the merchant didn't intend.
 */
export function coerceTargetPath(raw: string): string {
  return coerceSourcePath(raw);
}

/**
 * Should we treat the first row as a header?
 *
 * Two cases:
 *  1. Any cell matches a known header alias — obvious header.
 *  2. No known alias, but the first cell doesn't look like a redirect
 *     source (no leading `/`, not an http(s):// URL) — treat as an unknown
 *     header rather than misreading it as data. This handles exotic
 *     header names like `oldpath|newpath` that we haven't aliased.
 */
function detectHeader(headerRow: string[]): {
  isHeader: boolean;
  pathIdx: number;
  targetIdx: number;
  typeIdx: number;
} {
  const normalized = headerRow.map(normHeader);
  let pathIdx = -1;
  let targetIdx = -1;
  let typeIdx = -1;
  for (let i = 0; i < normalized.length; i++) {
    const h = normalized[i];
    if (pathIdx < 0 && PATH_HEADERS.has(h)) pathIdx = i;
    else if (targetIdx < 0 && TARGET_HEADERS.has(h)) targetIdx = i;
    else if (typeIdx < 0 && TYPE_HEADERS.has(h)) typeIdx = i;
  }
  const anyRecognized = pathIdx >= 0 || targetIdx >= 0 || typeIdx >= 0;
  if (anyRecognized) {
    return {
      isHeader: true,
      pathIdx: pathIdx >= 0 ? pathIdx : 0,
      targetIdx: targetIdx >= 0 ? targetIdx : 1,
      typeIdx,
    };
  }
  const firstCell = (headerRow[0] ?? "").trim();
  const looksLikeData =
    firstCell.startsWith("/") || /^https?:\/\//i.test(firstCell);
  return {
    isHeader: !looksLikeData && firstCell.length > 0,
    pathIdx: 0,
    targetIdx: 1,
    typeIdx: -1,
  };
}

export function parseRedirectsCsv(text: string): RedirectCsvResult {
  const rows: RedirectCsvRow[] = [];
  const errors: RedirectCsvError[] = [];

  const firstNewline = text.search(/[\r\n]/);
  const firstLine = firstNewline >= 0 ? text.slice(0, firstNewline) : text;
  const delimiter = detectDelimiter(firstLine);

  const grid = parseCsvGrid(text, delimiter);
  if (grid.length === 0) return { rows, errors };

  const { isHeader, pathIdx, targetIdx, typeIdx } = detectHeader(grid[0]);
  const startRow = isHeader ? 1 : 0;

  for (let idx = startRow; idx < grid.length; idx++) {
    const raw = grid[idx];
    const sourceCell = raw[pathIdx] ?? "";
    const targetCell = raw[targetIdx] ?? "";
    if (!sourceCell.trim() && !targetCell.trim()) continue;

    const csvRow = idx + 1;

    if (typeIdx >= 0) {
      const typeVal = normHeader(raw[typeIdx] ?? "");
      if (REGEX_TYPE_MARKERS.has(typeVal)) {
        errors.push({
          row: csvRow,
          path: sourceCell.trim(),
          error: "unsupportedRegex",
        });
        continue;
      }
    }

    rows.push({
      csvRow,
      path: coerceSourcePath(sourceCell),
      target: coerceTargetPath(targetCell),
    });
  }

  return { rows, errors };
}
