/**
 * WebP conversion tasks — the parent/child vocabulary, in one place.
 *
 * A conversion run used to be N task rows and nothing else: `api.convert-webp`
 * created one `imageWebpConversion` row PER IMAGE, so a 20-image upload filled
 * a page of the Tasks list and fired twenty completion notifications for one
 * merchant action.
 *
 * The row per image did NOT go away — it is the WORK ITEM, and three consumers
 * treat it as one: `recoverRunningWebpTasks` reads its `progress` as a
 * per-image step boundary (below 70 nothing was written to Shopify, from 70 on
 * the new media may exist and the original may already be gone), the stuck-task
 * reaper refunds exactly ONE image operation per row, and the image manager
 * derives its per-image spinner from the SET of running rows. Aggregating them
 * into one row would re-run images past their destructive step and refund one
 * image's quota for a whole batch.
 *
 * So the work item was RENAMED to `imageWebpConversionItem` and a PARENT row
 * (`imageWebpConversion`, the type the merchant already had a label for) was
 * added above it. The parent carries the merchant-facing outcome; the item is
 * excluded from the Tasks list and from the completion notifications.
 *
 * ── Telling the two apart ────────────────────────────────────────────────
 *
 * Rows created BEFORE this split are still in merchants' databases (a task row
 * lives until `expiresAt`, and a conversion can be in flight across a deploy),
 * and they carry `type: "imageWebpConversion"` with the job INPUT in `result`.
 * They must keep being driven and recovered as work items, which means "is this
 * row a work item" cannot be answered by the type alone. Two signals, and every
 * writer here maintains BOTH:
 *
 *  - `Task.total` is set on a parent (the image count) and on nothing else. No
 *    webp row has ever carried a total before, so `total == null` on a row of
 *    the parent type means "written by the old build".
 *  - A work item's `result` carries the job input (`sourceUrl`); a parent's
 *    carries the outcome and never does.
 *
 * `isWebpWorkRow` reads whichever of the two the caller selected, preferring
 * the column — a SQL filter can express `total`, and the one consumer that
 * cannot select it (the image manager, through `/api/running-field-tasks`)
 * already parses `result`.
 *
 * Plain ESM (no TS) for the same reason as `webp-concurrency.js`: it is
 * consumed by the bundled app AND by `webp-processor.service.js` /
 * `task-recovery.service.js`, which Node imports directly and cannot load a
 * .ts module.
 */

/** The merchant-facing row: ONE per conversion run. */
export const WEBP_PARENT_TASK_TYPE = "imageWebpConversion";

/** The work item: one per image. Hidden from the Tasks list and the toasts. */
export const WEBP_ITEM_TASK_TYPE = "imageWebpConversionItem";

/** Statuses a task can still leave. Mirrors task-recovery's NON_TERMINAL. */
export const WEBP_NON_TERMINAL_STATUS = ["pending", "queued", "running"];

/**
 * A parent with no items at all is only a failure once it is old enough to be
 * one: the route creates the parent first and its items milliseconds later, and
 * the poll sweep must not settle a run it caught mid-creation.
 */
export const WEBP_PARENT_ORPHAN_GRACE_MS = 2 * 60 * 1000;

/** Never store a whole stack trace per failed image in the parent's blob. */
export const WEBP_FAILURE_MESSAGE_MAX = 300;
export const WEBP_FAILURE_LIST_MAX = 50;

/** `JSON.parse` that answers `null` instead of throwing. */
export function parseTaskResult(result) {
  if (typeof result !== "string" || !result.trim()) return null;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Is this row ONE IMAGE of a conversion (and therefore the thing the processor
 * runs, the recovery steps through and the refund counts)?
 *
 * Accepts any row shape; each signal is used only where the caller selected it.
 * A row of the parent type with NEITHER signal available is read as a legacy
 * work item, because that is what every such row was before the split.
 */
export function isWebpWorkRow(row) {
  const type = row?.type;
  if (type === WEBP_ITEM_TASK_TYPE) return true;
  if (type !== WEBP_PARENT_TASK_TYPE) return false;
  if (row?.total != null) return false;
  if (typeof row?.result === "string") {
    const blob = parseTaskResult(row.result);
    // Unreadable (truncated, hand-edited) counts as the PRE-SPLIT shape, the
    // same direction as no signal at all: an aggregate run as work fails one
    // image and refunds it, while a work item read as an aggregate is a
    // conversion that stops with the merchant's original already deleted from
    // Shopify.
    if (!blob) return true;
    return typeof blob.sourceUrl === "string";
  }
  return true;
}

/** The mirror image: the aggregate row. */
export function isWebpParentRow(row) {
  return row?.type === WEBP_PARENT_TASK_TYPE && !isWebpWorkRow(row);
}

/**
 * The Prisma `where` fragment that selects work items and nothing else —
 * item rows plus the legacy rows of the parent type. Spread extra conditions
 * in; do NOT add a second `OR`, it would overwrite this one.
 */
export function webpWorkRowWhere(extra = {}) {
  return {
    ...extra,
    OR: [{ type: WEBP_ITEM_TASK_TYPE }, { type: WEBP_PARENT_TASK_TYPE, total: null }],
  };
}

/** The parent id a work item carries in its own result blob, or `null`. */
export function webpParentTaskId(result) {
  const id = parseTaskResult(result)?.parentTaskId;
  return typeof id === "string" && id ? id : null;
}

/**
 * The terminal status of a finished run. A run where EVERY image failed is
 * `failed`, not `completed_with_errors`: the merchant's twenty images are all
 * still PNG, and a green notification saying so is the "a failed one stops
 * claiming success" rule.
 */
export function webpBatchStatus(converted, failed) {
  if (failed <= 0) return "completed";
  return converted > 0 ? "completed_with_errors" : "failed";
}
