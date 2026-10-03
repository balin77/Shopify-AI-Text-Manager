/**
 * Client half of "every primary purge site reports its confirmed market purge":
 * the theme page's own cache (rowsAfterPrimarySave) and the product sub-resource
 * card (dbPreloadToMap hiding + retirement). Only CONFIRMED purges hide market
 * values; global rows are never touched by the report.
 */
import { describe, it, expect } from "vitest";
import { rowsAfterPrimarySave, type ThemeCacheRow } from "~/services/theme-translation-cache.shared";
import { retirePurgedMarketResources } from "~/services/editor/sub-resource-market-purge.shared";
import { dbPreloadToMap } from "~/hooks/useProductSubResources";

const M = "gid://shopify/Market/5";

describe("rowsAfterPrimarySave (theme cache)", () => {
  const rows = (): ThemeCacheRow[] => [
    { key: "hero.title", value: "Global", locale: "de", marketId: "" },
    { key: "hero.title", value: "Swiss", locale: "de", marketId: M },
    { key: "hero.sub", value: "Sub global", locale: "de", marketId: "" },
    { key: "hero.sub", value: "Sub swiss", locale: "de", marketId: M },
    { key: "footer", value: "Untouched", locale: "de", marketId: M },
  ];

  it("drops the market row of a changed key only where the purge was confirmed", () => {
    const out = rowsAfterPrimarySave(rows(), new Set(["hero.title", "hero.sub"]), ["hero.title"]);
    // hero.title: global row goes (existing invalidation), confirmed market row goes.
    expect(out.some((r) => r.key === "hero.title")).toBe(false);
    // hero.sub: global row goes, the UNCONFIRMED market override stays visible.
    expect(out.filter((r) => r.key === "hero.sub")).toEqual([
      { key: "hero.sub", value: "Sub swiss", locale: "de", marketId: M },
    ]);
    // A key that did not change is never touched.
    expect(out.some((r) => r.key === "footer")).toBe(true);
  });

  it("a purge that was off or not reported hides no market row", () => {
    const out = rowsAfterPrimarySave(rows(), new Set(["hero.title"]), undefined);
    expect(out.filter((r) => r.key === "hero.title").map((r) => r.marketId)).toEqual([M]);
  });

  it("a reported key that did not change drops nothing", () => {
    const out = rowsAfterPrimarySave(rows(), new Set(), ["hero.title"]);
    expect(out).toHaveLength(5);
  });
});

describe("sub-resource market purge hiding", () => {
  const RES = "gid://shopify/Metafield/7";
  const OTHER = "gid://shopify/Metafield/8";
  const rows = () => ({
    [RES]: [
      { key: "value", value: "Global", locale: "fr", marketId: "" },
      { key: "value", value: "Market", locale: "fr", marketId: M },
    ],
    [OTHER]: [{ key: "value", value: "Other market", locale: "fr", marketId: M }],
  });

  it("a purged resource reads its GLOBAL value in the market view; others keep their market value", () => {
    const { map, fallbackResourceIds } = dbPreloadToMap(rows(), "fr", M, new Set([RES]));
    expect(map[RES].value).toBe("Global");
    expect(fallbackResourceIds.has(RES)).toBe(true);
    expect(map[OTHER].value).toBe("Other market");
  });

  it("without a purge report nothing is hidden", () => {
    expect(dbPreloadToMap(rows(), "fr", M).map[RES].value).toBe("Market");
  });

  it("the hide retires once the re-read item no longer carries a market row for it", () => {
    const hidden = new Set([RES, OTHER]);
    retirePurgedMarketResources(hidden, rows());
    // The item still carries both market rows: the marks stay.
    expect([...hidden].sort()).toEqual([OTHER, RES].sort());
    retirePurgedMarketResources(hidden, {
      [RES]: [{ key: "value", value: "Global", locale: "fr", marketId: "" }],
      [OTHER]: [{ key: "value", value: "Other market", locale: "fr", marketId: M }],
    });
    expect([...hidden]).toEqual([OTHER]);
  });
});
