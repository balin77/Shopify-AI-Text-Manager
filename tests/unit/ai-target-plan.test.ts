import { describe, it, expect } from "vitest";
import { planTypeOfGid, targetPlanTypes, firstGatedTarget, partitionItemsByPlan } from "../../app/utils/ai-target-plan";

describe("ai-target-plan", () => {
  it("maps GIDs to plan content types and ignores unknown ids", () => {
    expect(planTypeOfGid("gid://shopify/Page/1")).toBe("pages");
    expect(planTypeOfGid("gid://shopify/Article/1")).toBe("articles");
    expect(planTypeOfGid("gid://shopify/ShopPolicy/1")).toBe("policies");
    expect(planTypeOfGid("group_abc")).toBeNull();
    expect(planTypeOfGid("unknown")).toBeNull();
  });

  it("reads targets from the payload", () => {
    const get = (m: Record<string, string>) => (k: string) => m[k] ?? "";
    expect(targetPlanTypes("seoBulkFix", get({ itemType: "page", itemId: "gid://shopify/Page/1" }))).toEqual(["pages"]);
    expect(targetPlanTypes("distributeKeywords", get({ targetType: "Article" }))).toEqual(["articles"]);
  });

  it("a lower plan is gated for pages/articles, not for products", () => {
    expect(firstGatedTarget("free", ["products"])).toBeNull();
    expect(firstGatedTarget("free", ["products", "pages"])).toBe("pages");
    expect(firstGatedTarget("free", ["articles"])).toBe("articles");
    expect(firstGatedTarget("pro", ["pages", "articles", "policies"])).toBeNull();
  });

  it("a mixed batch runs the allowed items and reports the gated ones", () => {
    const items = [
      { type: "product", id: "1" },
      { type: "page", id: "2" },
      { type: "article", id: "3" },
      { type: "collection", id: "4" },
    ];
    const { allowed, gated } = partitionItemsByPlan("free", items);
    expect(allowed.map((i) => i.id)).toEqual(["1", "4"]);
    expect(gated.map((i) => i.id)).toEqual(["2", "3"]);
    expect(partitionItemsByPlan("max", items).gated).toEqual([]);
  });
});
