/**
 * The pure half of the background-task watch: the statuses, the id cap and the
 * rule that decides which watched ids are finished with.
 *
 * It lives in a `.shared.ts` and not in the React hook because BOTH ends read
 * it — `useBackgroundTaskRefresh` in the browser and `/api/task-status` on the
 * server, which caps its answer with the same constant the client chunks by, so
 * the two cannot disagree. IMPORT-FREE on purpose (the same note
 * `markup-activation.shared.ts` carries): a module in this position is pulled
 * into the client bundle by one end and into the server graph by the other, and
 * a single server-only import here breaks a build that neither typecheck nor
 * vitest would fail.
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

/** How often the watch asks. */
export const POLL_INTERVAL_MS = 5_000;

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
export const MAX_SILENT_WATCH_MS = 5 * 60_000;

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
  /**
   * "Some OTHER translation run of this shop is still going" — evidence from
   * outside the watched set, reported by the loader.
   *
   * It is load-bearing, not a nicety. Repairs for one resource share an
   * in-flight key and run strictly one after another, and the queue is shared
   * with the SYNC-side reconciliation: a `products/update` run for the same
   * product (an admin edit, an importer, a save whose watch died with a page
   * reload) can be holding the queue. Our run is then chained behind it and has
   * created no row at all, so nothing in the watched set is alive, nothing gets
   * re-stamped, and the deadline ends the watch before a single translation is
   * written — the empty cell this whole mechanism exists to remove, reached
   * from a third direction.
   */
  othersAlive = false,
): { settled: string[]; working: string[]; alive: string[]; restamp: string[] } {
  const settled: string[] = [];
  const working: string[] = [];
  /** The row EXISTS and has not finished — evidence, not a guess. */
  const alive: string[] = [];
  /**
   * A live SIBLING is evidence too, and it is the difference between the two
   * things a `missing` id can be. Repairs for one resource share an in-flight
   * key and run strictly one after another, so while any watched task is
   * running, an id with no row yet is most likely QUEUED behind it — giving up
   * on it there drops a run that has not started, which is the empty cell this
   * exists to remove. Only when nothing at all is alive does a deadline that
   * has run out mean what it is for: a run that never created its row.
   */
  const anyAlive =
    othersAlive ||
    ids.some((id) => {
      const status = statuses[id];
      return (
        status !== undefined &&
        status !== MISSING_TASK_STATUS &&
        !TERMINAL_TASK_STATUSES.has(status)
      );
    });
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
    if (expired.has(id) && !anyAlive) settled.push(id);
    else working.push(id);
  }
  // The silence clock only TICKS while nothing is alive. Stamping just the
  // live ids leaves a queued one on its original deadline, so it settles in
  // the very poll its predecessor goes terminal — which is the poll its own
  // run starts. Three serial repair groups of one product lost two of them
  // that way, on exactly the shops whose first run is slow enough to matter.
  const restamp = anyAlive ? working : [];
  return { settled, working, alive, restamp };
}
