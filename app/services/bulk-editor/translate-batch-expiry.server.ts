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
 * The HOLD is settled by the guiding rule (translate-batch-hold.server.ts,
 * PLAN 16), never simply released: a batch that ran is paid for whether or not
 * anything collected it. This is the last look, so the provider's request
 * counts are read where the credentials module allows it (booked pro rata,
 * released only if the provider proves nothing ran) and the reserved upper
 * bound is booked where it does not (kill switch on, key gone, provider down,
 * a batch still running). The hold is settled BEFORE the row is marked done, so
 * the reservation sweep can never release what should have been converted.
 *
 * Never throws; every step is logged and counted.
 */

import { randomUUID } from "node:crypto";
import { OPEN_BATCH_TASK_STATUSES, TASK_STATUS_BATCH_UNREACHABLE } from "~/config/task-statuses.js";
import { stringList } from "../ai/batch-settlement.shared";
import { logger } from "~/utils/logger.server";
import { settleHold } from "./translate-batch-hold.server";
import { BATCH_COLLECT_FAILED_ERROR, CONSENT_GIVE_UP_CODE, SHOP_REMOVED_ERROR, collectEvidence } from "./translate-batch-poll.server";

/** Provider batches expire at 24 h + collection time; 48 h leaves a day for a poller that was down. */
export const OPEN_BATCH_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Batch-row states that mean "still open". */
const OPEN_ROW_STATES = ["submitting", "create_unknown", "waiting", "cancel_requested", "collecting"] as const;

/** The machine code the Tasks tab renders (taskErrorText). */
export const BATCH_UNREACHABLE_ERROR = "batch_unreachable";
/** The create of the batch never confirmed and no batch was ever found: the hold was booked at the upper bound. */
export const BATCH_SUBMIT_UNCONFIRMED_ERROR = "batch_submit_unconfirmed";

const CLOSE_LEASE_MS = 2 * 60 * 1000;

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
    const leaseFree = [{ leaseUntil: null }, { leaseUntil: { lt: now } }];
    const rows = await db.bulkTranslateBatch.findMany({
      where: {
        state: { in: [...OPEN_ROW_STATES] },
        createdAt: { lt: new Date(now.getTime() - OPEN_BATCH_MAX_AGE_MS) },
        OR: leaseFree,
      },
      take: limit,
    });
    for (const row of rows) {
      try {
        // Take the lease for the closing: a poller that takes it between the select and here keeps its row.
        const token = randomUUID();
        const claimed = await db.bulkTranslateBatch.updateMany({
          where: { id: row.id, state: { in: [...OPEN_ROW_STATES] }, OR: leaseFree },
          data: { leaseToken: token, leaseUntil: new Date(now.getTime() + CLOSE_LEASE_MS) },
        });
        if (claimed.count !== 1) continue;

        // 1. Settle the hold FIRST (last look: counts where readable, else the upper bound).
        const { settlementCredentialsFor } = await import("../ai/ai-credentials.server");
        let transport = null;
        try {
          const decision = await settlementCredentialsFor(row.shop, row.id);
          if (decision.ok) transport = decision.transport;
        } catch {
          transport = null;
        }
        const outcome = await settleHold(row, transport, { final: true });
        if (outcome.kind === "pending") {
          // The bookkeeping itself failed: leave the row open, the next pass tries again.
          await db.bulkTranslateBatch.updateMany({ where: { id: row.id, leaseToken: token }, data: { leaseToken: null, leaseUntil: null } });
          result.failed += 1;
          continue;
        }

        // 2. Then close the row and the task together.
        // The code comes from the ROW (read before the settlement above): a collect that was reached (marker, or a
        // managed booking that left "held") must not read "nothing was written"; a withdrawn consent says so.
        const unconfirmed = stringList(row.batchIds).length === 0;
        const collectReached = collectEvidence(row);
        const shopRemoved = row.lastError === SHOP_REMOVED_ERROR && !collectReached;
        const code = shopRemoved
          ? SHOP_REMOVED_ERROR
          : row.consentWithdrawnAt
          ? CONSENT_GIVE_UP_CODE
          : collectReached
            ? BATCH_COLLECT_FAILED_ERROR
            : unconfirmed
              ? BATCH_SUBMIT_UNCONFIRMED_ERROR
              : BATCH_UNREACHABLE_ERROR;
        const failTask = code !== BATCH_UNREACHABLE_ERROR && !shopRemoved;
        const closed = await db.$transaction(async (tx) => {
          const flipped = await tx.bulkTranslateBatch.updateMany({
            where: { id: row.id, leaseToken: token },
            data: { state: "done", lastError: code, leaseToken: null, leaseUntil: null },
          });
          if (flipped.count !== 1) return false;
          await tx.task.updateMany({
            where: { id: row.taskId, status: { in: [...OPEN_BATCH_TASK_STATUSES] } },
            data: {
              status: shopRemoved ? "cancelled" : failTask ? "failed" : TASK_STATUS_BATCH_UNREACHABLE,
              error: code,
              completedAt: now,
            },
          });
          return true;
        });
        if (!closed) continue;
        result.expired += 1;
        logger.warn("[BatchExpiry] Open batch run passed its absolute end and was closed", {
          context: "AI",
          batchRowId: row.id,
          taskId: row.taskId,
          hold: outcome.kind,
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
