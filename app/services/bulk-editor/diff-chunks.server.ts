/**
 * Splitting a bulk diff into blocks that each fit ONE applyBulkDiff call.
 *
 * Shared by the large CSV import and the "add missing translations" run: both
 * hand a diff of any size to the ONE write path in pieces that stay inside the
 * two caps a grid save has, so nothing in applyBulkDiff runs at a scale it was
 * never built for. Moved out of csv-import-run.server.ts so there is not a
 * second copy.
 */

import {
  estimateCalls,
  MAX_BULK_TASK_ITEMS,
  MAX_TASK_CALLS,
  type BulkDiffEntry,
  type ColumnDescriptor,
} from "./columns.shared";

/** One save group's identity — the unit a batch never splits. */
export function rowKey(e: BulkDiffEntry): string {
  return `${e.rowType}|${e.rowId}|${e.locale}|${e.marketId}`;
}

/**
 * Splits an import diff into batches that each fit a single grid save
 * (≤ maxCells cells, ≤ maxCalls estimated Shopify calls), keeping every row's
 * cells together and the file's order intact. A row that alone exceeds a cap
 * (it cannot — a row has fewer cells than a type has columns) still gets a
 * batch of its own rather than being dropped.
 */
export function chunkImportDiff(
  diff: BulkDiffEntry[],
  columns: ColumnDescriptor[],
  opts: {
    maxCells?: number;
    maxCalls?: number;
    variantProductIdByRowId?: Record<string, string>;
    /** The blocks go through applyBulkDiff's `fillOnly` mode, whose live
     * emptiness read is part of each block's estimated cost. */
    fillOnly?: boolean;
  } = {},
): BulkDiffEntry[][] {
  const maxCells = opts.maxCells ?? MAX_BULK_TASK_ITEMS;
  const maxCalls = opts.maxCalls ?? MAX_TASK_CALLS;
  const estimateOpts =
    opts.variantProductIdByRowId || opts.fillOnly
      ? {
          ...(opts.variantProductIdByRowId ? { variantProductIdByRowId: opts.variantProductIdByRowId } : {}),
          ...(opts.fillOnly ? { fillOnly: true } : {}),
        }
      : undefined;

  const rows = new Map<string, BulkDiffEntry[]>();
  for (const entry of diff) {
    const key = rowKey(entry);
    const list = rows.get(key);
    if (list) list.push(entry);
    else rows.set(key, [entry]);
  }

  const batches: BulkDiffEntry[][] = [];
  let current: BulkDiffEntry[] = [];
  for (const cells of rows.values()) {
    const candidate = [...current, ...cells];
    const fits =
      candidate.length <= maxCells && estimateCalls(candidate, columns, estimateOpts) <= maxCalls;
    if (fits || current.length === 0) {
      current = candidate;
    } else {
      batches.push(current);
      current = [...cells];
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

