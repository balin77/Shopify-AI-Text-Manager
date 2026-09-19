import { useEffect, useRef } from "react";

/**
 * Watch the `Task` rows a save started, and refresh the DISPLAY once they are
 * done.
 *
 * The bulk editor is why this exists. With `autoTranslateExternalChanges` on, a
 * primary edit hands its foreign locales to a DETACHED AI run; the save's own
 * `revalidator.revalidate()` lands seconds before the first answer comes back,
 * and nothing else ever tells the page the run finished. A merchant who saves
 * an alt text and then switches languages is therefore looking at empty foreign
 * cells for translations that are on their way — which reads exactly like the
 * feature not working.
 *
 * Three rules, and each one is a thing this must NOT become:
 *
 * 1. IT ONLY READS. `onFinished` is a loader revalidation, never a submit.
 *    There is no autosave in this app and this hook must not smuggle one in:
 *    unsaved edits, their baselines and the undo history all live in the page's
 *    own state and a revalidation leaves every one of them alone.
 *
 * 2. IT ENDS. The poll runs only while a KNOWN task of THIS save is still
 *    alive, and stops the moment they are all terminal — not a standing feed of
 *    whatever the shop happens to be doing. `MAX_WATCH_MS` bounds it even when
 *    the answer never becomes terminal.
 *
 * 3. GIVING UP MEANS "we stopped asking", never "there is nothing there". A
 *    watch that runs out of time still refreshes once: the run may well have
 *    finished while we were waiting, and a display reload can only ever show
 *    more of the truth than the page already has.
 */

/** Statuses a Task never leaves. Everything else is still working. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
]);

/** The loader answers `missing` for a row that is not there. */
export const MISSING_TASK_STATUS = "missing";

const POLL_INTERVAL_MS = 5_000;
/**
 * How long a task id with no row yet still counts as "starting".
 *
 * A repair run is spawned and not awaited, and one queued behind another for
 * the same resource creates its row only when it reaches the head of the queue
 * — so `missing` genuinely means "not yet" for a while. Past this it means the
 * run never started, and polling on would be polling for nothing.
 */
const MISSING_GRACE_MS = 90_000;
const MAX_WATCH_MS = 5 * 60_000;

/**
 * Which of `ids` are still worth waiting for. Pure, so the rule that decides
 * when a page stops polling is testable without a timer.
 */
export function unfinishedTaskIds(
  ids: readonly string[],
  statuses: Readonly<Record<string, string>>,
  /** True while an id with no row yet still counts as starting. */
  missingStillCounts: boolean,
): string[] {
  return ids.filter((id) => {
    const status = statuses[id];
    // No answer at all for this id (a failed or partial response) is not
    // evidence that it finished — the same rule as `missing`.
    if (status === undefined || status === MISSING_TASK_STATUS) return missingStillCounts;
    return !TERMINAL_TASK_STATUSES.has(status);
  });
}

/**
 * @param taskIds  The ids to watch, or null/empty for "nothing to watch". A new
 *                 ARRAY IDENTITY starts a new watch, so pass the value straight
 *                 off the save result rather than re-deriving it every render.
 * @param onFinished Called at most once per watch, when every id is terminal
 *                 (or the watch times out). Must only refresh the display.
 */
export function useBackgroundTaskRefresh(
  taskIds: readonly string[] | null | undefined,
  onFinished: () => void,
): void {
  // The callback is read at fire time, so a caller does not have to memoise it
  // — a changed identity must not restart the watch.
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    const ids = [...new Set((taskIds ?? []).filter(Boolean))];
    if (ids.length === 0) return;

    const startedAt = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    /** Fired once, whether the watch ended or ran out of time. */
    const finish = () => {
      if (cancelled) return;
      cancelled = true;
      onFinishedRef.current();
    };

    const tick = async () => {
      if (cancelled) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed > MAX_WATCH_MS) {
        finish();
        return;
      }
      let statuses: Record<string, string> = {};
      try {
        const response = await fetch(
          `/api/task-status?ids=${encodeURIComponent(ids.join(","))}`,
          { signal: controller.signal },
        );
        if (response.ok) {
          const data = (await response.json()) as { statuses?: Record<string, string> };
          statuses = data?.statuses ?? {};
        }
      } catch {
        // A failed poll answers nothing, which `unfinishedTaskIds` reads as
        // "still working" — never as finished. The next tick asks again.
      }
      if (cancelled) return;
      const remaining = unfinishedTaskIds(ids, statuses, Date.now() - startedAt < MISSING_GRACE_MS);
      if (remaining.length === 0) {
        finish();
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [taskIds]);
}
