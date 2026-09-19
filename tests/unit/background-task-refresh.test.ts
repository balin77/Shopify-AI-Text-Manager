/**
 * Unit tests — when a page watching its own background work stops watching,
 * and what it reports while it does.
 *
 * The rule this pins is the one the merchant feels: the bulk editor reloads its
 * DISPLAY as the detached auto-translation runs of a save finish, and it must
 * stop polling by itself. Almost every way of getting it wrong that this file
 * names ended a wait EARLY, against a run that had written nothing — i.e. left
 * the grid showing the empty foreign cells the whole path exists to fill.
 */

import { describe, it, expect } from "vitest";
import {
  classifyWatchedTasks,
  TERMINAL_TASK_STATUSES,
  MISSING_TASK_STATUS,
} from "../../app/hooks/useBackgroundTaskRefresh";

describe("classifyWatchedTasks", () => {
  it("keeps watching a task that is still working", () => {
    const { settled, working } = classifyWatchedTasks(["a", "b"], { a: "running", b: "queued" });
    expect(settled).toEqual([]);
    expect(working).toEqual(["a", "b"]);
  });

  it("settles an id the moment it reaches a terminal state", () => {
    for (const status of TERMINAL_TASK_STATUSES) {
      expect(classifyWatchedTasks(["a"], { a: status }).settled).toEqual(["a"]);
    }
  });

  it("reports each id on its own, never waiting for the slowest", () => {
    // A save starts up to MAX_REPAIR_GROUPS runs of very different lengths.
    // Holding the reload until the last one ends leaves the grid showing empty
    // cells for translations that landed minutes ago.
    const { settled, working } = classifyWatchedTasks(["a", "b"], { a: "completed", b: "running" });
    expect(settled).toEqual(["a"]);
    expect(working).toEqual(["b"]);
  });

  it("a task whose row does not exist yet is NOT finished", () => {
    // A repair run is spawned and not awaited, and runs for one resource are
    // serial (one in-flight key) — all three repair surfaces of a bulk-edited
    // product, and anything left over from an earlier save. So a row
    // legitimately appears minutes after the save that reported its id.
    const { settled, working } = classifyWatchedTasks(["a"], { a: MISSING_TASK_STATUS });
    expect(settled).toEqual([]);
    expect(working).toEqual(["a"]);
  });

  it("a poll that answered NOTHING is not an answer", () => {
    // A failed request, a 500, a truncated response: the id is simply absent
    // from the map, which says nothing about the task. One transient failure
    // must never be able to end a wait.
    expect(classifyWatchedTasks(["a"], {}).settled).toEqual([]);
  });

  it("counts a run that ended with errors as ended", () => {
    // `completed_with_errors` is what a run reports when Shopify confirmed the
    // translation but the local mirror refused it. The rows it DID write are
    // worth showing, and the run is not coming back.
    expect(classifyWatchedTasks(["a"], { a: "completed_with_errors" }).settled).toEqual(["a"]);
  });

  it("an EXPIRED id settles once nothing is alive, so it cannot block forever", () => {
    // The deadline bounds the ONE case with no evidence at all: a run that
    // never created its row (`startFailed` — it threw before `db.task.create`).
    const { settled, working } = classifyWatchedTasks(
      ["a", "b"],
      { a: "completed", b: MISSING_TASK_STATUS },
      new Set(["b"]),
    );
    expect(settled).toEqual(["a", "b"]);
    expect(working).toEqual([]);
  });

  it("…but a LIVE sibling keeps an expired missing id in the watch", () => {
    // Repairs for one resource share an in-flight key and run strictly one
    // after another, so while any watched task is running an id with no row
    // yet is most likely QUEUED behind it. On a ten-locale shop the first two
    // runs can outlast any fixed bound; expiring the third there drops a run
    // that has not even started — the empty cell this exists to remove.
    const { settled, working } = classifyWatchedTasks(
      ["a", "b"],
      { a: "running", b: MISSING_TASK_STATUS },
      new Set(["b"]),
    );
    expect(settled).toEqual([]);
    expect(working).toEqual(["a", "b"]);
  });

  it("does not expire an id this very poll reports RUNNING", () => {
    // The deadline is for an id we have no evidence about. An expired one that
    // then answers `running` is a task we can see registering translations —
    // settling it there would drop it mid-run, which is the miss this whole
    // hook exists to prevent.
    const { settled, working } = classifyWatchedTasks(["a"], { a: "running" }, new Set(["a"]));
    expect(settled).toEqual([]);
    expect(working).toEqual(["a"]);
  });

  it("reports a row that EXISTS and is working as alive", () => {
    // Seen alive is evidence, not a guess, and it is what refreshes the
    // deadline: a queue of serial repair runs can legitimately outlast any
    // fixed bound, and expiring against a task we can see running would drop
    // it while it was still registering translations.
    const { alive } = classifyWatchedTasks(
      ["a", "b", "c", "d"],
      { a: "running", b: "queued", c: MISSING_TASK_STATUS, d: "completed" },
    );
    expect(alive).toEqual(["a", "b"]);
  });
});
