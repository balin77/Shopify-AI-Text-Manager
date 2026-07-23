/**
 * Bulk editor — CSV import, server half (docs/plans/PLAN_BULK_EDITOR.md §8.2).
 *
 * The import has NO write path of its own. It produces EXACTLY the diff that
 * typing the same values into the grid would produce:
 *
 * 1. parse the file (own RFC-4180 parser, csv.shared.ts — delimiter/BOM
 *    detection), map headers onto ColumnDescriptor.ids; unknown headers are
 *    REPORTED, not silently dropped;
 * 2. resolve rows by `id`, falling back to `handle` (ambiguous ⇒ error, no
 *    guessing; variant rows resolve by id only — SKUs are not unique);
 * 3. diff against the CURRENT DB values, computed server-side (the client
 *    only holds the visible page) with the SAME computeDiff the grid uses;
 * 4. the route returns the preview ("X rows, Y cells change" + the first 50
 *    changes in clear text); only after the merchant confirms does the
 *    CLIENT submit the diff through the known pipeline (route action ≤
 *    MAX_SYNC_SAVE, otherwise the seoBulkMeta task) — both entrances
 *    re-validate every entry against the server-built column universe.
 *
 * Hard limits (§8.2): CSV_IMPORT_MAX_BYTES / CSV_IMPORT_MAX_ROWS (enforced in
 * the route), and only columns the merchant could edit in the grid for this
 * plan + row type (`columns` MUST come from buildServerColumnsByType); in a
 * foreign locale only translatable columns map.
 */

import type { PrismaClient } from "@prisma/client";
import { loadBulkRows } from "./load.server";
import { debugLog } from "../../utils/debug";
import {
  mapCsvHeader,
  parseCsv,
  resolveCsvRowId,
  editsFromCsvRecords,
  CSV_IMPORT_MAX_ROWS,
  type CsvRowError,
} from "./csv.shared";
import {
  computeDiff,
  estimateCalls,
  resolveCellValue,
  type BulkDiffEntry,
  type BulkRow,
  type BulkRowType,
  type ColumnDescriptor,
  type MetafieldColumnSpec,
  type ProductColumnCaps,
} from "./columns.shared";

/** How many concrete old→new changes the preview dialog lists (§8.2). */
export const CSV_IMPORT_PREVIEW_CHANGES = 50;

/** Chunk size for the load-by-ids sweep. */
const IMPORT_LOAD_CHUNK = 500;

export interface CsvImportChange {
  rowId: string;
  /** Human recognition in the dialog: the row's title (variant rows:
   * "product title — variant title"). */
  rowLabel: string;
  columnId: string;
  oldValue: string;
  newValue: string;
}

export interface CsvImportPreview {
  ok: true;
  /** Data rows that resolved to an existing row. */
  rowsMatched: number;
  /** Rows with at least one changed cell. */
  rowsChanged: number;
  /** Total changed cells (= diff length). */
  cellsChanged: number;
  /** Headers matching no column of this type — reported, never silent. */
  unknownColumns: string[];
  /** Known but not-editable-here headers (read-only columns; non-translatable
   * columns in a foreign view) — reported separately. */
  ignoredColumns: string[];
  rowErrors: CsvRowError[];
  /** First CSV_IMPORT_PREVIEW_CHANGES changes, old → new in clear text. */
  changes: CsvImportChange[];
  /** The full diff — the client submits it unchanged through the normal save
   * pipeline after confirmation. */
  diff: BulkDiffEntry[];
  /** Shopify-call estimate (Plan §10.1) so the dialog can refuse over-budget
   * imports BEFORE submitting. */
  estimatedCalls: number;
}

export type CsvImportPreviewResult =
  | CsvImportPreview
  | { ok: false; error: "empty" | "tooManyRows" | "noIdColumn" };

export interface CsvImportArgs {
  type: BulkRowType;
  /** "" = primary. */
  locale: string;
  /** "" = global; only meaningful with a foreign locale. */
  marketId: string;
  csvText: string;
  /** Column universe for `type` from buildServerColumnsByType — the plan/type
   * truth for what this merchant may edit (§8.2). */
  columns: ColumnDescriptor[];
  productCells?: { metafieldSpecs: MetafieldColumnSpec[]; caps: ProductColumnCaps };
}

/** handle → all row ids carrying it, per row type (variants have none). */
async function loadIdsByHandle(
  db: PrismaClient,
  shop: string,
  type: BulkRowType,
  handles: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (handles.length === 0 || type === "variant") return map;
  const where = { shop, handle: { in: handles } };
  const select = { id: true, handle: true } as const;
  const rows =
    type === "product"
      ? await db.product.findMany({ where, select })
      : type === "collection"
        ? await db.collection.findMany({ where, select })
        : type === "article"
          ? await db.article.findMany({ where, select })
          : await db.page.findMany({ where, select });
  for (const row of rows) {
    const list = map.get(row.handle);
    if (list) list.push(row.id);
    else map.set(row.handle, [row.id]);
  }
  return map;
}

/** Loads the referenced rows (current DB values) in chunks through the same
 * loader the grid uses — including the foreign-value attachment, so the diff
 * baseline is identical to the grid's. */
async function loadRowsByIds(
  db: PrismaClient,
  shop: string,
  args: CsvImportArgs,
  ids: string[],
): Promise<Map<string, BulkRow>> {
  const byId = new Map<string, BulkRow>();
  for (let i = 0; i < ids.length; i += IMPORT_LOAD_CHUNK) {
    const chunk = ids.slice(i, i + IMPORT_LOAD_CHUNK);
    const page = await loadBulkRows(db, shop, {
      type: args.type,
      locale: args.locale,
      marketId: args.marketId,
      search: "",
      filters: [],
      sort: null,
      skip: 0,
      take: chunk.length,
      ids: chunk,
      productCells: args.productCells,
    });
    for (const row of page.rows) byId.set(row.id, row);
  }
  return byId;
}

function rowLabel(row: BulkRow): string {
  if (row.type === "variant") {
    return row.productTitle ? `${row.productTitle} — ${row.title}` : row.title;
  }
  return row.title || row.handle || row.id;
}

export async function buildCsvImportPreview(
  db: PrismaClient,
  shop: string,
  args: CsvImportArgs,
): Promise<CsvImportPreviewResult> {
  const records = parseCsv(args.csvText);
  if (records.length < 2) return { ok: false, error: "empty" };
  const [header, ...dataRows] = records;
  if (dataRows.length > CSV_IMPORT_MAX_ROWS) return { ok: false, error: "tooManyRows" };

  const foreign = args.locale !== "";
  const marketId = foreign ? args.marketId : "";
  const mapping = mapCsvHeader(header, args.columns, { foreign });

  // Handle fallback uses the handle COLUMN of the file (the second export
  // column). In a foreign view that column carries the translated handle, but
  // resolution always runs against the PRIMARY handle — which is what the
  // id-less case means in practice (a hand-built file).
  const handleIndex = mapping.columns.find((m) => m.column.id === "field.handle")?.index ?? -1;
  if (mapping.idIndex === -1 && (args.type === "variant" || handleIndex === -1)) {
    return { ok: false, error: "noIdColumn" };
  }

  // Candidate ids: everything the id column names, plus the ids behind the
  // handles of id-less rows.
  const refs = dataRows.map((cells, i) => ({
    cells,
    line: i + 2, // header is line 1
    id: mapping.idIndex >= 0 ? (cells[mapping.idIndex] ?? "").trim() : "",
    handle: handleIndex >= 0 ? (cells[handleIndex] ?? "").trim() : "",
  }));
  const handlesToResolve = [...new Set(refs.filter((r) => r.id === "" && r.handle !== "").map((r) => r.handle))];
  const idsByHandle = await loadIdsByHandle(db, shop, args.type, handlesToResolve);
  const candidateIds = new Set<string>();
  for (const ref of refs) {
    if (ref.id !== "") candidateIds.add(ref.id);
    else for (const id of idsByHandle.get(ref.handle) ?? []) candidateIds.add(id);
  }

  const rowsById = await loadRowsByIds(db, shop, args, [...candidateIds]);
  const knownIds = new Set(rowsById.keys());

  const rowErrors: CsvRowError[] = [];
  const resolved: { rowId: string; cells: string[] }[] = [];
  for (const ref of refs) {
    // A fully empty record (Excel loves appending those) is skipped silently.
    if (ref.cells.every((c) => c.trim() === "")) continue;
    const result = resolveCsvRowId(ref, knownIds, idsByHandle);
    if (!result.ok) {
      rowErrors.push(result.error);
      continue;
    }
    resolved.push({ rowId: result.rowId, cells: ref.cells });
  }

  // §8.2 step 3: build the exact edit map typing would produce, run the SAME
  // computeDiff. Editability/translatability/known-column rules all live in
  // that one shared pipeline.
  const edits = editsFromCsvRecords(resolved, mapping, args.locale, marketId);
  const rows = [...rowsById.values()];
  const diff = computeDiff(rows, args.columns, edits);

  const variantProductIdByRowId: Record<string, string> = {};
  if (args.type === "variant") {
    for (const row of rows) if (row.productId) variantProductIdByRowId[row.id] = row.productId;
  }
  const estimatedCalls = estimateCalls(
    diff,
    args.columns,
    args.type === "variant" ? { variantProductIdByRowId } : undefined,
  );

  const columnById = new Map(args.columns.map((c) => [c.id, c] as const));
  const changes: CsvImportChange[] = diff.slice(0, CSV_IMPORT_PREVIEW_CHANGES).map((entry) => {
    const row = rowsById.get(entry.rowId);
    const column = columnById.get(entry.columnId);
    const oldValue =
      row && column
        ? entry.locale === "" && entry.marketId === ""
          ? resolveCellValue(row, column).value
          : row.foreignValues?.[`${entry.locale}|${entry.marketId}|${entry.columnId}`] ?? ""
        : "";
    return {
      rowId: entry.rowId,
      rowLabel: row ? rowLabel(row) : entry.rowId,
      columnId: entry.columnId,
      oldValue,
      newValue: entry.value,
    };
  });

  // §10.5: summaries only — never cell values.
  debugLog.bulkDiff("csv import preview", {
    type: args.type,
    dataRows: dataRows.length,
    matched: resolved.length,
    cells: diff.length,
    rowErrors: rowErrors.length,
    unknownColumns: mapping.unknown.length,
  });

  return {
    ok: true,
    rowsMatched: new Set(resolved.map((r) => r.rowId)).size,
    rowsChanged: new Set(diff.map((d) => d.rowId)).size,
    cellsChanged: diff.length,
    unknownColumns: mapping.unknown,
    ignoredColumns: mapping.ignored,
    rowErrors,
    changes,
    diff,
    estimatedCalls,
  };
}
