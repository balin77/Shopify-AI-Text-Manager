import { describe, it, expect } from "vitest";
import { parseLastRunOutcome } from "../../app/services/seo/internal-links-query";

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
