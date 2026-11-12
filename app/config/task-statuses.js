/**
 * Task status vocabulary beyond pending / queued / running / completed /
 * failed / cancelled -- the states of a Batch-API run of "add missing
 * translations" (PLAN_BULK_TRANSLATE_BATCHING 19.4), in ONE place.
 *
 * `Task.status` is a free string, so a new state costs no migration -- and
 * that is exactly why it can be forgotten: every filter that means "this
 * task is still going" used to spell `["pending", "queued", "running"]` out
 * by hand (the badge count, the hover preview, the field-task poll, the
 * single-flight checks, the Tasks tab's poll and Cancel button, the cleanups'
 * expiry sweeps). A provider batch waits up to 24 hours; a state those lists
 * do not name is a run that vanishes from the badge, can be started twice and
 * has its row (and with it the way to settle the batch) deleted by a cleanup.
 *
 * - `submitting`       the run is building / uploading / creating the batch
 *                      (single-flight holds, the runner heartbeats).
 * - `waiting_batch`    the provider holds the batch; nobody in this process is
 *                      "running" anything. Never reaped as stalled -- the
 *                      state lives in BulkTranslateBatch, not in a process.
 * - `cancel_requested` the merchant asked to cancel; the poller cancels at the
 *                      provider, collects what is paid for and settles.
 * - `batch_unreachable` TERMINAL: the provider stopped answering for this
 *                      batch (404 / 403 / rotated key) for N ticks in a row.
 *
 * Plain ESM (no TS), like webp-tasks.js: the root-level Node modules
 * (task-recovery.service.js, orphan-run-recovery.js, task-cleanup.service.js)
 * import it directly and cannot load a .ts file, and app/config is shipped in
 * the runtime image (Dockerfile).
 */

export const TASK_STATUS_SUBMITTING = "submitting";
export const TASK_STATUS_WAITING_BATCH = "waiting_batch";
export const TASK_STATUS_CANCEL_REQUESTED = "cancel_requested";
export const TASK_STATUS_BATCH_UNREACHABLE = "batch_unreachable";

/** Open: a provider batch may exist / be needed. NOT terminal, not reaped, not deletable, not cleaned up. */
export const OPEN_BATCH_TASK_STATUSES = [
  TASK_STATUS_SUBMITTING,
  TASK_STATUS_WAITING_BATCH,
  TASK_STATUS_CANCEL_REQUESTED,
];

/** The terminal states of the batch flow that are NOT one of the classic three. */
export const BATCH_TERMINAL_TASK_STATUSES = [TASK_STATUS_BATCH_UNREACHABLE];

/** Every status that means "this task is still going" (badge, previews, field spinners). */
export const ACTIVE_TASK_STATUSES = ["pending", "queued", "running", ...OPEN_BATCH_TASK_STATUSES];

/**
 * Statuses that hold the bulk-translate SINGLE-FLIGHT. `pending` is separate
 * on purpose: a pending claim row only counts while it is fresh and older
 * (bulk-editor-translate.handler.ts).
 */
export const RUN_OCCUPYING_TASK_STATUSES = ["running", ...OPEN_BATCH_TASK_STATUSES];

/** Statuses a merchant may cancel from the Tasks tab (see task-cancel.server.ts). */
export const CANCELLABLE_BATCH_TASK_STATUSES = [TASK_STATUS_WAITING_BATCH];

/** Terminal statuses a cleanup may delete by `completedAt` (the open ones are excluded by every expiry sweep). */
export const SETTLED_TASK_STATUSES = [
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
  ...BATCH_TERMINAL_TASK_STATUSES,
];

/**
 * The `where` fragment every expiry sweep adds: an open batch task is never
 * deleted by age. Its `expiresAt` is pushed forward by the poller, but the
 * filter does not trust that -- a poller that is down for four days must not
 * delete the only handle on a paid provider batch.
 *
 * @type {{ status: { notIn: string[] } }}
 */
export const NOT_OPEN_BATCH_TASK = { status: { notIn: OPEN_BATCH_TASK_STATUSES } };

/** @param {unknown} status */
export function isOpenBatchTaskStatus(status) {
  return typeof status === "string" && OPEN_BATCH_TASK_STATUSES.includes(status);
}

/**
 * How long the bulk-translate page waits between polls of a task in this
 * status. A batch that waits for the provider changes state a few times in a
 * day, not every two seconds.
 *
 * @param {unknown} status
 * @returns {number}
 */
export function translatePollDelayMs(status) {
  return status === TASK_STATUS_WAITING_BATCH ? 60_000 : 2_000;
}

/**
 * Does the bulk-translate page stop polling on this status?
 *
 * `completed_with_errors` is terminal too (the runner writes it for a partial
 * save); the page used to miss it.
 *
 * @param {unknown} status
 */
export function isTranslatePollTerminal(status) {
  return (
    status === "completed" ||
    status === "completed_with_errors" ||
    status === "failed" ||
    status === "cancelled" ||
    status === TASK_STATUS_BATCH_UNREACHABLE
  );
}
