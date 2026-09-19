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

  it("a poll that answered nothing at all is not evidence either", () => {
    // A failed request, a 500, a truncated response: the id is simply absent
    // from the map. That is the same non-answer as `missing` and must never be
    // read as a terminal status.
    expect(unfinishedTaskIds(["a"], {}, true)).toEqual(["a"]);
    expect(unfinishedTaskIds(["a"], {}, false)).toEqual([]);
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
