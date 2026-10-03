/**
 * The theme page's translation cache holds the GLOBAL row and each market's
 * override of one key side by side. Every write and read addresses the layer.
 */
import { describe, it, expect } from "vitest";
import {
  applyThemeSaveToRows,
  removeThemeRow,
  themeRowValue,
  upsertThemeRow,
  type ThemeCacheRow,
} from "~/services/theme-translation-cache.shared";

const M = "gid://shopify/Market/5";
const rows = (): ThemeCacheRow[] => [
  { key: "hero.title", value: "Global", locale: "de", marketId: "" },
  { key: "hero.title", value: "Swiss", locale: "de", marketId: M },
  { key: "hero.sub", value: "Nur global", locale: "de" },
];

describe("applyThemeSaveToRows", () => {
  it("a market save changes the market row and leaves the global row alone", () => {
    const out = applyThemeSaveToRows(rows(), { "hero.title": "Swiss 2" }, "de", M);
    expect(out.find((r) => r.key === "hero.title" && r.marketId === M)?.value).toBe("Swiss 2");
    expect(out.find((r) => r.key === "hero.title" && r.marketId === "")?.value).toBe("Global");
  });

  it("a global save changes the global row and leaves the market override alone", () => {
    const out = applyThemeSaveToRows(rows(), { "hero.title": "Global 2" }, "de", "");
    expect(out.find((r) => r.key === "hero.title" && r.marketId === "")?.value).toBe("Global 2");
    expect(out.find((r) => r.key === "hero.title" && r.marketId === M)?.value).toBe("Swiss");
  });

  it("a market save of a key with no market row adds one, global untouched", () => {
    const out = applyThemeSaveToRows(rows(), { "hero.sub": "Swiss sub" }, "de", M);
    expect(out.find((r) => r.key === "hero.sub" && r.marketId === M)?.value).toBe("Swiss sub");
    expect(out.find((r) => r.key === "hero.sub" && (r.marketId ?? "") === "")?.value).toBe("Nur global");
  });

  it("a clear removes only the saved layer's row", () => {
    const marketClear = applyThemeSaveToRows(rows(), { "hero.title": "" }, "de", M);
    expect(marketClear.filter((r) => r.key === "hero.title").map((r) => r.value)).toEqual(["Global"]);
    const globalClear = applyThemeSaveToRows(rows(), { "hero.title": "" }, "de", "");
    expect(globalClear.filter((r) => r.key === "hero.title").map((r) => r.value)).toEqual(["Swiss"]);
  });

  it("does not mutate its input", () => {
    const input = rows();
    applyThemeSaveToRows(input, { "hero.title": "X" }, "de", M);
    expect(input).toEqual(rows());
  });

  it("only the keys the answer names are touched", () => {
    const out = applyThemeSaveToRows(rows(), { "hero.title": "Swiss 2" }, "de", M);
    expect(out.find((r) => r.key === "hero.sub")?.value).toBe("Nur global");
  });
});

describe("upsertThemeRow / removeThemeRow", () => {
  it("address one layer", () => {
    const r = rows();
    upsertThemeRow(r, "hero.title", "S3", "de", M);
    expect(r[0].value).toBe("Global");
    expect(r[1].value).toBe("S3");
    removeThemeRow(r, "hero.title", M);
    expect(r.map((x) => x.value)).toEqual(["Global", "Nur global"]);
  });
});

describe("themeRowValue", () => {
  it("global view reads the global row even when a market row comes first", () => {
    const r: ThemeCacheRow[] = [
      { key: "k", value: "Swiss", marketId: M },
      { key: "k", value: "Global", marketId: "" },
    ];
    expect(themeRowValue(r, "k", "")).toBe("Global");
  });
  it("a market view prefers its own row and falls back to global", () => {
    expect(themeRowValue(rows(), "hero.title", M)).toBe("Swiss");
    expect(themeRowValue(rows(), "hero.sub", M)).toBe("Nur global");
    expect(themeRowValue(undefined, "x", M)).toBe("");
  });
  it("a market-only row is not shown in the global view", () => {
    expect(themeRowValue([{ key: "k", value: "Swiss", marketId: M }], "k", "")).toBe("");
  });
});
