import { describe, it, expect } from "vitest";
import { buildIntentPrompt, parseIntentResponse } from "~/services/seo/keyword-intent.service";
import { findCannibalizationConflicts, type KeywordAssignmentRow } from "~/services/seo/keywords.service";

describe("buildIntentPrompt", () => {
  it("lists every keyword and demands a JSON-only answer", () => {
    const prompt = buildIntentPrompt(["green vase", "how to clean a vase"]);
    expect(prompt).toContain('- "green vase"');
    expect(prompt).toContain('- "how to clean a vase"');
    expect(prompt).toContain("ONLY a JSON array");
  });
});

describe("parseIntentResponse", () => {
  const valid = new Set(["green vase", "buy vase"]);

  it("maps valid entries, tolerating fences and prose", () => {
    const raw =
      'Sure:\n```json\n[{"keyword":"green vase","intent":"commercial"},{"keyword":"buy vase","intent":"transactional"}]\n```';
    const out = parseIntentResponse(raw, valid);
    expect(out.get("green vase")).toBe("commercial");
    expect(out.get("buy vase")).toBe("transactional");
  });

  it("drops unknown keywords, invalid intents and duplicate entries", () => {
    const raw = JSON.stringify([
      { keyword: "green vase", intent: "buying" }, // invalid intent
      { keyword: "green vase", intent: "commercial" }, // first VALID entry wins
      { keyword: "green vase", intent: "informational" }, // duplicate — ignored
      { keyword: "unknown", intent: "commercial" }, // not in the batch
    ]);
    const out = parseIntentResponse(raw, valid);
    expect(out.size).toBe(1);
    expect(out.get("green vase")).toBe("commercial");
  });

  it("returns an empty map for garbage", () => {
    expect(parseIntentResponse("nope", valid).size).toBe(0);
    expect(parseIntentResponse('{"an":"object"}', valid).size).toBe(0);
  });
});

describe("findCannibalizationConflicts", () => {
  const row = (
    keywordId: string,
    keyword: string,
    resourceType: string,
    resourceId: string,
    role: "primary" | "secondary",
  ): KeywordAssignmentRow => ({
    id: `${keywordId}:${resourceId}`,
    keywordId,
    resourceType,
    resourceId,
    keyword,
    locale: "",
    role,
    priority: 2,
    intent: null,
    gscPosition: null,
    gscClicks: null,
    gscImpressions: null,
    gscCtr: null,
    updatedAt: new Date(0),
  });

  it("flags the same keyword primary on two items of the SAME type", () => {
    const conflicts = findCannibalizationConflicts([
      row("kw1", "vases", "Product", "p1", "primary"),
      row("kw1", "vases", "Product", "p2", "primary"),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resourceIds.sort()).toEqual(["p1", "p2"]);
  });

  it("does NOT flag Product vs. Collection sharing a primary (plan §7.1)", () => {
    const conflicts = findCannibalizationConflicts([
      row("kw1", "vases", "Product", "p1", "primary"),
      row("kw1", "vases", "Collection", "c1", "primary"),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("ignores secondary assignments entirely", () => {
    const conflicts = findCannibalizationConflicts([
      row("kw1", "vases", "Product", "p1", "primary"),
      row("kw1", "vases", "Product", "p2", "secondary"),
    ]);
    expect(conflicts).toEqual([]);
  });
});
