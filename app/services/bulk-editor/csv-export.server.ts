/**
 * Bulk editor — CSV export, server half (docs/plans/PLAN_BULK_EDITOR.md §8.1).
 *
 * Exports THE CURRENT VIEW: type, language, market, search/filters/sort and
 * the merchant's visible column selection — but over ALL matches of the
 * filter, not just the visible page, collected server-side through
 * loadBulkRows pagination. Beyond CSV_EXPORT_MAX_ROWS the export is refused
 * with the total, and the UI tells the merchant to narrow the filter (see the
 * documented §8.1 deviation in csv.shared.ts — the Task infrastructure has no
 * result-file delivery).
 *
 * Column layout (§8.1): `id` (GID) first, the handle column second for
 * re-import recognition. Variant rows have no handle — they lead with the
 * read-only product/variant titles plus the SKU column instead, and re-import
 * resolves them by id only. Headers are ColumnDescriptor.ids (see
 * csv.shared.ts head comment).
 */

import type { PrismaClient } from "@prisma/client";
import { loadBulkRows, type BulkAdminClient } from "./load.server";
import { buildCsv, CSV_EXPORT_MAX_ROWS, CSV_ID_HEADER, type CsvDelimiter } from "./csv.shared";
import {
  resolveCellValue,
  type BulkFilterId,
  type BulkRow,
  type BulkRowType,
  type BulkSort,
  type ColumnDescriptor,
  type MetafieldColumnSpec,
  type ProductColumnCaps,
} from "./columns.shared";

/** Page size for the server-side collection sweep. */
const EXPORT_PAGE_SIZE = 250;

/** Recognition lead columns per row type (§8.1 decision): variants lead with
 * product/variant title + SKU (no handle — re-import resolves by id only);
 * policies with their read-only title (no handle at all); metaobjects with
 * display name + handle (re-import still resolves by id only — metaobject
 * handles are only unique per type). Everything else leads with the handle
 * column. */
const VARIANT_LEAD_COLUMN_IDS = ["productTitle", "variantTitle", "var.sku"];
const LEAD_COLUMN_IDS_BY_TYPE: Partial<Record<BulkRowType, string[]>> = {
  variant: VARIANT_LEAD_COLUMN_IDS,
  policy: ["policyTitle"],
  metaobject: ["moDisplayName", "moHandle"],
};

export interface BulkCsvExportOptions {
  type: BulkRowType;
  locale: string;
  marketId: string;
  search: string;
  filters: BulkFilterId[];
  sort: BulkSort | null;
  /** The merchant's visible column ids — unknown ids are dropped against the
   * server-built universe, never trusted. */
  visibleColumnIds: string[];
  /** Server-built column universe for `type` (buildColumnsForType with the
   * shop's metafield specs + plan caps). */
  columns: ColumnDescriptor[];
  delimiter: CsvDelimiter;
  productCells?: { metafieldSpecs: MetafieldColumnSpec[]; caps: ProductColumnCaps };
  /** Blog rows are live-fetched (Phase 5) — required for type "blog". */
  admin?: BulkAdminClient;
  /** Metaobject rows: the toolbar's definition-type filter — the export
   * mirrors the current view (§8.1), so it exports the selected type only. */
  moType?: string;
}

export type BulkCsvExportResult =
  | { ok: true; csv: string; rowCount: number }
  | { ok: false; error: "tooLarge"; total: number };

/** The cell text that lands in the CSV: in a foreign view, translatable
 * columns export the loaded translation of the selected locale+market layer
 * ("" when untranslated — the ghost is display-only, never data); everything
 * else exports the resolved primary value. Money cells stay in the
 * normalized dot form (see csv.shared.ts). */
function exportCellValue(row: BulkRow, column: ColumnDescriptor, locale: string, marketId: string): string {
  if (locale !== "" && column.translatable) {
    return row.foreignValues?.[`${locale}|${marketId}|${column.id}`] ?? "";
  }
  return resolveCellValue(row, column).value;
}

/** The export column list: recognition lead columns first, then the visible
 * selection (image column excluded — it has no text value; duplicates of the
 * lead columns deduped). */
export function buildExportColumns(
  type: BulkRowType,
  visibleColumnIds: string[],
  columns: ColumnDescriptor[],
): ColumnDescriptor[] {
  const byId = new Map(columns.map((c) => [c.id, c] as const));
  const leadIds = LEAD_COLUMN_IDS_BY_TYPE[type] ?? ["field.handle"];
  const lead = leadIds
    .map((id) => byId.get(id))
    .filter((c): c is ColumnDescriptor => !!c);
  const seen = new Set(lead.map((c) => c.id));
  const visible: ColumnDescriptor[] = [];
  for (const id of visibleColumnIds) {
    const column = byId.get(id);
    if (!column || column.id === "image" || seen.has(column.id)) continue;
    seen.add(column.id);
    visible.push(column);
  }
  return [...lead, ...visible];
}

export async function buildBulkCsvExport(
  db: PrismaClient,
  shop: string,
  opts: BulkCsvExportOptions,
): Promise<BulkCsvExportResult> {
  const exportColumns = buildExportColumns(opts.type, opts.visibleColumnIds, opts.columns);

  // Sweep ALL matches of the filter through the same loader the grid uses —
  // same where/sort/foreign-value attachment, so the file mirrors the view.
  const rows: BulkRow[] = [];
  for (let skip = 0; ; skip += EXPORT_PAGE_SIZE) {
    const page = await loadBulkRows(db, shop, {
      type: opts.type,
      locale: opts.locale,
      marketId: opts.marketId,
      search: opts.search,
      filters: opts.filters,
      sort: opts.sort,
      skip,
      take: EXPORT_PAGE_SIZE,
      productCells: opts.productCells,
      admin: opts.admin,
      moType: opts.moType,
    });
    if (page.total > CSV_EXPORT_MAX_ROWS) {
      return { ok: false, error: "tooLarge", total: page.total };
    }
    rows.push(...page.rows);
    if (page.rows.length < EXPORT_PAGE_SIZE || rows.length >= page.total) break;
  }

  const header = [CSV_ID_HEADER, ...exportColumns.map((c) => c.id)];
  const body = rows.map((row) => [
    row.id,
    ...exportColumns.map((column) => exportCellValue(row, column, opts.locale, opts.marketId)),
  ]);
  return { ok: true, csv: buildCsv(header, body, opts.delimiter), rowCount: rows.length };
}
