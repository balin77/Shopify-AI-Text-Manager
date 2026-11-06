import { describe, it, expect } from "vitest";
import { step1AnswerResult, FOREIGN_STEP1_DEADLINE_MS } from "~/services/editor/foreign-step1.shared";

describe("step1AnswerResult", () => {
  it("is saved when none of the carried fields is unconfirmed", () => {
    expect(step1AnswerResult(["seoTitle"], new Set())).toBe("saved");
    expect(step1AnswerResult(["seoTitle"], new Set(["title"]))).toBe("saved");
  });
  it("is unconfirmed when a carried field is among the unconfirmed ones", () => {
    expect(step1AnswerResult(["seoTitle"], new Set(["seoTitle"]))).toBe("unconfirmed");
  });
  it("has a finite deadline", () => {
    expect(FOREIGN_STEP1_DEADLINE_MS).toBeGreaterThan(0);
  });
});
