/**
 * Unit tests — when a page watching its save's background work stops watching.
 *
 * The rule this pins is the one the merchant feels: the bulk editor reloads its
 * DISPLAY once the detached auto-translation runs of a save are done, and it
 * must stop polling by itself. Every way of getting it wrong that this file
 * names ended the watch EARLY, against a run that had written nothing — i.e.
 * left the grid showing the empty foreign cells the whole path exists to fill.
 */

import { describe, it, expect } from "vitest";
import {
  unfinishedTaskIds,
  TERMINAL_TASK_STATUSES,
  MISSING_TASK_STATUS,
} from "../../app/hooks/useBackgroundTaskRefresh";

describe("unfinishedTaskIds", () => {
  it("keeps watching a task that is still working", () => {
    expect(unfinishedTaskIds(["a", "b"], { a: "running", b: "queued" })).toEqual(["a", "b"]);
  });

  it("stops once every id reached a terminal state", () => {
    for (const status of TERMINAL_TASK_STATUSES) {
      expect(unfinishedTaskIds(["a"], { a: status })).toEqual([]);
    }
  });

  it("a task whose row does not exist yet is NOT finished", () => {
    // A repair run is spawned and not awaited, and runs for the same resource
    // are serial (one in-flight key) — all three repair surfaces of a
    // bulk-edited product, and anything left over from an earlier save. So a
    // row legitimately appears minutes after the save that reported its id.
    // Reading that gap as "done" refreshes the grid before a single
    // translation is written.
    expect(unfinishedTaskIds(["a"], { a: MISSING_TASK_STATUS })).toEqual(["a"]);
  });

  it("a poll that answered NOTHING is not an answer", () => {
    // A failed request, a 500, a truncated response: the id is simply absent
    // from the map, which says nothing about the task. One transient failure
    // must never be able to end the watch.
    expect(unfinishedTaskIds(["a"], {})).toEqual(["a"]);
  });

  it("waits for the slowest id, not the first", () => {
    expect(unfinishedTaskIds(["a", "b"], { a: "completed", b: "running" })).toEqual(["b"]);
    expect(unfinishedTaskIds(["a", "b"], { a: "completed", b: MISSING_TASK_STATUS })).toEqual(["b"]);
  });

  it("an EXPIRED id stops holding the reload back for the ids that finished", () => {
    // A deadline is per id and stamped when it is first watched, so a task
    // whose row never appears (`startFailed`: the run threw before
    // `db.task.create`) ages out on its own. Without that it blocked the
    // all-or-nothing refresh for every sibling that really did finish — the
    // empty foreign cell again, with a poll running for the whole session.
    expect(
      unfinishedTaskIds(["a", "b"], { a: "completed", b: MISSING_TASK_STATUS }, new Set(["b"])),
    ).toEqual([]);
  });

  it("expiry is not contagious — a live sibling keeps the watch running", () => {
    expect(
      unfinishedTaskIds(["a", "b"], { a: "running", b: MISSING_TASK_STATUS }, new Set(["b"])),
    ).toEqual(["a"]);
  });

  it("counts a run that ended with errors as ended", () => {
    // `completed_with_errors` is what a run reports when Shopify confirmed the
    // translation but the local mirror refused it. The rows it DID write are
    // worth showing, and the run is not coming back.
    expect(unfinishedTaskIds(["a"], { a: "completed_with_errors" })).toEqual([]);
  });
});
