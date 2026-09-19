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
 * How many ids one `/api/task-status` call may ask about.
 *
 * ONE constant, imported by the route as its own cap: a client that asks about
 * more than the loader answers gets no status for the surplus, which
 * `unfinishedTaskIds` correctly reads as "still working" — so the watch could
 * only ever end on the timeout, minutes after the runs really finished. The
 * watch set is a union across saves and 25 groups per save, so three saves
 * reach this; it is a chunk size here, not a limit on what may be watched.
 */
export const MAX_TASK_STATUS_IDS = 50;
/**
 * The bound, and it belongs to an ID rather than to the watch.
 *
 * There used to be a second, shorter one for a task id with no row yet, on the
 * argument that such a run never started. It cost more than it bought, twice
 * over: a repair run is spawned and not awaited, and runs for the same resource
 * are SERIAL (they share an in-flight key — all three repair surfaces of one
 * bulk-edited product do, and so does a run left over from an earlier save), so
 * a row legitimately appears minutes after the save that reported its id. Every
 * expiry of that grace ended the watch against a run that had written nothing,
 * which is the empty cell this hook exists to fill. So a task that has not
 * answered "terminal" is simply still working, and a save whose run really
 * never started (`startFailed` — the run threw before `db.task.create`, so no
 * row will ever exist) costs one small query every five seconds until this,
 * and then one refresh.
 *
 * PER ID, and stamped when the id is FIRST watched. The set is a union that
 * grows with each save, so a deadline belonging to the watch was restarted by
 * every new save: one id that never turns terminal was then never aged out
 * while saves kept arriving, and because the refresh is all-or-nothing it held
 * the reload back for every id that HAD finished. The empty foreign cell again,
 * this time with a poll running for the whole session.
 */
const MAX_WATCH_MS = 5 * 60_000;

/**
 * Which of `ids` are still worth waiting for. Pure, so the rule that decides
 * when a page stops polling is testable without a timer.
 *
 * ONLY a terminal status ends the wait for an id. The other two answers look
 * different and mean the same thing here: `missing` is a healthy poll saying
 * the row is not there YET (see `MAX_WATCH_MS`), and an id absent from the map
 * altogether is a poll that failed — a throw, a non-2xx, the route's own 500
 * branch — which says nothing about the task at all. Reading either as done
 * refreshes the grid before a single translation is written.
 *
 * `expired` is the other way out, and it is not a status: an id whose own
 * deadline has passed is one we STOPPED ASKING about, which is a different
 * statement from "it finished" and is why it may not hold the reload back for
 * the ids that really did.
 */
export function unfinishedTaskIds(
  ids: readonly string[],
  statuses: Readonly<Record<string, string>>,
  expired: ReadonlySet<string> = new Set(),
): string[] {
  return ids.filter((id) => !TERMINAL_TASK_STATUSES.has(statuses[id] ?? "") && !expired.has(id));
}

/**
 * @param taskIds  The ids to watch, or null/empty for "nothing to watch". The
 *                 watch is keyed on the ids THEMSELVES, not on the array's
 *                 identity: a caller that rebuilds the array every render (a
 *                 `?? []`, a `.filter`) would otherwise re-arm the timer before
 *                 it ever fires, and `onFinished` would silently never run.
 * @param onFinished Called at most once per watch, when every id is terminal
 *                 (or the watch times out). It is handed the ids THIS watch
 *                 was about — never "all of them" — so a caller keeping a union
 *                 across saves drops exactly those and keeps ids that arrived
 *                 while this watch was running. Must only refresh the display.
 */
export function useBackgroundTaskRefresh(
  taskIds: readonly string[] | null | undefined,
  onFinished: (watchedIds: string[]) => void,
): void {
  // The callback is read at fire time, so a caller does not have to memoise it
  // — a changed identity must not restart the watch.
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  /** id → when this watch stops asking about it. Outlives the effect, because
   *  a new save restarts the effect and must not restart these. */
  const deadlinesRef = useRef<Map<string, number>>(new Map());

  // Structural, for the reason in the param doc. Sorted because the order of
  // the ids says nothing about what is being watched.
  const watchKey = [...new Set((taskIds ?? []).filter(Boolean))].sort().join(",");

  useEffect(() => {
    const ids = watchKey ? watchKey.split(",") : [];
    // Stamp the new ids, forget the ones the caller has retired. An id already
    // in the map keeps ITS deadline — that is the whole point.
    const deadlines = deadlinesRef.current;
    const watched = new Set(ids);
    for (const id of [...deadlines.keys()]) if (!watched.has(id)) deadlines.delete(id);
    for (const id of ids) if (!deadlines.has(id)) deadlines.set(id, Date.now() + MAX_WATCH_MS);
    if (ids.length === 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    /** Fired once, whether the watch ended or ran out of time. */
    const finish = () => {
      if (cancelled) return;
      cancelled = true;
      onFinishedRef.current(ids);
    };

    const tick = async () => {
      if (cancelled) return;
      const statuses: Record<string, string> = {};
      try {
        // Chunked, because the loader answers at most MAX_TASK_STATUS_IDS per
        // call and a surplus id would come back with no status at all — read
        // as "still working" forever, which is right about the unknown and
        // wrong about the watch.
        for (let from = 0; from < ids.length; from += MAX_TASK_STATUS_IDS) {
          const chunk = ids.slice(from, from + MAX_TASK_STATUS_IDS);
          const response = await fetch(
            `/api/task-status?ids=${encodeURIComponent(chunk.join(","))}`,
            { signal: controller.signal },
          );
          if (!response.ok) break;
          const data = (await response.json()) as { statuses?: Record<string, string> };
          Object.assign(statuses, data?.statuses ?? {});
        }
      } catch {
        // A failed poll answers nothing for any id, which `unfinishedTaskIds`
        // reads as "still working" — never as finished. The next tick asks
        // again; a server that stays down is bounded by each id's MAX_WATCH_MS.
      }
      if (cancelled) return;
      const now = Date.now();
      const expired = new Set(ids.filter((id) => now > (deadlines.get(id) ?? Infinity)));
      const remaining = unfinishedTaskIds(ids, statuses, expired);
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
  }, [watchKey]);
}
