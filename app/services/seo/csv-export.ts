/**
 * The ONE CSV serializer for the SEO section's exports
 * (PLAN_SEO_CRAWL_EXPANSION §5.3).
 *
 * `redirects-csv.ts` and `keywords-csv.ts` only ever PARSED; each export route
 * carried its own three-line `csvEscape`, and the crawl/on-page exports would
 * have made that a fourth and fifth copy. Pure, so it stays unit-testable and
 * usable from a resource route without pulling anything server-only in.
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

export interface CsvOptions {
  /**
   * Field separator. `;` is the default because Excel in a DE/EU locale splits
   * on the LIST separator, not on a comma — a `,`-delimited file lands entirely
   * in column A there, which is precisely the audience for these exports.
   */
  delimiter?: string;
  /**
   * Prepend a UTF-8 BOM. Without it Excel reads the file as the system's
   * legacy code page and mangles every umlaut/accent in a title or URL.
   */
  bom?: boolean;
}

const BOM = "﻿";

/**
 * Quote a cell and double any embedded quote (RFC 4180).
 *
 * Everything is quoted rather than only the cells that need it: a URL can
 * contain the delimiter and a crawled title can contain a newline, so
 * conditional quoting is one missed case away from a shifted column.
 *
 * A leading `=`, `+`, `-`, `@`, tab or CR is additionally prefixed with `'`.
 * Excel and Sheets evaluate such a cell as a FORMULA even inside quotes, and
 * these exports carry `<title>` text and URLs straight out of crawled HTML —
 * i.e. content this app does not author. Same guard the Search Console export
 * already applies to Google query strings, for the same reason.
 */
export function csvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const deFormulaed = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${deFormulaed.replace(/"/g, '""')}"`;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[], options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ";";
  const bom = options.bom ?? true;
  const lines: string[] = [columns.map((c) => csvCell(c.header)).join(delimiter)];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.value(row))).join(delimiter));
  }
  // Trailing newline: some parsers drop the last record without one.
  return (bom ? BOM : "") + lines.join("\n") + "\n";
}

/** `redirects-shop-name.csv` — a filename that survives every OS. */
export function csvFilename(prefix: string, shop: string): string {
  const slug = shop.replace(/\.myshopify\.com$/, "").replace(/[^a-z0-9-]/gi, "-");
  return `${prefix}-${slug}.csv`;
}
