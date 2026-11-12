/**
 * Cancelling and deleting a Task from the Tasks tab, BRANCHED ON ITS STATUS.
 *
 * The action used to `update` the row to `cancelled` whatever it was — so a
 * "cancel" that arrived a moment after the run finished turned a COMPLETED
 * task into a cancelled one, and a task row of another state (a failed run, a
 * finished one) was rewritten at will. Only a task that is still going can be
 * cancelled, and the write is conditional on that, so it cannot lose a race
 * against the run's own terminal update.
 *
 * What cancelling means is the runner's business: `bulkEditorTranslate`
 * re-reads its status before every row and every write block and stops
 * (bulk-editor-translate.handler.ts); what it already wrote stays written.
 * Other task types keep their old behaviour (the status flips, the work is
 * not interrupted) — this change does not claim more.
 *
 * A task WAITING for its provider batch (`waiting_batch`, PLAN_BULK_TRANSLATE_
 * BATCHING 19.4) is different: no process runs anything for it, so there is
 * nobody to stop. Cancel asks the poller to do it — `waiting_batch` →
 * `cancel_requested` (a conditional updateMany, mirrored onto the batch row
 * without touching its manifest), and the poller cancels at the provider,
 * collects what is already paid for and settles the task as `cancelled`.
 * Every other batch state (`submitting`, `cancel_requested` already) is
 * refused: the submit phase has a runner that owns the transition.
 *
 * DELETING is refused for the open batch states, server-side: the row is the
 * only handle on a paid provider batch (the cleanups exclude it for the same
 * reason), and the Tasks tab hiding the button is UI only.
 */

import type { PrismaClient } from "@prisma/client";
import {
  OPEN_BATCH_TASK_STATUSES,
  TASK_STATUS_CANCEL_REQUESTED,
  TASK_STATUS_WAITING_BATCH,
} from "~/config/task-statuses.js";
import { logger } from "~/utils/logger.server";

/** Statuses a merchant may cancel with the classic (immediate) semantics. */
export const CANCELLABLE_TASK_STATUSES = ["pending", "running"] as const;

export type CancelTaskOutcome =
  | { ok: true; /** `requested` = the poller will cancel at the provider; `cancelled` = done. */ mode: "cancelled" | "requested" }
  | { ok: false; reason: "notCancellable" };

type CancelDb = Pick<PrismaClient, "task"> & Partial<Pick<PrismaClient, "bulkTranslateBatch">>;

export async function cancelTask(db: CancelDb, shop: string, taskId: string): Promise<CancelTaskOutcome> {
  const res = await db.task.updateMany({
    where: { id: taskId, shop, status: { in: [...CANCELLABLE_TASK_STATUSES] } },
    data: { status: "cancelled", completedAt: new Date() },
  });
  if (res.count > 0) return { ok: true, mode: "cancelled" };

  // A task waiting for its provider batch: hand the cancel to the poller.
  const requested = await db.task.updateMany({
    where: { id: taskId, shop, status: TASK_STATUS_WAITING_BATCH },
    data: { status: TASK_STATUS_CANCEL_REQUESTED },
  });
  if (requested.count > 0) {
    // Mirror onto the batch row (state only, never the manifest). The Task
    // status is authoritative for the poller too, so a failed mirror loses
    // nothing: it only logs.
    try {
      await db.bulkTranslateBatch?.updateMany({
        where: { taskId, shop, state: "waiting" },
        data: { state: "cancel_requested", cancelRequestedAt: new Date() },
      });
    } catch (error) {
      logger.warn("[Tasks] Could not mirror cancel_requested onto the batch row", {
        context: "TaskCancel",
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ok: true, mode: "requested" };
  }
  return { ok: false, reason: "notCancellable" };
}

export type DeleteTaskOutcome = { ok: true } | { ok: false; reason: "openBatch" | "notFound" };

export async function deleteTask(
  db: Pick<PrismaClient, "task">,
  shop: string,
  taskId: string,
): Promise<DeleteTaskOutcome> {
  // ONE conditional statement: a status read followed by a delete would let
  // a task move into `waiting_batch` in between.
  const res = await db.task.deleteMany({
    where: { id: taskId, shop, status: { notIn: [...OPEN_BATCH_TASK_STATUSES] } },
  });
  if (res.count > 0) return { ok: true };
  const row = await db.task.findFirst({ where: { id: taskId, shop }, select: { status: true } });
  return row ? { ok: false, reason: "openBatch" } : { ok: false, reason: "notFound" };
}
