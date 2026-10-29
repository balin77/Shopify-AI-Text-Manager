import { describe, it, expect } from "vitest";
import { parseLastRunOutcome, isRecentRun, latestFinishedRun, runFinishedAt, LAST_RUN_BANNER_WINDOW_MS } from "../../app/services/seo/internal-links-query";

// The internal-links page reports the latest finished run, so "Generieren"
// always ends in an answer — a run that found nothing or failed used to leave
// the page unchanged with no reason given.
describe("parseLastRunOutcome", () => {
  it("is null without a finished run", () => {
    expect(parseLastRunOutcome(null)).toBeNull();
    expect(parseLastRunOutcome({ status: "running", result: null, error: null })).toBeNull();
  });

  it("reads the runner's summary", () => {
    expect(
      parseLastRunOutcome({
        status: "completed",
        result: JSON.stringify({ created: 4, updated: 1, sourcesScanned: 37, targetsConsidered: 9 }),
        error: null,
      }),
    ).toEqual({ status: "completed", created: 4, updated: 1, sourcesScanned: 37 });
  });

  it("reports a run that found nothing as zero, not as missing", () => {
    expect(parseLastRunOutcome({ status: "completed", result: "{}", error: null })).toEqual({
      status: "completed",
      created: 0,
      updated: 0,
      sourcesScanned: 0,
    });
  });

  it("carries a failure's text", () => {
    expect(parseLastRunOutcome({ status: "failed", result: null, error: " boom " })).toEqual({
      status: "failed",
      error: "boom",
    });
  });

  it("does not guess from an unreadable summary", () => {
    expect(parseLastRunOutcome({ status: "completed", result: "{not json", error: null })).toBeNull();
  });
});

// A weeks-old failure must not keep the page red for good: the outcome
// banners show on their own only for a run that finished recently.
describe("isRecentRun", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");

  it("is false without a run or a finish time", () => {
    expect(isRecentRun(null, now)).toBe(false);
    expect(isRecentRun({ completedAt: null, updatedAt: null }, now)).toBe(false);
  });

  it("is true inside the window and false past it", () => {
    expect(isRecentRun({ completedAt: new Date(now - 60_000) }, now)).toBe(true);
    expect(isRecentRun({ completedAt: new Date(now - LAST_RUN_BANNER_WINDOW_MS - 1) }, now)).toBe(false);
  });

  it("falls back to updatedAt for a row closed without completedAt", () => {
    expect(isRecentRun({ completedAt: null, updatedAt: new Date(now - 1000) }, now)).toBe(true);
    expect(isRecentRun({ completedAt: null, updatedAt: new Date(now - 30 * 86_400_000) }, now)).toBe(false);
  });
});

// Postgres sorts NULLs FIRST on `completedAt desc`, so a failed run a reaper
// closed without `completedAt` used to hide every newer run. The loader now
// fetches the newest stamped and the newest unstamped row and picks between
// them by the same finish time `isRecentRun` judges.
describe("latestFinishedRun", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");

  it("prefers a newer stamped run over an old unstamped failure", () => {
    const stamped = { id: "new", completedAt: new Date(now - 60_000), updatedAt: new Date(now - 60_000) };
    const unstamped = { id: "old", completedAt: null, updatedAt: new Date(now - 30 * 86_400_000) };
    expect(latestFinishedRun([stamped, unstamped])?.id).toBe("new");
  });

  it("prefers a newer unstamped run over an older stamped one", () => {
    const stamped = { id: "old", completedAt: new Date(now - 86_400_000), updatedAt: new Date(now - 86_400_000) };
    const unstamped = { id: "new", completedAt: null, updatedAt: new Date(now - 1000) };
    expect(latestFinishedRun([stamped, unstamped])?.id).toBe("new");
  });

  it("takes whichever exists, and nothing when neither does", () => {
    const only = { id: "x", completedAt: null, updatedAt: new Date(now) };
    expect(latestFinishedRun([null, only])?.id).toBe("x");
    expect(latestFinishedRun([only, undefined])?.id).toBe("x");
    expect(latestFinishedRun([null, null])).toBeNull();
  });

  it("reports the same finish time isRecentRun judges", () => {
    expect(runFinishedAt({ completedAt: null, updatedAt: new Date(now) })).toBe(now);
    expect(runFinishedAt({ completedAt: new Date(now - 5), updatedAt: new Date(now) })).toBe(now - 5);
    expect(runFinishedAt({ completedAt: new Date(NaN), updatedAt: null })).toBeNull();
    expect(runFinishedAt(null)).toBeNull();
  });
});
