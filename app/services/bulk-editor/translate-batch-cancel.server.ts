/**
 * Cancel every open provider batch of one shop -- the seam GDPR redaction and
 * the app-uninstall cleanup call BEFORE they delete the shop's Task / AISettings
 * rows (PLAN_BULK_TRANSLATE_BATCHING 6.7).
 *
 * Why it exists: a provider batch outlives the request, the process and -- if
 * nothing cancels it -- the shop. Once the rows that name it are deleted there
 * is no handle left to cancel it with, and it keeps running (and billing) for up
 * to 24 hours on a merchant who asked for their data to be erased. So the order
 * is fixed: mark, cancel at the provider, release the hold, and only then does
 * the caller delete.
 *
 * Best effort by design, and NEVER blocking: a redaction must complete even when
 * the provider is down or the credential is gone, so every step is its own
 * try/catch, failures are logged (shop, task, what failed -- never a key) and
 * counted, and the function never throws. What cannot be cancelled here is a
 * stated residual (the provider lets the batch expire).
 *
 * The provider calls go through the settlement transport
 * (settlementCredentialsFor): the one place the operator key may be used for
 * settling, restricted to cancel / deleteFile here. Until the provider calls
 * exist (next phase) the transport answers `SettlementNotImplementedError`,
 * which this treats like any other unreachable provider: logged, counted, the
 * rows are still marked so the poller can finish the job later.
 */

import {
  OPEN_BATCH_TASK_STATUSES,
  TASK_STATUS_CANCEL_REQUESTED,
} from "~/config/task-statuses.js";
import { stringList } from "../ai/batch-settlement.shared";
import { logger } from "~/utils/logger.server";

/** Batch-row states in which a provider batch may exist or be needed. */
export const OPEN_BATCH_STATES = ["submitting", "waiting", "cancel_requested", "collecting"] as const;

export interface CancelOpenBatchesResult {
  /** Open batch rows found for the shop. */
  rows: number;
  /** Provider batches the transport cancelled. */
  cancelled: number;
  /** Provider calls (cancel / deleteFile) or credential lookups that did not work. */
  failed: number;
  /** Holds released back to the budget and the pool. */
  released: number;
  /** Set when the whole lookup failed; the caller carries on regardless. */
  error?: string;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function cancelOpenBatches(shop: string): Promise<CancelOpenBatchesResult> {
  const result: CancelOpenBatchesResult = { rows: 0, cancelled: 0, failed: 0, released: 0 };
  try {
    const { db } = await import("~/db.server");
    const rows = await db.bulkTranslateBatch.findMany({
      where: { shop, state: { in: [...OPEN_BATCH_STATES] } },
    });
    result.rows = rows.length;
    if (rows.length === 0) return result;

    let settings: Awaited<ReturnType<typeof db.aISettings.findUnique>> = null;
    try {
      settings = await db.aISettings.findUnique({ where: { shop } });
    } catch (error) {
      // A BYO batch cannot be cancelled without the merchant's key; a managed one can.
      logger.warn(`[BatchCancel] Could not read the AI settings of ${shop}: ${messageOf(error)}`);
    }
    const { settlementCredentialsFor } = await import("../ai/ai-credentials.server");
    const { releaseBudget } = await import("../ai/usage-meter.server");

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
      try {
        const decision = settlementCredentialsFor(shop, row, settings);
        if (!decision.ok) {
          result.failed += 1;
          logger.warn(`[BatchCancel] No settlement access for batch ${row.id} of ${shop}: ${decision.reason}`);
        } else {
          for (const batchId of stringList(row.batchIds)) {
            try {
              await decision.transport.cancel(batchId);
              result.cancelled += 1;
            } catch (error) {
              result.failed += 1;
              logger.warn(`[BatchCancel] Provider cancel failed for batch ${row.id} of ${shop}: ${messageOf(error)}`);
            }
          }
          for (const fileId of stringList(row.fileIds)) {
            try {
              await decision.transport.deleteFile(fileId);
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

      // 3. Give the hold back: the pool counter is GLOBAL and outlives the
      //    shop's rows, so a reservation left there would inflate the cap for
      //    everyone. (A batch that is cancelled is not collected, so it is not
      //    a charge -- the consent-withdrawal conversion is the poller's path.)
      try {
        const released = await releaseBudget(row.id);
        if (released.applied) result.released += 1;
      } catch (error) {
        result.failed += 1;
        logger.warn(`[BatchCancel] Could not release the reservation of batch ${row.id}: ${messageOf(error)}`);
      }
    }
    logger.info(
      `[BatchCancel] ${shop}: ${result.rows} open batch row(s), ${result.cancelled} cancelled, ${result.released} hold(s) released, ${result.failed} step(s) failed`,
    );
  } catch (error) {
    result.error = messageOf(error);
    logger.error(`[BatchCancel] Looking up the open batches of ${shop} failed: ${result.error}`);
  }
  return result;
}
