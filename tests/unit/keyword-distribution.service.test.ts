import { describe, it, expect } from "vitest";
import {
  computeItemsPerBatch,
  estimateDistributionCost,
  buildItemSnippet,
  chunkItems,
  buildDistributionPrompt,
  parseDistributionResponse,
  mergeBatchResults,
  DEFAULT_ITEMS_PER_BATCH,
  SNIPPET_MAX_CHARS,
  type DistributionSuggestion,
} from "~/services/seo/keyword-distribution.service";

describe("computeItemsPerBatch", () => {
  it("uses the default batch size for a typical keyword count", () => {
    expect(computeItemsPerBatch(100)).toBe(DEFAULT_ITEMS_PER_BATCH);
  });

  it("shrinks (but never below 3) when the keyword list is huge", () => {
    // 12k keywords × 8 tokens ≈ 96k — barely any room for items.
    const perBatch = computeItemsPerBatch(12_000);
    expect(perBatch).toBeLessThan(DEFAULT_ITEMS_PER_BATCH);
    expect(perBatch).toBeGreaterThanOrEqual(3);
  });
});

describe("estimateDistributionCost", () => {
  it("includes OUTPUT tokens in the estimate (they dominate this task)", () => {
    // Plan §5.5 reference: 200 products / 100 keywords ≈ 14 batches ≈ ~60¢.
    const est = estimateDistributionCost(100, 200);
    expect(est.batches).toBe(Math.ceil(200 / DEFAULT_ITEMS_PER_BATCH));
    expect(est.outputTokens).toBe(200 * 100);
    // Output share alone is $0.30 — an input-only formula would sit at ~$0.25.
    expect(est.usd).toBeGreaterThan(0.5);
    expect(est.usd).toBeLessThan(1);
  });

  it("returns zeros for an empty target set", () => {
    expect(estimateDistributionCost(100, 0)).toEqual({ batches: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
  });
});

describe("buildItemSnippet / chunkItems", () => {
  it("strips HTML, collapses whitespace and truncates", () => {
    const long = `<p>${"word ".repeat(1000)}</p>`;
    const snippet = buildItemSnippet(long);
    expect(snippet.length).toBe(SNIPPET_MAX_CHARS);
    expect(snippet).not.toContain("<p>");
  });

  it("chunks preserve order and cover every item", () => {
    const chunks = chunkItems([1, 2, 3, 4, 5], 2);
    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("buildDistributionPrompt", () => {
  it("lists every keyword with attributes and every item with id", () => {
    const prompt = buildDistributionPrompt(
      [{ keyword: "green vase", locale: "", priority: 1, intent: "transactional" }],
      [{ id: "gid://shopify/Product/1", title: "Green Vase", snippet: "A vase." }],
      { maxSecondariesPerItem: 3 },
    );
    expect(prompt).toContain('"green vase" (priority=1, intent=transactional)');
    expect(prompt).toContain("ITEM id=gid://shopify/Product/1");
    expect(prompt).toContain("AT MOST ONE primary item in this batch");
    expect(prompt).toContain("up to 3 additional");
  });
});

describe("parseDistributionResponse", () => {
  const keywords = new Set(["green vase", "blue vase"]);
  const items = new Set(["gid://shopify/Product/1", "gid://shopify/Product/2"]);

  it("parses a clean JSON array", () => {
    const raw = JSON.stringify([
      {
        keyword: "green vase",
        primaryItemId: "gid://shopify/Product/1",
        secondaryItemIds: ["gid://shopify/Product/2"],
        confidence: 0.8,
        rationale: "fits",
      },
    ]);
    const out = parseDistributionResponse(raw, keywords, items);
    expect(out).toHaveLength(1);
    expect(out[0].primaryItemId).toBe("gid://shopify/Product/1");
  });

  it("tolerates markdown fences and surrounding prose", () => {
    const raw =
      'Here you go:\n```json\n[{"keyword":"green vase","primaryItemId":"gid://shopify/Product/1","secondaryItemIds":[],"confidence":0.9,"rationale":"x"}]\n```\nDone!';
    expect(parseDistributionResponse(raw, keywords, items)).toHaveLength(1);
  });

  it("drops invented item ids, unknown keywords and duplicate rows; clamps confidence", () => {
    const raw = JSON.stringify([
      { keyword: "green vase", primaryItemId: "gid://shopify/Product/999", secondaryItemIds: [], confidence: 5, rationale: "" },
      { keyword: "green vase", primaryItemId: "gid://shopify/Product/1", secondaryItemIds: [], confidence: 0.5, rationale: "" },
      { keyword: "not in group", primaryItemId: "gid://shopify/Product/1", secondaryItemIds: [], confidence: 0.5, rationale: "" },
    ]);
    const out = parseDistributionResponse(raw, keywords, items);
    expect(out).toHaveLength(1); // dupe + unknown keyword dropped
    expect(out[0].primaryItemId).toBeNull(); // invented id nulled
    expect(out[0].confidence).toBe(1); // clamped
  });

  it("never lets the primary double as its own secondary", () => {
    const raw = JSON.stringify([
      {
        keyword: "green vase",
        primaryItemId: "gid://shopify/Product/1",
        secondaryItemIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
        confidence: 0.7,
        rationale: "",
      },
    ]);
    const out = parseDistributionResponse(raw, keywords, items);
    expect(out[0].secondaryItemIds).toEqual(["gid://shopify/Product/2"]);
  });

  it("returns [] for garbage", () => {
    expect(parseDistributionResponse("not json at all", keywords, items)).toEqual([]);
    expect(parseDistributionResponse('{"an":"object"}', keywords, items)).toEqual([]);
  });
});

describe("mergeBatchResults", () => {
  const s = (
    keyword: string,
    primaryItemId: string | null,
    confidence: number,
    secondaryItemIds: string[] = [],
  ): DistributionSuggestion => ({ keyword, primaryItemId, secondaryItemIds, confidence, rationale: `r-${confidence}` });

  it("keeps the highest-confidence primary and demotes the loser to FIRST secondary", () => {
    const merged = mergeBatchResults(
      [[s("green vase", "p1", 0.6, ["p3"])], [s("green vase", "p2", 0.9, ["p4"])]],
      3,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].primaryItemId).toBe("p2");
    expect(merged[0].secondaryItemIds[0]).toBe("p1"); // demoted primary first
    expect(merged[0].secondaryItemIds).toContain("p4");
    expect(merged[0].confidence).toBe(0.9);
  });

  it("a real primary beats a null primary regardless of confidence", () => {
    const merged = mergeBatchResults(
      [[s("green vase", null, 0.95)], [s("green vase", "p1", 0.4)]],
      3,
    );
    expect(merged[0].primaryItemId).toBe("p1");
  });

  it("caps merged secondaries and dedupes them", () => {
    const merged = mergeBatchResults(
      [
        [s("green vase", "p1", 0.5, ["s1", "s2"])],
        [s("green vase", "p2", 0.8, ["s2", "s3", "s4", "s5"])],
      ],
      3,
    );
    expect(merged[0].secondaryItemIds).toHaveLength(3);
    expect(new Set(merged[0].secondaryItemIds).size).toBe(3);
  });

  it("keywords from different batches pass through untouched", () => {
    const merged = mergeBatchResults([[s("green vase", "p1", 0.7)], [s("blue vase", "p2", 0.6)]], 3);
    expect(merged).toHaveLength(2);
  });
});
