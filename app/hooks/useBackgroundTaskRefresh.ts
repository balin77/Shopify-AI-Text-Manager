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
 * How long a task id with no row yet still counts as "starting", once nothing
 * else this watch knows about is working either.
 *
 * A repair run is spawned and not awaited, so `missing` genuinely means "not
 * yet" for a while. Past this it means the run never started — but only when
 * nothing is left that it could still be queued behind; see
 * `unfinishedTaskIds`.
 */
const MISSING_GRACE_MS = 90_000;
const MAX_WATCH_MS = 5 * 60_000;

/**
 * Which of `ids` are still worth waiting for. Pure, so the rule that decides
 * when a page stops polling is testable without a timer.
 *
 * THREE answers, not two, and the distinction is the whole rule.
 *
 * A status this map does not carry AT ALL is a poll that failed (a throw, a
 * non-2xx, the route's own 500 branch). It says nothing about the task, so it
 * can never end the watch — the next tick asks again, and `MAX_WATCH_MS` is
 * what bounds a server that stays down.
 *
 * A status of `missing` is a real answer from a healthy poll: the row is not
 * there. That is still NOT-YET while anything else this watch holds is alive,
 * because a repair run queued behind a sibling for the same resource creates
 * its row only when it reaches the head of that queue — and all three repair
 * surfaces of one bulk-edited product (content, sub-resources, alt texts) pass
 * the SAME product GID, so they share an in-flight key and run strictly one
 * after another, long past any grace measured from the save. Only with nothing
 * working and the grace spent does `missing` mean "this never started".
 */
export function unfinishedTaskIds(
  ids: readonly string[],
  statuses: Readonly<Record<string, string>>,
  /** True while an id with no row yet still counts as starting on its own. */
  missingStillCounts: boolean,
): string[] {
  const stateOf = (id: string): "done" | "working" | "missing" | "unanswered" => {
    const status = statuses[id];
    if (status === undefined) return "unanswered";
    if (status === MISSING_TASK_STATUS) return "missing";
    return TERMINAL_TASK_STATUSES.has(status) ? "done" : "working";
  };
  const states = new Map(ids.map((id) => [id, stateOf(id)] as const));
  const somethingAlive = [...states.values()].some(
    (state) => state === "working" || state === "unanswered",
  );
  return ids.filter((id) => {
    const state = states.get(id);
    if (state === "done") return false;
    if (state === "missing") return missingStillCounts || somethingAlive;
    return true;
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
    /**
     * When this watch last saw a task REACH a terminal state — what the
     * `missing` grace is measured from, not the start of the watch.
     *
     * The repair runs of one bulk-edited row are serial (they share a
     * `resourceId`, so they share an in-flight key), so the second one's Task
     * row appears only once the first has finished. Measured from the save,
     * its grace would have expired while it was still queued; measured from
     * the last thing that actually happened, it gets its own.
     */
    let lastProgressAt = startedAt;
    /** Monotonic, so a failed poll (which answers nothing) cannot move it. */
    let terminalSeen = 0;
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
        // A failed poll answers nothing for ANY id, which `unfinishedTaskIds`
        // reads as "still working" — never as finished, and never as the
        // `missing` the grace can expire. The next tick asks again; a server
        // that stays down is bounded by MAX_WATCH_MS, not by this.
      }
      if (cancelled) return;
      const terminal = ids.filter((id) => TERMINAL_TASK_STATUSES.has(statuses[id] ?? "")).length;
      if (terminal > terminalSeen) {
        terminalSeen = terminal;
        lastProgressAt = Date.now();
      }
      const remaining = unfinishedTaskIds(
        ids,
        statuses,
        Date.now() - lastProgressAt < MISSING_GRACE_MS,
      );
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
