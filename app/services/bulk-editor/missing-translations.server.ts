/**
 * Bulk editor — candidate scan for the "translate missing" page.
 *
 * ONE source of truth for "what is missing": the page loader lists it, the
 * /api/ai task re-runs the very same scan before translating anything. The
 * client's selection is replayed over the server's own scan (§ selection model
 * in translate-missing.shared.ts) — a client-supplied cell list is never
 * trusted, and a cell that got filled in the meantime silently drops out.
 *
 * "Missing" is evaluated GLOBALLY (marketId "") — the page deliberately has no
 * market dimension (a market override is a per-cell decision, and the loader's
 * missing-detection has no market layer). A field counts as missing when the
 * PRIMARY value is non-empty (there is something to translate) and the foreign
 * locale has no non-empty translation.
 *
 * Server-only: Prisma + the row loader. The shapes it returns are the
 * client-safe ones from translate-missing.shared.ts.
 */

import type { PrismaClient } from "@prisma/client";
import { loadBulkRows, type BulkAdminClient } from "./load.server";
import { translationKeyForColumn, CONTENT_RESOURCE_TYPE_BY_ROW_TYPE } from "./translations.server";
import {
  primaryValueForColumn,
  METAFIELD_TYPE_SINGLE_LINE,
  METAFIELD_TYPE_MULTI_LINE,
  type BulkFilterId,
  type BulkRow,
  type BulkRowType,
  type ColumnDescriptor,
} from "./columns.shared";
import {
  MAX_TRANSLATE_CANDIDATE_ITEMS,
  MAX_TRANSLATE_SCAN_ROWS,
  TRANSLATE_SCAN_CHUNK,
  type MissingItem,
} from "./translate-missing.shared";

/**
 * Columns the page offers for AI translation, in display order.
 *
 * - `field` columns: everything Shopify has a translatable key for — INCLUDING
 *   `field.handle` (the old modal excluded it; the page offers it opt-in and
 *   normalizes the AI's slug, see translate-missing.shared.ts).
 * - `mofield` columns: metaobject field translations go through the same
 *   verified write path (MetaobjectTranslation). Only single/multi-line text —
 *   `list.*` fields carry their entries in ONE string separated by "|", which a
 *   translation would shatter, and rich_text is read-only everywhere.
 * - `metafield`, `option`, `image` columns are NOT offered: their translations
 *   do not ride on the row's own translatableResource (metafield translations
 *   are keyed on the METAFIELD gid, option translations on the option/value
 *   gids, alt-texts on the MediaImage), so applyBulkDiff has no verified write
 *   path for them at all. Offering them would produce cell errors, not
 *   translations.
 */
export function translateCandidateColumns(
  columns: ColumnDescriptor[],
  type: BulkRowType,
  moType: string,
): ColumnDescriptor[] {
  return columns.filter((column) => {
    if (!column.translatable) return false;
    if (column.kind === "field") return translationKeyForColumn(column, type) !== null;
    if (column.kind === "mofield") {
      if (type !== "metaobject" || (moType && column.moType !== moType)) return false;
      return (
        column.moFieldType === METAFIELD_TYPE_SINGLE_LINE || column.moFieldType === METAFIELD_TYPE_MULTI_LINE
      );
    }
    return false;
  });
}

/** Shopify translatable-content key of a candidate column. */
export function candidateTranslationKey(column: ColumnDescriptor, type: BulkRowType): string | null {
  if (column.kind === "mofield") return column.moFieldKey ?? null;
  return translationKeyForColumn(column, type);
}

/** The row's PRIMARY value for a candidate column — the AI's source text. */
export function candidateSourceValue(row: BulkRow, column: ColumnDescriptor): string {
  if (column.kind === "mofield") return row.moFields?.[column.id] ?? "";
  return primaryValueForColumn(row, column);
}

export interface MissingScanOptions {
  type: BulkRowType;
  search: string;
  filters: BulkFilterId[];
  moType: string;
  /** Published, non-primary shop locales. */
  foreignLocales: string[];
  /** Candidate columns (already plan-filtered by the caller). */
  columns: ColumnDescriptor[];
  /** Blog rows are live-fetched — the loader needs the admin client. */
  admin?: BulkAdminClient;
  /** Attach the primary source texts (+ the row's handle). The TASK needs
   * them; the page's loader does not — shipping every product description to
   * the browser to draw a checkbox list would be pure payload. */
  withSources?: boolean;
}

export interface MissingScanResult {
  /** EVERY candidate of the scan window, in row order — the caller slices the
   * page (and the runner walks it until the unit cap). */
  items: MissingItem[];
  /** columnId → locale → number of missing units in the whole window. */
  unitsByColumnLocale: Record<string, Record<string, number>>;
  /** Rows matching the filter (may exceed the scanned window). */
  matchedRows: number;
  scannedRows: number;
  /** True when the filter matched more rows than MAX_TRANSLATE_SCAN_ROWS — the
   * list and every run cover the first N only, and the UI says so. */
  scanTruncated: boolean;
}

/** Rows carry no dynamic product payloads here: the candidate columns never
 * include metafield/option/image columns, so loading them would be waste. */
const NO_PRODUCT_CELLS: NonNullable<Parameters<typeof loadBulkRows>[2]["productCells"]> = {
  metafieldSpecs: [],
  caps: { metafields: false, options: false, imageAlt: false },
};

export async function scanMissingTranslations(
  db: PrismaClient,
  shop: string,
  opts: MissingScanOptions,
): Promise<MissingScanResult> {
  const empty: MissingScanResult = {
    items: [],
    unitsByColumnLocale: {},
    matchedRows: 0,
    scannedRows: 0,
    scanTruncated: false,
  };
  if (opts.foreignLocales.length === 0 || opts.columns.length === 0) return empty;

  // columnId → Shopify key. Bijective per row type.
  const keyByColumnId = new Map<string, string>();
  for (const column of opts.columns) {
    const key = candidateTranslationKey(column, opts.type);
    if (key) keyByColumnId.set(column.id, key);
  }
  if (keyByColumnId.size === 0) return empty;
  const keys = [...new Set(keyByColumnId.values())];

  // "missingTranslation" is a FOREIGN-view filter (load.server.ts gates every
  // one of its branches on locale !== ""), and this scan runs on the primary
  // view — carrying it along would leave it silently inert while `matchedRows`
  // reported an unfiltered total. It is also redundant: this page IS the
  // missing-translation view.
  const filters = opts.filters.filter((f) => f !== "missingTranslation");

  const items: MissingItem[] = [];
  const unitsByColumnLocale: Record<string, Record<string, number>> = {};
  let matchedRows = 0;
  let scannedRows = 0;
  let exhausted = false;

  // Chunked walk instead of one big window: rows that are already fully
  // translated must NOT occupy the budget, otherwise a shop whose first N rows
  // are done would be told "nothing is missing" forever.
  while (scannedRows < MAX_TRANSLATE_SCAN_ROWS && items.length < MAX_TRANSLATE_CANDIDATE_ITEMS) {
    const take = Math.min(TRANSLATE_SCAN_CHUNK, MAX_TRANSLATE_SCAN_ROWS - scannedRows);
    const { rows, total } = await loadBulkRows(db, shop, {
      type: opts.type,
      // Primary view: the scan reads primary values and compares them against
      // the translation tables itself.
      locale: "",
      marketId: "",
      search: opts.search,
      filters,
      sort: null,
      skip: scannedRows,
      take,
      productCells: NO_PRODUCT_CELLS,
      admin: opts.admin,
      moType: opts.moType,
    });
    matchedRows = total;
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    scannedRows += rows.length;

    const translated = await loadTranslatedLocales(db, shop, opts, rows, keys);
    for (const row of rows) {
      const byKey = translated.get(row.id);
      const columns: MissingItem["columns"] = [];
      for (const column of opts.columns) {
        const key = keyByColumnId.get(column.id);
        if (!key) continue;
        // Nothing to translate without a primary value — the same rule the old
        // task used, and the reason an "empty everywhere" field never shows up.
        const source = candidateSourceValue(row, column);
        if (source.trim() === "") continue;
        const have = byKey?.get(key);
        const missing = opts.foreignLocales.filter((locale) => !have?.has(locale));
        if (missing.length === 0) continue;
        columns.push({
          columnId: column.id,
          locales: missing,
          ...(opts.withSources ? { source } : {}),
        });
        const byLocale = (unitsByColumnLocale[column.id] ??= {});
        for (const locale of missing) byLocale[locale] = (byLocale[locale] ?? 0) + 1;
      }
      if (columns.length === 0) continue;
      items.push({
        rowId: row.id,
        title: row.title || row.handle || row.id,
        subtitle: subtitleOf(row),
        ...(row.imageUrl ? { imageUrl: row.imageUrl } : {}),
        ...(opts.withSources ? { primaryHandle: row.handle ?? "" } : {}),
        columns,
      });
    }

    if (scannedRows >= total) {
      exhausted = true;
      break;
    }
  }

  return {
    items,
    unitsByColumnLocale,
    matchedRows,
    scannedRows,
    // Truncated = the walk stopped on a budget while rows were left over. When
    // it ran out of rows, the result is complete no matter how far it walked.
    scanTruncated: !exhausted && scannedRows < matchedRows,
  };
}

/** Second line of an item — enough context to tell two similar titles apart. */
function subtitleOf(row: BulkRow): string {
  if (row.type === "article") return row.blogTitle || row.handle || "";
  if (row.type === "metaobject") return row.handle || row.moType || "";
  return row.handle || "";
}

/**
 * rowId → key → set of locales that ALREADY carry a non-empty global
 * translation. Metaobjects read their own table (MetaobjectTranslation);
 * everything else reads ContentTranslation — the same split the grid loader
 * uses.
 */
async function loadTranslatedLocales(
  db: PrismaClient,
  shop: string,
  opts: MissingScanOptions,
  rows: BulkRow[],
  keys: string[],
): Promise<Map<string, Map<string, Set<string>>>> {
  const rowIds = rows.map((r) => r.id);
  const isMetaobject = opts.type === "metaobject";
  const records = isMetaobject
    ? (
        await db.metaobjectTranslation.findMany({
          where: {
            shop,
            metaobjectId: { in: rowIds },
            marketId: "",
            key: { in: keys },
            locale: { in: opts.foreignLocales },
          },
          select: { metaobjectId: true, key: true, locale: true, value: true },
        })
      ).map((t) => ({ rowId: t.metaobjectId, key: t.key, locale: t.locale, value: t.value }))
    : (
        await db.contentTranslation.findMany({
          where: {
            shop,
            resourceType: CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[opts.type],
            resourceId: { in: rowIds },
            marketId: "",
            key: { in: keys },
            locale: { in: opts.foreignLocales },
          },
          select: { resourceId: true, key: true, locale: true, value: true },
        })
      ).map((t) => ({ rowId: t.resourceId, key: t.key, locale: t.locale, value: t.value }));

  const byRow = new Map<string, Map<string, Set<string>>>();
  for (const record of records) {
    // An empty translation counts as MISSING (a cleared cell is not a
    // translation) — same rule as the grid's blue "missing" colour.
    if (!record.value || record.value.trim() === "") continue;
    let byKey = byRow.get(record.rowId);
    if (!byKey) {
      byKey = new Map();
      byRow.set(record.rowId, byKey);
    }
    let locales = byKey.get(record.key);
    if (!locales) {
      locales = new Set();
      byKey.set(record.key, locales);
    }
    locales.add(record.locale);
  }
  return byRow;
}
