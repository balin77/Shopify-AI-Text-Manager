import { useEffect, useRef } from "react";

/**
 * Watch the `Task` rows a save started, and refresh the DISPLAY as they finish.
 *
 * The bulk editor is why this exists. With `autoTranslateExternalChanges` on, a
 * primary edit hands its foreign locales to a DETACHED AI run; the save's own
 * `revalidator.revalidate()` lands seconds before the first answer comes back,
 * and nothing else ever tells the page the run finished. A merchant who saves
 * an alt text and then switches languages is therefore looking at empty foreign
 * cells for translations that are on their way — which reads exactly like the
 * feature not working.
 *
 * Four rules, and each one is a thing this must NOT become:
 *
 * 1. IT ONLY READS. The callback refreshes the display, never submits. There is
 *    no autosave in this app and this hook must not smuggle one in: unsaved
 *    edits, their baselines and the undo history all live in the page's own
 *    state and a loader revalidation leaves every one of them alone.
 *
 * 2. IT ENDS. The poll runs only while a KNOWN task of this page's own work is
 *    still alive — never a standing feed of whatever the shop is doing — and
 *    each id carries a deadline past which we stop asking.
 *
 * 3. IT REPORTS PER ID, not per batch. A save starts up to `MAX_REPAIR_GROUPS`
 *    runs of very different lengths; holding the reload until the slowest one
 *    ends would leave the grid showing empty cells for translations that landed
 *    minutes ago. Every id is reported the poll it settles on, once.
 *
 * 4. GIVING UP MEANS "we stopped asking", never "there is nothing there". An id
 *    that runs out its deadline is reported settled like any other, so the page
 *    refreshes and stops watching it instead of waiting forever.
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
 * `classifyWatchedTasks` correctly reads as "still working" — so those ids
 * could only ever leave the watch on their deadline, minutes after the runs
 * really finished. The watch set is a union across saves at 25 groups a save,
 * so it is a chunk size here, not a limit on what may be watched.
 */
export const MAX_TASK_STATUS_IDS = 50;

/**
 * How long an id is watched without ever being seen ALIVE.
 *
 * A repair run is spawned and not awaited, and runs for one resource are SERIAL
 * (they share an in-flight key — all three repair surfaces of one bulk-edited
 * product do, and so does a run left over from an earlier save), so a row
 * legitimately appears minutes after the save that reported its id. A shorter
 * bound was tried and removed: every expiry of it ended the wait against a run
 * that had written nothing, which is the empty cell this hook exists to fill.
 *
 * So the deadline is REFRESHED every time a poll sees the id alive — a row that
 * exists and has not finished is not a guess — and what it really bounds is the
 * one case with no evidence at all: a run that never created its row
 * (`startFailed`: it threw before `db.task.create`). Per ID and kept across
 * restarts, because the watched set is a union that grows with each save and a
 * deadline belonging to the WATCH was restarted by every one of them.
 */
const MAX_SILENT_WATCH_MS = 5 * 60_000;

export interface TaskWatchUpdate {
  /** Ids that are finished with — terminal, or given up on. Stop watching. */
  settled: string[];
  /**
   * Ids a settled task pointed AT: the bulk editor's large saves run inside a
   * `seoBulkMeta` task, and the repairs they start are Task rows of their own
   * that only that task's result names. Start watching these.
   */
  follow: string[];
}

/**
 * Which watched ids are done with, and which are still working.
 *
 * ONLY a terminal status finishes an id. The other two answers look different
 * and mean the same thing here: `missing` is a healthy poll saying the row is
 * not there YET, and an id absent from the map altogether is a poll that failed
 * — a throw, a non-2xx, the route's own 500 branch — which says nothing about
 * the task at all. Reading either as done refreshes the grid before a single
 * translation is written.
 *
 * `expired` is the other way out, and it is deliberately not a status: an id
 * whose deadline has passed is one we STOPPED ASKING about, which is a
 * different statement from "it finished" — and is why it may not hold the
 * refresh back for the ids that really did.
 */
export function classifyWatchedTasks(
  ids: readonly string[],
  statuses: Readonly<Record<string, string>>,
  expired: ReadonlySet<string> = new Set(),
): { settled: string[]; working: string[]; alive: string[] } {
  const settled: string[] = [];
  const working: string[] = [];
  /** The row EXISTS and has not finished — evidence, not a guess. */
  const alive: string[] = [];
  for (const id of ids) {
    const status = statuses[id];
    if (status !== undefined && TERMINAL_TASK_STATUSES.has(status)) {
      settled.push(id);
      continue;
    }
    // ALIVE BEATS EXPIRED, and the order is the point: the deadline exists for
    // an id we have no evidence about, so expiring one this very poll reports
    // as running would drop a task we can SEE registering translations.
    if (status !== undefined && status !== MISSING_TASK_STATUS) {
      alive.push(id);
      working.push(id);
      continue;
    }
    if (expired.has(id)) settled.push(id);
    else working.push(id);
  }
  return { settled, working, alive };
}

/**
 * @param taskIds  The ids to watch, or null/empty for "nothing to watch". The
 *                 watch is keyed on the ids THEMSELVES, not on the array's
 *                 identity: a caller that rebuilds the array every render (a
 *                 `?? []`, a `.filter`) would otherwise re-arm the timer before
 *                 it ever fires, and the update would silently never come.
 * @param onUpdate Called when ids settle or a settled task points at new ones.
 *                 The caller drops `settled`, adds `follow`, and refreshes its
 *                 display — nothing else. Each id is reported ONCE; a caller
 *                 that does not drop it will not be told again.
 */
export function useBackgroundTaskRefresh(
  taskIds: readonly string[] | null | undefined,
  onUpdate: (update: TaskWatchUpdate) => void,
): void {
  // Read at fire time, so a caller does not have to memoise it — a changed
  // identity must not restart the watch.
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  /** id → when we stop asking about it without ever seeing it alive. Outlives
   *  the effect: a new save restarts the effect and must not restart these. */
  const deadlinesRef = useRef<Map<string, number>>(new Map());
  /** Ids already reported settled. Without this, a caller that keeps one in its
   *  set would be told again on every poll — a refresh loop. */
  const reportedRef = useRef<Set<string>>(new Set());

  // Structural, for the reason in the param doc. Sorted because the order of
  // the ids says nothing about what is being watched.
  const watchKey = [...new Set((taskIds ?? []).filter(Boolean))].sort().join(",");

  useEffect(() => {
    const ids = watchKey ? watchKey.split(",") : [];
    const deadlines = deadlinesRef.current;
    const watched = new Set(ids);
    // Stamp the new ids and forget the retired ones. An id already in the map
    // keeps ITS deadline — that is the whole point of it being per id.
    for (const id of [...deadlines.keys()]) if (!watched.has(id)) deadlines.delete(id);
    for (const id of [...reportedRef.current]) if (!watched.has(id)) reportedRef.current.delete(id);
    for (const id of ids) {
      if (!deadlines.has(id)) deadlines.set(id, Date.now() + MAX_SILENT_WATCH_MS);
    }
    if (ids.length === 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const tick = async () => {
      if (cancelled) return;
      const statuses: Record<string, string> = {};
      const follow: string[] = [];
      try {
        // Chunked, because the loader answers at most MAX_TASK_STATUS_IDS per
        // call and a surplus id would come back with no status at all — read
        // as "still working", which is right about the unknown id and wrong
        // about the watch.
        for (let from = 0; from < ids.length; from += MAX_TASK_STATUS_IDS) {
          const chunk = ids.slice(from, from + MAX_TASK_STATUS_IDS);
          const response = await fetch(
            `/api/task-status?ids=${encodeURIComponent(chunk.join(","))}`,
            { signal: controller.signal },
          );
          if (!response.ok) break;
          const data = (await response.json()) as {
            statuses?: Record<string, string>;
            follow?: string[];
          };
          Object.assign(statuses, data?.statuses ?? {});
          for (const id of data?.follow ?? []) follow.push(id);
        }
      } catch {
        // A failed poll answers nothing for any id, which `classifyWatchedTasks`
        // reads as "still working" — never as finished. The next tick asks
        // again; the deadlines are what bound a server that stays down.
      }
      if (cancelled) return;

      const now = Date.now();
      const expired = new Set(ids.filter((id) => now > (deadlines.get(id) ?? Infinity)));
      const { settled, working, alive } = classifyWatchedTasks(ids, statuses, expired);
      // Seen alive ⇒ the row exists and is working, so the silence bound does
      // not apply to it. A task stuck running is ended by the task reaper, not
      // by this page guessing.
      for (const id of alive) deadlines.set(id, now + MAX_SILENT_WATCH_MS);

      const fresh = settled.filter((id) => !reportedRef.current.has(id));
      for (const id of fresh) reportedRef.current.add(id);
      const newFollow = [...new Set(follow)].filter((id) => !watched.has(id));
      if (fresh.length > 0 || newFollow.length > 0) {
        onUpdateRef.current({ settled: fresh, follow: newFollow });
      }
      // The caller's state change restarts this effect with the smaller set; if
      // it kept everything, `working` is what is left to ask about.
      if (working.length === 0 && newFollow.length === 0) return;
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
