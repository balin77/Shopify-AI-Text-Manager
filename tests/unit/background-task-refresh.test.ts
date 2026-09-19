/**
 * Unit tests — when a page watching its save's background work stops watching.
 *
 * The rule this pins is the one the merchant feels: the bulk editor reloads its
 * DISPLAY once the detached auto-translation runs of a save are done, and it
 * must stop polling by itself. "Missing" and "no answer" are the two ways the
 * decision can go wrong in opposite directions — reading either as finished
 * ends the watch before the translation lands (the defect this exists to fix),
 * and reading them as pending forever is a page that never stops asking.
 */

import { describe, it, expect } from "vitest";
import {
  unfinishedTaskIds,
  TERMINAL_TASK_STATUSES,
  MISSING_TASK_STATUS,
} from "../../app/hooks/useBackgroundTaskRefresh";

describe("unfinishedTaskIds", () => {
  it("keeps watching a task that is still working", () => {
    expect(unfinishedTaskIds(["a", "b"], { a: "running", b: "queued" }, true)).toEqual(["a", "b"]);
  });

  it("stops once every id reached a terminal state", () => {
    for (const status of TERMINAL_TASK_STATUSES) {
      expect(unfinishedTaskIds(["a"], { a: status }, true)).toEqual([]);
    }
  });

  it("a task whose row does not exist YET is not finished", () => {
    // The repair run is spawned and not awaited, and one queued behind another
    // for the same resource creates its Task row only when it starts. Reading
    // that gap as "done" refreshes the grid before a single translation is
    // written — i.e. exactly the empty cells this whole path exists to fill.
    expect(unfinishedTaskIds(["a"], { a: MISSING_TASK_STATUS }, true)).toEqual(["a"]);
  });

  it("…but the grace ends, or the page would poll for a run that never started", () => {
    expect(unfinishedTaskIds(["a"], { a: MISSING_TASK_STATUS }, false)).toEqual([]);
  });

  it("keeps a missing task past its grace while a SIBLING is still working", () => {
    // The repair runs of one bulk-edited row share a `resourceId`, so they
    // share an in-flight key and run strictly one after another: the second
    // one's Task row does not exist until the first has finished. Giving up on
    // it because a clock ran out ends the watch with its translations still
    // unwritten — the empty cells this whole path exists to fill.
    expect(unfinishedTaskIds(["a", "b"], { a: "running", b: MISSING_TASK_STATUS }, false)).toEqual([
      "a",
      "b",
    ]);
  });

  it("a poll that answered NOTHING is not an answer, at any point in the grace", () => {
    // A failed request, a 500, a truncated response: the id is simply absent
    // from the map. `missing` is a real answer from a healthy poll and its
    // grace may expire; a non-answer's never may, or one transient failure
    // after 90 seconds would end the watch for good.
    expect(unfinishedTaskIds(["a"], {}, true)).toEqual(["a"]);
    expect(unfinishedTaskIds(["a"], {}, false)).toEqual(["a"]);
  });

  it("an unanswered id also keeps a missing sibling alive", () => {
    expect(unfinishedTaskIds(["a", "b"], { b: MISSING_TASK_STATUS }, false)).toEqual(["a", "b"]);
  });

  it("gives up on missing ids only when nothing else is left to wait for", () => {
    expect(
      unfinishedTaskIds(["a", "b"], { a: "completed", b: MISSING_TASK_STATUS }, false),
    ).toEqual([]);
  });

  it("waits for the slowest id, not the first", () => {
    expect(unfinishedTaskIds(["a", "b"], { a: "completed", b: "running" }, true)).toEqual(["b"]);
  });

  it("counts a run that ended with errors as ended", () => {
    // `completed_with_errors` is what a run reports when Shopify confirmed the
    // translation but the local mirror refused it. The rows it DID write are
    // worth showing, and the run is not coming back.
    expect(unfinishedTaskIds(["a"], { a: "completed_with_errors" }, true)).toEqual([]);
  });
});
