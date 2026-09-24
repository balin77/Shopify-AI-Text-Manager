/**
 * Bulk editor — the LARGE CSV import: one background Task that applies an
 * import of any size the file caps allow, in batches.
 *
 * Before this, a confirmed import went through the grid's own save pipeline,
 * which caps one save at MAX_BULK_TASK_ITEMS cells and MAX_TASK_CALLS
 * estimated Shopify calls — sane for a grid, where a merchant types, but a
 * dead end for a file: exporting 800 products, changing one column and
 * importing it back was refused with "save in several steps", and a file has
 * no steps. The merchant had to split the spreadsheet by hand.
 *
 * Four rules.
 *
 * - **The diff is recomputed HERE, from the file.** The client posts the CSV
 *   text again (bounded by CSV_IMPORT_MAX_BYTES) rather than a diff: a diff of
 *   a 10 000-row file is larger than the file itself, and a client-posted diff
 *   is a claim, while `buildCsvImportPreview` is the same function the
 *   preview ran — header mapping, row resolution, scope marker, encoding and
 *   spreadsheet-damage guards included. What changed in the shop between the
 *   preview and the confirm is simply not in the diff any more.
 * - **Batches are applyBulkDiff calls**, each within the SAME two caps a grid
 *   save has, so nothing inside the write path runs at a scale it was never
 *   built for (the auto-translation's MAX_REPAIR_GROUPS, the digest batching,
 *   the per-row progress). A ROW never spans two batches: its cells travel as
 *   one group (the weight's two halves, an atomic productUpdate), exactly as a
 *   grid save would send them.
 * - **It is a `seoBulkMeta` Task**, the grid's large-save type: the Tasks tab
 *   renders its result, the reaper knows it as long-running (and every row
 *   bumps `updatedAt`, so a two-hour import is never reaped as stuck), the
 *   grid's task watch follows the auto-translation runs it starts, and the
 *   per-shop single-flight keeps two bulk writes from racing.
 * - **Re-running is resuming.** A redeploy kills a detached run mid-way; the
 *   rows written so far are written. Importing the SAME file again diffs
 *   against the shop as it is now, so those rows come out unchanged and only
 *   the remainder is sent — no checkpoint table needed, and nothing is written
 *   twice.
 */

import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { applyBulkDiff } from "./apply.server";
import { MAX_REPAIR_GROUPS } from "./retranslate.server";
import { buildCsvImportPreview, type CsvImportArgs, type CsvImportPreviewResult } from "./csv-import.server";
import { findInvalidLocaleOrMarket } from "./translations.server";
import {
  estimateCalls,
  isValidBulkDiffEntry,
  MAX_BULK_TASK_ITEMS,
  MAX_TASK_CALLS,
  type BulkApplyResult,
  type BulkDiffEntry,
  type BulkRowType,
  type ColumnDescriptor,
} from "./columns.shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";

/** One save group's identity — the unit a batch never splits. */
function rowKey(e: BulkDiffEntry): string {
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
  } = {},
): BulkDiffEntry[][] {
  const maxCells = opts.maxCells ?? MAX_BULK_TASK_ITEMS;
  const maxCalls = opts.maxCalls ?? MAX_TASK_CALLS;
  const estimateOpts = opts.variantProductIdByRowId
    ? { variantProductIdByRowId: opts.variantProductIdByRowId }
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

/** Sums the per-batch results into the ONE result shape a `seoBulkMeta` Task
 * stores, so the Tasks tab and the grid's `follow` extraction read an import
 * exactly like any other large save. */
export function mergeApplyResults(results: BulkApplyResult[]): BulkApplyResult {
  const merged: BulkApplyResult = { saved: 0, failures: [] };
  for (const r of results) {
    merged.saved += r.saved;
    merged.failures.push(...r.failures);
    if (r.retranslation) {
      const into = (merged.retranslation ??= {
        started: 0,
        translations: 0,
        skipped: 0,
        capped: 0,
      });
      into.started += r.retranslation.started;
      into.translations += r.retranslation.translations;
      into.skipped += r.retranslation.skipped;
      into.capped += r.retranslation.capped;
      if (r.retranslation.taskIds?.length) {
        into.taskIds = [...(into.taskIds ?? []), ...r.retranslation.taskIds];
      }
    }
  }
  return merged;
}

export type CsvImportApplyResult =
  | { ok: true; taskId: string; cells: number; rows: number; batches: number }
  | { ok: false; error: "alreadyRunning"; taskId: string }
  | { ok: false; error: "noChanges" }
  | { ok: false; error: "invalidLocale"; message: string }
  | Extract<CsvImportPreviewResult, { ok: false }>;

export interface CsvImportApplyArgs extends CsvImportArgs {
  admin: AdminApiContext;
  /** Server-built universe of EVERY type (buildServerColumnsByType) — the
   * write path resolves columns through it, and the diff is validated against
   * it like every other entrance's. */
  columnsByType: Record<BulkRowType, ColumnDescriptor[]>;
  /** Row types this shop's plan may write. */
  allowedTypes: BulkRowType[];
}

/**
 * Validates, recomputes and STARTS the import. Returns once the Task row
 * exists; the batches run detached (the same fire-and-forget shape as every
 * other long task — the request that confirmed the import is long gone by the
 * time a large one finishes).
 */
export async function startCsvImportTask(
  db: PrismaClient,
  shop: string,
  args: CsvImportApplyArgs,
): Promise<CsvImportApplyResult> {
  const preview = await buildCsvImportPreview(db, shop, args);
  if (!preview.ok) return preview;
  if (preview.diff.length === 0) return { ok: false, error: "noChanges" };

  // Defensive, as at every entrance of applyBulkDiff: the diff came out of
  // computeDiff against the server universe, so a failing entry here is a bug
  // — refuse the whole import rather than write part of a file we misread.
  const diff = preview.diff;
  if (!diff.every((e) => isValidBulkDiffEntry(e, args.allowedTypes, args.columnsByType))) {
    throw new Error("CSV import produced a diff entry the column universe rejects");
  }
  // Foreign locales must be PUBLISHED and markets ACTIVE — the same gate the
  // other entrances run before anything reaches translationsRegister.
  const localeError = await findInvalidLocaleOrMarket(args.admin, shop, diff);
  if (localeError) return { ok: false, error: "invalidLocale", message: localeError };

  const runningTask = await db.task.findFirst({
    where: { shop, type: "seoBulkMeta", status: "running" },
    select: { id: true },
  });
  if (runningTask) return { ok: false, error: "alreadyRunning", taskId: runningTask.id };

  const columns = args.columnsByType[args.type] ?? [];
  const batches = chunkImportDiff(diff, columns, {
    variantProductIdByRowId: preview.variantProductIdByRowId,
  });
  const rowTotal = new Set(diff.map(rowKey)).size;

  const task = await db.task.create({
    data: {
      shop,
      type: "seoBulkMeta",
      status: "running",
      resourceType: "seo",
      fieldType: "all",
      total: rowTotal,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  void runCsvImport(task.id, { db, shop, admin: args.admin, columnsByType: args.columnsByType, batches, rowTotal }).catch(
    (err: unknown) => {
      logger.error("[BulkCsvImport] Import run crashed", {
        context: "BulkEditor",
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );

  return { ok: true, taskId: task.id, cells: diff.length, rows: rowTotal, batches: batches.length };
}

interface RunArgs {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
  columnsByType: Record<BulkRowType, ColumnDescriptor[]>;
  batches: BulkDiffEntry[][];
  rowTotal: number;
}

/** Exported for tests; production reaches it only through startCsvImportTask. */
export async function runCsvImport(taskId: string, args: RunArgs): Promise<void> {
  const { db, shop, admin, columnsByType, batches, rowTotal } = args;
  const results: BulkApplyResult[] = [];
  const persistProgress = async (processed: number) => {
    await db.task
      .update({
        where: { id: taskId },
        data: { processed, progress: Math.min(99, Math.round((processed / Math.max(1, rowTotal)) * 100)) },
      })
      .catch((err: unknown) => {
        logger.error("[BulkCsvImport] Failed to persist progress", {
          context: "BulkEditor",
          taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  try {
    // Same lookup the seoBulkMeta runner makes: the target set of the
    // primary-save invalidation, and the source language of the
    // auto-translation's value prompts. Once per import, not per batch.
    const { getCachedShopLocales } = await import("~/utils/shop-locales-cache.server");
    const shopLocales = await getCachedShopLocales(admin, shop).catch(() => []);
    const foreignLocales = shopLocales.filter((l) => l.published && !l.primary).map((l) => l.locale);
    const primaryLocale = shopLocales.find((l) => l.primary)?.locale;

    // ONE auto-translation budget for the whole file, not one per batch: every
    // group is an unattended AI run on the merchant's own key, and the per-save
    // cap exists to bound exactly that. What the budget refuses falls back to
    // the stored deletion answer and is reported as `capped`, as in any save.
    let repairBudget = MAX_REPAIR_GROUPS;
    let rowsBefore = 0;
    for (const batch of batches) {
      const result = await applyBulkDiff(
        { db, shop, admin, columnsByType, foreignLocales, primaryLocale, repairGroupBudget: repairBudget },
        batch,
        async (processed) => persistProgress(rowsBefore + processed),
      );
      results.push(result);
      repairBudget = Math.max(0, repairBudget - (result.retranslation?.started ?? 0));
      rowsBefore += new Set(batch.map(rowKey)).size;
      await persistProgress(rowsBefore);
    }

    const merged = mergeApplyResults(results);
    const failedRowCount = new Set(merged.failures.map((f) => f.rowId)).size;
    await db.task.update({
      where: { id: taskId },
      data: {
        status: merged.saved === 0 && failedRowCount > 0 ? "failed" : "completed",
        progress: 100,
        processed: rowTotal,
        completedAt: new Date(),
        result: JSON.stringify({ ...merged, batches: batches.length }),
        // The machine code the seoBulkMeta runner writes, rendered by
        // taskErrorText in the merchant's language.
        error: failedRowCount > 0 ? `rows_failed:${failedRowCount}:${merged.saved + failedRowCount}` : null,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[BulkCsvImport] Import run failed", { context: "BulkEditor", taskId, error: message });
    // What the finished batches wrote is written — keep their result, so the
    // Tasks tab does not report a half-applied import as "nothing happened".
    const merged = mergeApplyResults(results);
    await db.task
      .update({
        where: { id: taskId },
        data: {
          status: "failed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ ...merged, batches: batches.length, batchesDone: results.length }),
          error: message.substring(0, 1000),
        },
      })
      .catch((updateErr: unknown) => {
        logger.error("[BulkCsvImport] Failed to persist failure state", {
          context: "BulkEditor",
          taskId,
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      });
  }
}
