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
 * The hold is settled by the guiding rule of translate-batch-hold.server.ts
 * (PLAN 16): after the cancel the provider's request counts are READ (no
 * content) and the hold is booked pro rata from them, released only where the
 * provider proves nothing ran, and converted to the reserved upper bound where
 * nothing can be read or the batch has not ended (a cancel takes effect
 * asynchronously: "the cancel call worked" proves nothing). The caller deletes
 * the rows right after, so this is the LAST look: no `pending`. The rows are
 * CLOSED here (an uninstalled shop's row would otherwise sit in
 * `cancel_requested` until the absolute end).
 *
 * The provider calls go through the settlement transport
 * (settlementCredentialsFor, which re-loads the row by id): the one place the
 * operator key may be used for settling, restricted to cancel / deleteFile here.
 */

import {
  OPEN_BATCH_TASK_STATUSES,
  TASK_STATUS_CANCEL_REQUESTED,
} from "~/config/task-statuses.js";
import { stringList, type SettlementTransport } from "../ai/batch-settlement.shared";
import { settleHold } from "./translate-batch-hold.server";
import { logger } from "~/utils/logger.server";

/** Batch-row states in which a provider batch may exist or be needed. */
export const OPEN_BATCH_STATES = ["submitting", "create_unknown", "waiting", "cancel_requested", "collecting"] as const;

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
  /** Holds released back to the budget and the pool: the provider PROVED nothing ran. */
  released: number;
  /**
   * Holds BOOKED as the charge instead of released: pro rata from the request
   * counts where they could be read, the reserved upper bound where not. Never
   * "nothing" for a batch that may have run.
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

    for (const row of rows) {
      // 1. Mark -- state only, never the manifest. Conditional, so a row that
      //    settled in the meantime keeps its own state.
      try {
        await db.bulkTranslateBatch.updateMany({
          where: { id: row.id, state: { in: [...OPEN_BATCH_STATES] } },
          data: { state: "cancel_requested" },
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
      //    A failed cancel is only logged here: whether the batch ran is decided by the counts below.
      const batchIds = stringList(row.batchIds);
      let transport: SettlementTransport | null = null;
      let allCancelled = batchIds.length === 0;
      try {
        // The row is re-loaded INSIDE the accessor by id -- nothing the caller
        // read is trusted (PLAN 19.3).
        const decision = await settlementCredentialsFor(shop, row.id);
        if (!decision.ok) {
          result.failed += 1;
          logger.warn(`[BatchCancel] No settlement access for batch ${row.id} of ${shop}: ${decision.reason}`);
        } else {
          transport = decision.transport;
          let confirmedIds = 0;
          for (const batchId of batchIds) {
            if (budgetLeft() <= 0) {
              result.failed += 1;
              logger.warn(`[BatchCancel] Overall deadline spent, batch ${row.id} of ${shop} not cancelled`);
              break;
            }
            try {
              await withDeadline(() => decision.transport.cancel(batchId), callBudget());
              result.cancelled += 1;
              confirmedIds += 1;
            } catch (error) {
              result.failed += 1;
              logger.warn(`[BatchCancel] Provider cancel failed for batch ${row.id} of ${shop}: ${messageOf(error)}`);
            }
          }
          // The poller reads cancelRequestedAt as "provider cancel CONFIRMED": set it only when every id was.
          if (batchIds.length > 0 && confirmedIds === batchIds.length) {
            allCancelled = true;
            await db.bulkTranslateBatch.updateMany({ where: { id: row.id, state: "cancel_requested" }, data: { cancelRequestedAt: new Date() } }).catch(() => undefined);
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
        result.failed += 1;
        logger.warn(`[BatchCancel] Settlement failed for batch ${row.id} of ${shop}: ${messageOf(error)}`);
      }

      // 3. Settle the hold per the guiding rule (read the counts, book / release / convert).
      //    The row is closed afterwards (L5): it is not left in `cancel_requested`.
      try {
        const outcome = await settleHold(row, transport, { final: true });
        if (outcome.kind === "released") result.released += 1;
        else if (outcome.kind === "booked" || outcome.kind === "converted") result.converted += 1;
        // A row whose provider cancel was NOT confirmed stays open (cancel_requested, no cancelRequestedAt): the
        // poller treats it as an orphan, cancels again and settles (settleHold acts only while held).
        if (outcome.kind !== "pending" && allCancelled) {
          await db.bulkTranslateBatch.updateMany({
            where: { id: row.id, state: { in: [...OPEN_BATCH_STATES] } },
            data: { state: "done", lastError: "shop_removed" },
          });
          await db.task.updateMany({
            where: { id: row.taskId, shop, status: { in: [...OPEN_BATCH_TASK_STATUSES] } },
            data: { status: "cancelled", completedAt: new Date() },
          });
        }
      } catch (error) {
        result.failed += 1;
        logger.warn(`[BatchCancel] Could not settle the reservation of batch ${row.id}: ${messageOf(error)}`);
      }
    }

    // 4. Every OTHER row of the shop that still holds a reservation, whatever
    //    its state ("done" rows whose settlement failed, rows a recovery closed).
    //    The pool counter is GLOBAL and outlives the shop's rows, so a hold left
    //    there would inflate the cap for everyone -- but a row that names a batch
    //    is settled by the same rule (counts, else the upper bound), never just
    //    released.
    try {
      const handled = new Set(rows.map((r) => r.id));
      const held = await db.bulkTranslateBatch.findMany({ where: { shop, reservationState: "held" } });
      for (const row of held) {
        if (handled.has(row.id)) continue;
        try {
          if (stringList(row.batchIds).length === 0) {
            // A settled row that never named a batch: the create was refused or never sent, nothing runs.
            const { releaseBudget } = await import("../ai/usage-meter.server");
            if ((await releaseBudget(row.id)).applied) result.released += 1;
            continue;
          }
          const decision = await settlementCredentialsFor(shop, row.id);
          const outcome = await settleHold(row, decision.ok ? decision.transport : null, { final: true });
          if (outcome.kind === "released") result.released += 1;
          else if (outcome.kind === "booked" || outcome.kind === "converted") result.converted += 1;
        } catch (error) {
          result.failed += 1;
          logger.warn(`[BatchCancel] Could not settle the reservation of batch ${row.id}: ${messageOf(error)}`);
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
