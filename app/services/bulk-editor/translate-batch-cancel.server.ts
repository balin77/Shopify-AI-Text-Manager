/**
 * Cancel every open provider batch of one shop -- the seam GDPR redaction and
 * the app-uninstall cleanup call BEFORE they delete the shop's Task / AISettings
 * rows (PLAN_BULK_TRANSLATE_BATCHING 6.7).
 *
 * Why it exists: a provider batch outlives the request, the process and -- if
 * nothing cancels it -- the shop. Once the rows that name it are deleted there
 * is no handle left to cancel it with, and it keeps running (and billing) for up
 * to 24 hours on a merchant who asked for their data to be erased. So the order
 * is fixed: mark, cancel at the provider, settle the hold, and only then does
 * the caller delete.
 *
 * Best effort by design, and NEVER blocking: a redaction must complete even when
 * the provider is down or the credential is gone, so every step is its own
 * try/catch, failures are logged (shop, task, what failed -- never a key) and
 * counted, and the function never throws. Every provider call has its own
 * deadline and the whole function an overall one, so a provider that hangs
 * cannot hold the erasure. What cannot be cancelled here is a stated residual
 * (the provider lets the batch expire).
 *
 * The hold of a batch whose cancel was NOT confirmed is converted into the
 * charge (the reserved upper bound), not released: that batch may still run and
 * bill, and releasing the hold would let the shop's budget forget it.
 *
 * The provider calls go through the settlement transport
 * (settlementCredentialsFor, which re-loads the row by id): the one place the
 * operator key may be used for settling, restricted to cancel / deleteFile here.
 */

import {
  OPEN_BATCH_TASK_STATUSES,
  TASK_STATUS_CANCEL_REQUESTED,
} from "~/config/task-statuses.js";
import { stringList } from "../ai/batch-settlement.shared";
import { logger } from "~/utils/logger.server";

/** Batch-row states in which a provider batch may exist or be needed. */
export const OPEN_BATCH_STATES = ["submitting", "waiting", "cancel_requested", "collecting"] as const;

/** One provider call may take this long before it counts as unreachable. */
export const PROVIDER_CALL_DEADLINE_MS = 15_000;
/** All provider calls of one shop together: a redaction must not hang on a slow provider. */
export const OVERALL_DEADLINE_MS = 60_000;

export interface CancelOpenBatchesResult {
  /** Open batch rows found for the shop. */
  rows: number;
  /** Provider batches the transport cancelled. */
  cancelled: number;
  /** Provider calls (cancel / deleteFile) or credential lookups that did not work. */
  failed: number;
  /** Holds released back to the budget and the pool. */
  released: number;
  /**
   * Holds BOOKED as the charge instead of released: the provider cancel was not
   * confirmed, so the batch may still run and bill. The reserved upper bound is
   * what the shop pays (the consent-withdrawal rule), never "nothing".
   */
  converted: number;
  /** Set when the whole lookup failed; the caller carries on regardless. */
  error?: string;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

class DeadlineError extends Error {
  constructor(ms: number) {
    super(`provider call exceeded ${ms} ms`);
    this.name = "DeadlineError";
  }
}

/** Race a provider call against a deadline. The call is abandoned, not aborted (the transport has no handle). */
async function withDeadline<T>(call: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(ms)), Math.max(1, ms));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function cancelOpenBatches(shop: string): Promise<CancelOpenBatchesResult> {
  const result: CancelOpenBatchesResult = { rows: 0, cancelled: 0, failed: 0, released: 0, converted: 0 };
  const startedAt = Date.now();
  const budgetLeft = () => OVERALL_DEADLINE_MS - (Date.now() - startedAt);
  const callBudget = () => Math.max(1, Math.min(PROVIDER_CALL_DEADLINE_MS, budgetLeft()));
  try {
    const { db } = await import("~/db.server");
    const rows = await db.bulkTranslateBatch.findMany({
      where: { shop, state: { in: [...OPEN_BATCH_STATES] } },
    });
    result.rows = rows.length;

    const { settlementCredentialsFor } = await import("../ai/ai-credentials.server");
    const { releaseBudget, convertReservation } = await import("../ai/usage-meter.server");

    for (const row of rows) {
      // 1. Mark -- state only, never the manifest. Conditional, so a row that
      //    settled in the meantime keeps its own state.
      try {
        await db.bulkTranslateBatch.updateMany({
          where: { id: row.id, state: { in: [...OPEN_BATCH_STATES] } },
          data: { state: "cancel_requested", cancelRequestedAt: new Date() },
        });
        await db.task.updateMany({
          where: { id: row.taskId, shop, status: { in: [...OPEN_BATCH_TASK_STATUSES] } },
          data: { status: TASK_STATUS_CANCEL_REQUESTED },
        });
      } catch (error) {
        result.failed += 1;
        logger.warn(`[BatchCancel] Could not mark batch ${row.id} of ${shop} for cancellation: ${messageOf(error)}`);
      }

      // 2. Cancel at the provider and delete the files this run uploaded.
      //    `confirmed` is true only when EVERY provider batch of the row was
      //    cancelled: anything less may still be running and billing.
      const batchIds = stringList(row.batchIds);
      let confirmed = true;
      try {
        // The row is re-loaded INSIDE the accessor by id -- nothing the caller
        // read is trusted (PLAN 19.3).
        const decision = await settlementCredentialsFor(shop, row.id);
        if (!decision.ok) {
          confirmed = false;
          result.failed += 1;
          logger.warn(`[BatchCancel] No settlement access for batch ${row.id} of ${shop}: ${decision.reason}`);
        } else {
          for (const batchId of batchIds) {
            if (budgetLeft() <= 0) {
              confirmed = false;
              result.failed += 1;
              logger.warn(`[BatchCancel] Overall deadline spent, batch ${row.id} of ${shop} not cancelled`);
              break;
            }
            try {
              await withDeadline(() => decision.transport.cancel(batchId), callBudget());
              result.cancelled += 1;
            } catch (error) {
              confirmed = false;
              result.failed += 1;
              logger.warn(`[BatchCancel] Provider cancel failed for batch ${row.id} of ${shop}: ${messageOf(error)}`);
            }
          }
          for (const fileId of stringList(row.fileIds)) {
            if (budgetLeft() <= 0) break;
            try {
              await withDeadline(() => decision.transport.deleteFile(fileId), callBudget());
            } catch (error) {
              result.failed += 1;
              logger.warn(`[BatchCancel] File delete failed for batch ${row.id} of ${shop}: ${messageOf(error)}`);
            }
          }
        }
      } catch (error) {
        confirmed = false;
        result.failed += 1;
        logger.warn(`[BatchCancel] Settlement failed for batch ${row.id} of ${shop}: ${messageOf(error)}`);
      }

      // 3. Settle the hold. The pool counter is GLOBAL and outlives the shop's
      //    rows, so a reservation left there would inflate the cap for everyone.
      //    A confirmed cancel is not a charge: release. A cancel that is NOT
      //    confirmed (provider down, key gone, deadline) leaves a batch that may
      //    still run and bill: the hold becomes the charge (the reserved upper
      //    bound) -- releasing it would let the shop's budget forget money the
      //    provider may still collect. A row with no provider batch yet has
      //    nothing running: release.
      try {
        const bookIt = batchIds.length > 0 && !confirmed;
        const outcome = await (bookIt ? convertReservation : releaseBudget)(row.id);
        if (outcome.applied) {
          if (bookIt) result.converted += 1;
          else result.released += 1;
        }
      } catch (error) {
        result.failed += 1;
        logger.warn(`[BatchCancel] Could not settle the reservation of batch ${row.id}: ${messageOf(error)}`);
      }
    }

    // 4. Every OTHER row of the shop that still holds a reservation, whatever
    //    its state ("done" rows whose release failed, rows a recovery closed):
    //    nothing runs for them, so the hold goes back. Without this a redaction
    //    deleted the row and left its share of the global pool counted for ever.
    try {
      const handled = new Set(rows.map((r) => r.id));
      const held = await db.bulkTranslateBatch.findMany({
        where: { shop, reservationState: "held" },
        select: { id: true },
      });
      for (const { id } of held) {
        if (handled.has(id)) continue;
        try {
          const outcome = await releaseBudget(id);
          if (outcome.applied) result.released += 1;
        } catch (error) {
          result.failed += 1;
          logger.warn(`[BatchCancel] Could not release the reservation of batch ${id}: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      result.failed += 1;
      logger.warn(`[BatchCancel] Could not look up the held reservations of ${shop}: ${messageOf(error)}`);
    }

    logger.info(
      `[BatchCancel] ${shop}: ${result.rows} open batch row(s), ${result.cancelled} cancelled, ${result.released} hold(s) released, ${result.converted} booked, ${result.failed} step(s) failed`,
    );
  } catch (error) {
    result.error = messageOf(error);
    logger.error(`[BatchCancel] Looking up the open batches of ${shop} failed: ${result.error}`);
  }
  return result;
}
