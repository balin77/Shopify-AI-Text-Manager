/**
 * Cancelling a Task from the Tasks tab, BRANCHED ON ITS STATUS.
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
 */

import type { PrismaClient } from "@prisma/client";

/** Statuses a merchant may cancel. */
export const CANCELLABLE_TASK_STATUSES = ["pending", "running"] as const;

export type CancelTaskOutcome = { ok: true } | { ok: false; reason: "notCancellable" };

export async function cancelTask(
  db: Pick<PrismaClient, "task">,
  shop: string,
  taskId: string,
): Promise<CancelTaskOutcome> {
  const res = await db.task.updateMany({
    where: { id: taskId, shop, status: { in: [...CANCELLABLE_TASK_STATUSES] } },
    data: { status: "cancelled", completedAt: new Date() },
  });
  return res.count > 0 ? { ok: true } : { ok: false, reason: "notCancellable" };
}
