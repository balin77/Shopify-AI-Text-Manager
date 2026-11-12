/**
 * An ABSOLUTE END for open batch runs (PLAN_BULK_TRANSLATE_BATCHING 19.4,
 * review item M4).
 *
 * A provider batch expires 24 hours after it was created, and collecting its
 * results takes minutes. A run that is still open after the limit below is not
 * "waiting" any more: the poller is down, disabled, or has been failing for
 * days. Left alone the Task would sit in the Tasks tab as "waiting for the
 * provider" for ever (the cleanups exclude open batch tasks by design) and its
 * reservation would hold part of the shop's budget and of the global pool.
 *
 * So the end is enforced here, in one place both the poller tick and the
 * scheduler's daily cleanup call -- the cleanup call is what keeps the end
 * enforced when the poller is switched off. A row whose lease is still valid is
 * left alone: a poller that is mid-collection is working, and ending the run
 * under it would race its writes. The lease expires within minutes, so such a
 * row is picked up on the next pass.
 *
 * Never throws; every step is logged and counted.
 */

import { OPEN_BATCH_TASK_STATUSES, TASK_STATUS_BATCH_UNREACHABLE } from "~/config/task-statuses.js";
import { logger } from "~/utils/logger.server";

/** Provider batches expire at 24 h + collection time; 48 h leaves a day for a poller that was down. */
export const OPEN_BATCH_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Batch-row states that mean "still open". */
const OPEN_ROW_STATES = ["submitting", "waiting", "cancel_requested", "collecting"] as const;

/** The machine code the Tasks tab renders (taskErrorText). */
export const BATCH_UNREACHABLE_ERROR = "batch_unreachable";

export interface ExpireStaleBatchesResult {
  expired: number;
  failed: number;
}

export async function expireStaleBatches(
  now: Date = new Date(),
  limit = 50,
): Promise<ExpireStaleBatchesResult> {
  const result: ExpireStaleBatchesResult = { expired: 0, failed: 0 };
  try {
    const { db } = await import("~/db.server");
    const { releaseBudget } = await import("../ai/usage-meter.server");
    const leaseFree = [{ leaseUntil: null }, { leaseUntil: { lt: now } }];
    const rows = await db.bulkTranslateBatch.findMany({
      where: {
        state: { in: [...OPEN_ROW_STATES] },
        createdAt: { lt: new Date(now.getTime() - OPEN_BATCH_MAX_AGE_MS) },
        OR: leaseFree,
      },
      select: { id: true, taskId: true },
      take: limit,
    });
    for (const row of rows) {
      try {
        const closed = await db.$transaction(async (tx) => {
          // Conditional on the SAME predicate as the select: a poller that took
          // the lease between the two keeps its row.
          const flipped = await tx.bulkTranslateBatch.updateMany({
            where: { id: row.id, state: { in: [...OPEN_ROW_STATES] }, OR: leaseFree },
            data: { state: "done", lastError: BATCH_UNREACHABLE_ERROR },
          });
          if (flipped.count !== 1) return false;
          await tx.task.updateMany({
            where: { id: row.taskId, status: { in: [...OPEN_BATCH_TASK_STATUSES] } },
            data: {
              status: TASK_STATUS_BATCH_UNREACHABLE,
              error: BATCH_UNREACHABLE_ERROR,
              completedAt: now,
            },
          });
          return true;
        });
        if (!closed) continue;
        result.expired += 1;
        // The provider batch is past its own expiry: nothing will be billed for
        // requests that never ran, so the hold goes back (both counters).
        await releaseBudget(row.id);
        logger.warn("[BatchExpiry] Open batch run passed its absolute end and was closed", {
          context: "AI",
          batchRowId: row.id,
          taskId: row.taskId,
        });
      } catch (error) {
        result.failed += 1;
        logger.warn(
          `[BatchExpiry] Could not close batch ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    result.failed += 1;
    logger.warn(
      `[BatchExpiry] Lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}
