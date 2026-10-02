/**
 * The save bar's Discard during a LANGUAGE / MARKET switch drops only the
 * drafts of the view being left; gallery changes, replacement-media drafts and
 * stock edits survive the switch. A plain Discard click drops everything — also
 * one that follows a CANCELLED switch dialog (the switch never resolves).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  __setViewSwitchClockForTests,
  beginViewSwitch,
  markViewSwitchResolved,
  routeSaveBarDiscard,
  VIEW_SWITCH_GRACE_MS,
} from "~/hooks/view-switch-discard";

let clock = 0;
let timers: Array<{ at: number; fn: () => void }> = [];
const advance = (ms: number) => {
  clock += ms;
  const due = timers.filter((t) => t.at <= clock);
  timers = timers.filter((t) => t.at > clock);
  due.forEach((t) => t.fn());
};

beforeEach(() => {
  clock = 1_000_000;
  timers = [];
  __setViewSwitchClockForTests(
    () => clock,
    (fn, ms) => {
      timers.push({ at: clock + ms, fn });
    },
  );
});
afterEach(() => __setViewSwitchClockForTests());

function parts() {
  return { view: vi.fn(), shared: vi.fn() };
}

describe("routeSaveBarDiscard", () => {
  it("a plain Discard (no switch) discards both halves at once", () => {
    const p = parts();
    routeSaveBarDiscard(p);
    expect(p.view).toHaveBeenCalledTimes(1);
    expect(p.shared).toHaveBeenCalledTimes(1);
  });

  it("the dialog's discard BEFORE the switch resolves keeps the shared drafts", () => {
    const gen = beginViewSwitch();
    const p = parts();
    routeSaveBarDiscard(p);
    expect(p.view).toHaveBeenCalledTimes(1);
    expect(p.shared).not.toHaveBeenCalled();
    markViewSwitchResolved(gen);
    advance(VIEW_SWITCH_GRACE_MS);
    expect(p.shared).not.toHaveBeenCalled();
  });

  it("the dialog's discard AFTER the switch resolved keeps the shared drafts", () => {
    const gen = beginViewSwitch();
    markViewSwitchResolved(gen);
    advance(200);
    const p = parts();
    routeSaveBarDiscard(p);
    expect(p.view).toHaveBeenCalledTimes(1);
    expect(p.shared).not.toHaveBeenCalled();
  });

  it("a Discard click long after a switch discards everything", () => {
    const gen = beginViewSwitch();
    markViewSwitchResolved(gen);
    advance(VIEW_SWITCH_GRACE_MS + 1);
    const p = parts();
    routeSaveBarDiscard(p);
    expect(p.shared).toHaveBeenCalledTimes(1);
  });

  it("a Discard click after a CANCELLED switch dialog still discards the shared drafts (late)", () => {
    beginViewSwitch(); // the merchant chose "stay": never resolves
    const p = parts();
    routeSaveBarDiscard(p);
    expect(p.view).toHaveBeenCalledTimes(1);
    advance(VIEW_SWITCH_GRACE_MS);
    expect(p.shared).toHaveBeenCalledTimes(1);
    // ...and the stale mark is gone: the next Discard is a plain one.
    const q = parts();
    routeSaveBarDiscard(q);
    expect(q.shared).toHaveBeenCalledTimes(1);
  });
});
