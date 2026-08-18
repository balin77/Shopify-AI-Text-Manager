/**
 * The initial-sync banner's overall percentage.
 *
 * The list of phases lived twice — once as the run order in
 * initial-sync.service.ts, once as a literal in MainNavigation — and the UI's
 * copy went stale. `indexOf` returned -1 for the five phases added later, so a
 * merchant watching an upgrade re-sync saw the TOTAL bar fall back to the
 * phase's own percent: "onlineStoreExtras (0%)", stuck, at the point where the
 * run was actually ~two thirds through.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { SYNC_PHASE_ORDER, overallSyncPercent } from "~/services/sync-phases.shared";

describe("overallSyncPercent", () => {
  it("never reports 0% once a phase after the first has started", () => {
    for (const phase of SYNC_PHASE_ORDER.slice(1)) {
      expect(overallSyncPercent(phase, 0)).toBeGreaterThan(0);
    }
    // The exact regression: 9th of 13 phases, at its own 0%.
    expect(overallSyncPercent("onlineStoreExtras", 0)).toBe(62);
  });

  it("increases monotonically along the run order", () => {
    let previous = -1;
    for (const phase of SYNC_PHASE_ORDER) {
      const start = overallSyncPercent(phase, 0);
      const end = overallSyncPercent(phase, 100);
      // A phase's 100% IS the next phase's 0% — equal, never backwards.
      expect(start).toBeGreaterThanOrEqual(previous);
      expect(end).toBeGreaterThan(start);
      previous = end;
    }
  });

  it("clamps, and treats the terminal markers as such", () => {
    expect(overallSyncPercent("done", 0)).toBe(100);
    expect(overallSyncPercent("products", -5)).toBe(0);
    expect(overallSyncPercent("menus", 500)).toBe(100);
    expect(overallSyncPercent(null, 42)).toBe(42);
    // A progress row written by a different deploy: no position to place it at.
    expect(overallSyncPercent("somethingNew", 42)).toBe(42);
  });
});

describe("SYNC_PHASE_ORDER vs. the service", () => {
  // The emit() signature already makes an UNREGISTERED phase a compile error.
  // What it cannot check is the ORDER: a phase inserted in the middle of the
  // service without moving it in the list makes the total bar jump backwards.
  it("lists the phases in the order runInitialFullSync emits them", () => {
    const source = readFileSync(
      resolve(__dirname, "../../app/services/initial-sync.service.ts"),
      "utf-8",
    );
    const emitted: string[] = [];
    for (const [, phase] of source.matchAll(/\bemit\('([A-Za-z]+)'/g)) {
      if (phase === "done" || phase === "error") continue;
      if (!emitted.includes(phase)) emitted.push(phase);
    }
    expect(emitted).toEqual([...SYNC_PHASE_ORDER]);
  });
});
