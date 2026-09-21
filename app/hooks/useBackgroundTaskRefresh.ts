import { useEffect, useRef } from "react";
import {
  MAX_TASK_STATUS_IDS,
  POLL_INTERVAL_MS,
  MAX_SILENT_WATCH_MS,
  classifyWatchedTasks,
  type TaskWatchUpdate,
} from "../services/tasks/task-watch.shared";

export {
  MAX_TASK_STATUS_IDS,
  MISSING_TASK_STATUS,
  TERMINAL_TASK_STATUSES,
  classifyWatchedTasks,
  type TaskWatchUpdate,
} from "../services/tasks/task-watch.shared";

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
 *
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
  // In an EFFECT, never during render: an abandoned render under concurrent
  // rendering would otherwise write the ref. The poll first fires a tick
  // later, so the committed callback is always the one in hand.
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

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
      /** Some other translation run of this shop is going — see the shared
       *  module's `othersAlive`. A poll that failed answers `false`, which only
       *  means "no evidence", and the deadline is what that bounds. */
      let othersAlive = false;
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
            othersAlive?: boolean;
          };
          Object.assign(statuses, data?.statuses ?? {});
          for (const id of data?.follow ?? []) follow.push(id);
          if (data?.othersAlive) othersAlive = true;
        }
      } catch {
        // A failed poll answers nothing for any id, which `classifyWatchedTasks`
        // reads as "still working" — never as finished. The next tick asks
        // again; the deadlines are what bound a server that stays down.
      }
      if (cancelled) return;

      const now = Date.now();
      const expired = new Set(ids.filter((id) => now > (deadlines.get(id) ?? Infinity)));
      const { settled, working, restamp } = classifyWatchedTasks(ids, statuses, expired, othersAlive);
      // Something is alive ⇒ this page's work is progressing, so the silence
      // bound does not apply to anything still being waited for. A task stuck
      // running is ended by the task reaper, not by this page guessing.
      for (const id of restamp) deadlines.set(id, now + MAX_SILENT_WATCH_MS);

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
