/**
 * The image manager's ✨ generate shows a SUGGESTION (Accept / Accept &
 * Translate / Decline) instead of writing and saving at once (owner,
 * 2026-10-03). The pure halves: where a suggestion lives and who sees it, what
 * an accept sends, which refusals stage nothing, and that the translate of
 * "Accept & Translate" only follows a CONFIRMED save.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  altSuggestionKey,
  withAltSuggestion,
  withoutAltSuggestion,
  altSuggestionsOfProduct,
  altSuggestionInView,
  planAcceptAltSuggestion,
  shouldTranslateAfterSave,
} from "~/components/image-manager/alt-suggestion";
import { hasImmediateAltSave } from "~/components/image-manager/alt-draft";

const G1 = "gid://shopify/MediaImage/1";
const G2 = "gid://shopify/MediaImage/2";
const URL1 = "https://cdn/a.jpg?v=1";
const URL2 = "https://cdn/b.jpg?v=1";
const gidOf = (u: string) => (u === URL1 ? G1 : u === URL2 ? G2 : undefined);

const base = {
  url: URL1,
  mediaId: G1,
  suggestion: "A red ceramic vase on a table",
  translate: false,
  isPrimaryLocale: true,
  singleLocale: false,
  aiBusy: false,
  dirtyUrls: [] as string[],
  texts: {} as Record<string, string>,
  gidOf,
  locale: "de",
  productId: "p1",
  productTitle: "Vase",
};

describe("suggestion storage — per (product, language, market, medium)", () => {
  const scope = { productId: "p1", locale: "de", marketId: undefined, mediaId: G1 };

  it("generate stores a suggestion and nothing else: no save is involved", () => {
    const map = withAltSuggestion({}, scope, "Suggested alt");
    expect(altSuggestionInView(map, { productId: "p1", locale: "de" }, G1)).toBe("Suggested alt");
    // Storing is a plain map: there is no queue, no immediate save, no dirty state.
    expect(hasImmediateAltSave(null, [])).toBe(false);
  });

  it("does not leak into another language, market, medium or product", () => {
    const map = withAltSuggestion({}, scope, "Suggested alt");
    expect(altSuggestionInView(map, { productId: "p1", locale: "fr" }, G1)).toBeUndefined();
    expect(altSuggestionInView(map, { productId: "p1", locale: "de", marketId: "gid://shopify/Market/3" }, G1)).toBeUndefined();
    expect(altSuggestionInView(map, { productId: "p1", locale: "de" }, G2)).toBeUndefined();
    expect(altSuggestionInView(map, { productId: "p2", locale: "de" }, G1)).toBeUndefined();
  });

  it("an empty market and an undefined one are the same (global) layer", () => {
    const map = withAltSuggestion({}, { ...scope, marketId: "" }, "x");
    expect(altSuggestionInView(map, { productId: "p1", locale: "de", marketId: undefined }, G1)).toBe("x");
    expect(altSuggestionKey({ ...scope, marketId: "" })).toBe(altSuggestionKey(scope));
  });

  it("a product switch drops every other product's suggestions", () => {
    let map = withAltSuggestion({}, scope, "one");
    map = withAltSuggestion(map, { ...scope, productId: "p2" }, "two");
    const kept = altSuggestionsOfProduct(map, "p2");
    expect(Object.values(kept)).toEqual(["two"]);
    // Nothing to drop: the same object (no re-render).
    expect(altSuggestionsOfProduct(kept, "p2")).toBe(kept);
  });

  it("Decline removes exactly that suggestion; an empty text is no suggestion", () => {
    let map = withAltSuggestion({}, scope, "one");
    map = withAltSuggestion(map, { ...scope, mediaId: G2 }, "two");
    const after = withoutAltSuggestion(map, scope);
    expect(altSuggestionInView(after, { productId: "p1", locale: "de" }, G1)).toBeUndefined();
    expect(altSuggestionInView(after, { productId: "p1", locale: "de" }, G2)).toBe("two");
    expect(withAltSuggestion({}, scope, "   ")).toEqual({});
  });
});

describe("Accept — one immediate save of that medium", () => {
  it("builds exactly one save with the view's language and market, marked immediate", () => {
    const plan = planAcceptAltSuggestion({ ...base, marketId: undefined });
    expect(plan.kind).toBe("save");
    if (plan.kind !== "save") return;
    expect(plan.entry).toMatchObject({
      url: URL1,
      mediaId: G1,
      altText: "A red ceramic vase on a table",
      locale: "de",
      productId: "p1",
      immediate: true,
    });
    expect(plan.entry.thenTranslateAll).toBeUndefined();
    expect(plan.text).toBe("A red ceramic vase on a table");
  });

  it("another image's typed draft is not part of the save", () => {
    const plan = planAcceptAltSuggestion({
      ...base,
      dirtyUrls: [URL2],
      texts: { [URL2]: "typed draft of another image" },
    });
    expect(plan.kind).toBe("save");
    if (plan.kind !== "save") return;
    expect(plan.entry.mediaId).toBe(G1);
    expect(plan.entry.aliases).toBeUndefined();
  });

  it("the accepted text wins over an older draft of the same image", () => {
    const plan = planAcceptAltSuggestion({
      ...base,
      dirtyUrls: [URL1],
      texts: { [URL1]: "older typed draft" },
      editOrder: new Map([[URL1, 7]]),
    });
    expect(plan.kind === "save" && plan.entry.altText).toBe("A red ceramic vase on a table");
  });

  it("the market of the view travels with the save", () => {
    const plan = planAcceptAltSuggestion({ ...base, marketId: "gid://shopify/Market/3" });
    expect(plan.kind === "save" && plan.entry.marketId).toBe("gid://shopify/Market/3");
  });
});

describe("Accept & Translate", () => {
  it("marks the one save; the translate is NOT part of it", () => {
    const plan = planAcceptAltSuggestion({ ...base, translate: true });
    expect(plan.kind).toBe("save");
    if (plan.kind !== "save") return;
    expect(plan.entry.thenTranslateAll).toBe(true);
    expect(plan.entry.immediate).toBe(true);
  });

  it("translates only after a CONFIRMED save", () => {
    const plan = planAcceptAltSuggestion({ ...base, translate: true });
    if (plan.kind !== "save") throw new Error("expected a save");
    expect(shouldTranslateAfterSave(plan.entry, "saved", "p1")).toBe(true);
  });

  it("a failed save translates nothing — whatever kind of failure", () => {
    const plan = planAcceptAltSuggestion({ ...base, translate: true });
    if (plan.kind !== "save") throw new Error("expected a save");
    for (const kind of ["failed", "noPrimary", "refused"]) {
      expect(shouldTranslateAfterSave(plan.entry, kind, "p1")).toBe(false);
    }
  });

  it("a plain Accept never translates, and a product switch cancels the translate", () => {
    const plain = planAcceptAltSuggestion({ ...base });
    const marked = planAcceptAltSuggestion({ ...base, translate: true });
    if (plain.kind !== "save" || marked.kind !== "save") throw new Error("expected saves");
    expect(shouldTranslateAfterSave(plain.entry, "saved", "p1")).toBe(false);
    expect(shouldTranslateAfterSave(marked.entry, "saved", "p2")).toBe(false);
  });

  it("is refused outside the primary language", () => {
    expect(planAcceptAltSuggestion({ ...base, translate: true, isPrimaryLocale: false })).toEqual({
      kind: "refused",
      reason: "translateNeedsPrimary",
    });
    // A plain Accept is still fine there.
    expect(planAcceptAltSuggestion({ ...base, isPrimaryLocale: false }).kind).toBe("save");
  });

  it("is refused in a single-language shop; a plain Accept is not", () => {
    expect(planAcceptAltSuggestion({ ...base, translate: true, singleLocale: true })).toEqual({
      kind: "refused",
      reason: "singleLanguage",
    });
    expect(planAcceptAltSuggestion({ ...base, singleLocale: true }).kind).toBe("save");
  });
});

describe("refusals stage nothing", () => {
  it("no suggestion, no media id (unsaved upload), or a running AI request", () => {
    expect(planAcceptAltSuggestion({ ...base, suggestion: undefined })).toEqual({ kind: "refused", reason: "noSuggestion" });
    expect(planAcceptAltSuggestion({ ...base, suggestion: "  " })).toEqual({ kind: "refused", reason: "noSuggestion" });
    expect(planAcceptAltSuggestion({ ...base, mediaId: undefined })).toEqual({ kind: "refused", reason: "noMedia" });
    expect(planAcceptAltSuggestion({ ...base, mediaId: "blob:preview" })).toEqual({ kind: "refused", reason: "noMedia" });
    expect(planAcceptAltSuggestion({ ...base, aiBusy: true })).toEqual({ kind: "refused", reason: "busy" });
  });

  it("the plan is pure: the texts and dirty set it was given are untouched", () => {
    const texts = { [URL1]: "old" };
    const dirty = [URL1];
    planAcceptAltSuggestion({ ...base, texts, dirtyUrls: dirty });
    expect(texts).toEqual({ [URL1]: "old" });
    expect(dirty).toEqual([URL1]);
  });
});

describe("switch refusal while the accept's save is in flight", () => {
  it("the accept's save counts as an immediate save (the product/language/market switch is refused)", () => {
    const plan = planAcceptAltSuggestion({ ...base });
    if (plan.kind !== "save") throw new Error("expected a save");
    expect(hasImmediateAltSave(plan.entry, [])).toBe(true);
    expect(hasImmediateAltSave(null, [plan.entry])).toBe(true);
  });
});

describe("wiring in the manager (source guard)", () => {
  const src = readFileSync("app/components/image-manager/VariantImageManager.tsx", "utf8");

  it("the generate answer is stored as a suggestion and returns BEFORE any draft or save is made", () => {
    const gen = src.indexOf('if (data.actionType === "generateAltText") {');
    const draft = src.indexOf("applyAltDraft(url, generated)");
    expect(gen).toBeGreaterThan(0);
    expect(draft).toBeGreaterThan(gen);
    const between = src.slice(gen, draft);
    expect(between).toContain("withAltSuggestion(");
    expect(between).toMatch(/return;\s*\}/);
    expect(between).not.toContain("submitAltSave(");
  });

  it("only a confirmed save starts the translate (the settle callback asks shouldTranslateAfterSave)", () => {
    const call = src.indexOf("shouldTranslateAfterSave(entry, verdict.kind");
    const noPrimary = src.indexOf('if (verdict.kind === "noPrimary")');
    expect(call).toBeGreaterThan(0);
    // It sits inside the "saved" branch, ahead of the failure branches.
    expect(call).toBeLessThan(noPrimary);
  });
});
