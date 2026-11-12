/**
 * "Add missing translations" — the PLAN-TIME read of the primary text
 * (PLAN_BULK_TRANSLATE_BATCHING §19.1).
 *
 * The scan that found the candidates read the CACHE, which lags the Shopify
 * admin (and any other app) until the next webhook or sync. Translating a
 * cached text that Shopify no longer holds, and then registering it against
 * the digest read at write time, would store a translation of the OLD text as
 * if it were fresh. So before any AI work the run asks Shopify what the
 * primary text is NOW (`translatableContent { key value digest }`, the same
 * aliased/chunked read the write path's digest prefetch uses), and:
 *
 * - drops a cell whose live text differs from the cached source the page
 *   showed (`skippedChanged`, counted in units, never a failure): translating
 *   a text the merchant never saw would be acting on something they did not
 *   choose, and the cache heals on the next sync, after which the next run
 *   takes the cell;
 * - records the digest of every target resource as the cell's `expected` map,
 *   which applyBulkDiff's fill-only mode compares with the digest it reads at
 *   write time (text moved between plan and write => not written);
 * - fails a cell whose resource Shopify did not answer for (unknown is not
 *   "unchanged"), before the AI is paid for it.
 *
 * Which Shopify resource carries a cell's text is the write path's own
 * mapping (row field: the row; metafield / option / option value: the
 * sub-resource GIDs; featured-image alt: the image GID), so the plan reads
 * exactly what the write will address.
 */

import type { PrismaClient } from "@prisma/client";
import {
  LIST_DISPLAY_SEPARATOR,
  isFeaturedImageAltColumn,
  type BulkRowType,
  type ColumnDescriptor,
} from "./columns.shared";
import {
  isSubResourceColumn,
  loadProductSubResourceCaches,
  subResourceTargetsForColumn,
} from "./translations.server";
import { candidateTranslationKey } from "./missing-translations.server";
import { resolveFeaturedImageId } from "./apply.server";
import { loadTranslatableState, type GraphqlClient } from "../translations/verified-translations.server";
import { logger } from "../../utils/logger.server";

/** The part of a run's job the plan needs (structurally a TranslateJob). */
export interface PlanJob {
  rowId: string;
  cells: {
    column: ColumnDescriptor;
    source: string;
    locales: string[];
  }[];
}

export interface PlanFailure {
  rowId: string;
  columnId: string;
  message: string;
  /** Units (one per language) the failure covers. */
  units: number;
}

export interface PlanReadResult<J extends PlanJob> {
  /** The jobs with the dropped cells removed (a job with no cell left is gone). */
  jobs: J[];
  /** `${rowId}|${columnId}` -> targetResourceId -> digest read now. */
  expected: Map<string, Record<string, string>>;
  /** Units dropped because the live text differs from the cached source. */
  skippedChanged: number;
  /** Cells whose live text could not be read at all. */
  failures: PlanFailure[];
}

/** Line endings and surrounding whitespace are representation, not content. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export const planCellKey = (rowId: string, columnId: string): string => `${rowId}|${columnId}`;

interface Target {
  resourceId: string;
  key: string;
  /** The part of the cell's source this target carries (positional for an
   *  option-values cell, the whole source otherwise). */
  expectedText: string;
}

const UNREADABLE = "Shopify could not be read to confirm the current text — this translation was not attempted.";

export async function planTranslateRead<J extends PlanJob>(
  deps: {
    db: PrismaClient;
    shop: string;
    gateway: GraphqlClient;
    rowType: BulkRowType;
  },
  jobs: J[],
): Promise<PlanReadResult<J>> {
  const { db, shop, gateway, rowType } = deps;
  const result: PlanReadResult<J> = { jobs: [], expected: new Map(), skippedChanged: 0, failures: [] };

  // ── 1. Which resource + key carries each cell's text ─────────────────────
  const subCells = jobs.flatMap((job) => job.cells.filter((c) => isSubResourceColumn(c.column)).map(() => job.rowId));
  const subCaches =
    subCells.length > 0
      ? await loadProductSubResourceCaches(
          db,
          shop,
          [...new Set(subCells)],
          jobs
            .flatMap((job) => job.cells.map((c) => c.column))
            .filter((c) => c.kind === "metafield" && c.metafieldNamespace && c.metafieldKey)
            .map((c) => ({ namespace: c.metafieldNamespace as string, key: c.metafieldKey as string })),
          jobs.some((job) => job.cells.some((c) => c.column.kind === "option")),
        )
      : new Map();

  /** `rowId|columnId` -> its targets; `null` = could not be resolved. */
  const targetsByCell = new Map<string, Target[] | null>();
  for (const job of jobs) {
    for (const cell of job.cells) {
      const cellKey = planCellKey(job.rowId, cell.column.id);
      if (isFeaturedImageAltColumn(cell.column)) {
        try {
          const imageId = await resolveFeaturedImageId(gateway, rowType, job.rowId);
          targetsByCell.set(cellKey, imageId ? [{ resourceId: imageId, key: "alt", expectedText: cell.source }] : null);
        } catch {
          targetsByCell.set(cellKey, null);
        }
        continue;
      }
      if (isSubResourceColumn(cell.column)) {
        const cache = subCaches.get(job.rowId);
        const subTargets = cache ? subResourceTargetsForColumn(cell.column, cache) : null;
        if (!subTargets || subTargets.length === 0) {
          // Not addressable here — the write path words that failure itself.
          targetsByCell.set(cellKey, []);
          continue;
        }
        const isList = cell.column.kind === "option" && cell.column.optionField === "values";
        const parts = isList ? cell.source.split(LIST_DISPLAY_SEPARATOR.trim()).map((v) => v.trim()) : [cell.source];
        targetsByCell.set(
          cellKey,
          subTargets.map((t, i) => ({ resourceId: t.resourceId, key: t.key, expectedText: parts[i] ?? "" })),
        );
        continue;
      }
      const key = candidateTranslationKey(cell.column, rowType);
      targetsByCell.set(cellKey, key ? [{ resourceId: job.rowId, key, expectedText: cell.source }] : []);
    }
  }

  // ── 2. ONE batched read of every target ──────────────────────────────────
  const resourceIds = new Set<string>();
  const keys = new Set<string>();
  for (const targets of targetsByCell.values()) {
    for (const t of targets ?? []) {
      resourceIds.add(t.resourceId);
      keys.add(t.key);
    }
  }
  let state: Awaited<ReturnType<typeof loadTranslatableState>> | null = null;
  if (resourceIds.size > 0) {
    try {
      state = await loadTranslatableState(gateway, [...resourceIds], [...keys], { withValues: true });
    } catch (err: unknown) {
      logger.warn("[BulkTranslate] Plan-time read failed", {
        context: "AI",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 3. Judge every cell ──────────────────────────────────────────────────
  for (const job of jobs) {
    const kept: J["cells"] = [];
    for (const cell of job.cells) {
      const cellKey = planCellKey(job.rowId, cell.column.id);
      const targets = targetsByCell.get(cellKey);
      const units = cell.locales.length;
      // Nothing resolvable: the write path words the problem (a metafield not
      // in the cache, a linked option, a collection without a featured image),
      // exactly as before — the plan does not add a second wording.
      if (targets === undefined || (targets && targets.length === 0)) {
        kept.push(cell);
        continue;
      }
      if (targets === null) {
        result.failures.push({
          rowId: job.rowId,
          columnId: cell.column.id,
          message: "This collection/article has no featured image on Shopify — there is nothing to translate.",
          units,
        });
        continue;
      }
      // A resource the read did not answer for is UNKNOWN, never "unchanged".
      if (!state || targets.some((t) => !state!.answered.has(t.resourceId))) {
        result.failures.push({ rowId: job.rowId, columnId: cell.column.id, message: UNREADABLE, units });
        continue;
      }
      let changed = false;
      const expected: Record<string, string> = {};
      for (const target of targets) {
        const live = state.values.get(target.resourceId)?.get(target.key);
        const digest = state.digests.get(target.resourceId)?.get(target.key);
        // A key Shopify does not list: no comparison is possible and no digest
        // to expect — the write path's own digest rule answers it.
        if (live === undefined) continue;
        if (normalize(live) !== normalize(target.expectedText)) {
          changed = true;
          break;
        }
        if (digest) expected[target.resourceId] = digest;
      }
      if (changed) {
        result.skippedChanged += units;
        continue;
      }
      if (Object.keys(expected).length > 0) result.expected.set(cellKey, expected);
      kept.push(cell);
    }
    if (kept.length > 0) result.jobs.push({ ...job, cells: kept });
  }
  return result;
}
