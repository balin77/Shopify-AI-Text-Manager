import { describe, it, expect } from "vitest";
import {
  buildVariantEmission,
  displayMain,
  galleryWithout,
  mainOnlyOrder,
  orderWithoutFiles,
  orderAfterMainChange,
  orderShowingMain,
  pickPromotedMain,
  planVariantDrag,
  planVariantWrite,
  visibleFileOrder,
  type DragEntry,
} from "~/services/variant-main-image.shared";

const img = (n: number) => `gid://shopify/MediaImage/${n}`;
const vid = (n: number) => `gid://shopify/Video/${n}`;
const order = (...e: Array<[string, string]>) => JSON.stringify(e.map(([kind, value]) => ({ kind, value })));

describe("pickPromotedMain", () => {
  it("takes the first image of the gallery, skipping videos, models and generic files", () => {
    expect(pickPromotedMain({ files: [vid(1), "gid://shopify/GenericFile/1", img(2), img(3)] })).toBe(img(2));
  });
  it("is null when no image qualifies", () => {
    expect(pickPromotedMain({ files: [vid(1), "gid://shopify/Model3d/1"] })).toBeNull();
    expect(pickPromotedMain({ files: [] })).toBeNull();
  });
  it("follows the visible order when there is one, ignoring the removed main", () => {
    const o = order(["file", img(1)], ["url", "https://youtu.be/x"], ["file", img(3)], ["file", img(2)]);
    expect(pickPromotedMain({ files: [img(2), img(3)], orderJson: o, removedMain: img(1) })).toBe(img(3));
  });
  it("skips what the caller says cannot be promoted (a dead reference)", () => {
    expect(pickPromotedMain({ files: [img(9), img(2)], isCandidate: (g) => g !== img(9) })).toBe(img(2));
  });
});

describe("orderAfterMainChange", () => {
  it("drops the removed main and puts the promoted one first, keeping URLs and models", () => {
    const o = order(["file", img(1)], ["url", "u"], ["file", img(2)], ["model", "m"]);
    expect(JSON.parse(orderAfterMainChange(o, img(1), img(2))!)).toEqual([
      { kind: "file", value: img(2) },
      { kind: "url", value: "u" },
      { kind: "model", value: "m" },
    ]);
  });
  it("is null without an order", () => {
    expect(orderAfterMainChange(null, img(1), img(2))).toBeNull();
  });
});

describe("displayMain: explicit intent decides, nothing is pinned", () => {
  it("native main not in the list (the normal case): shown once, first", () => {
    const d = displayMain({ nativeMainGid: img(1), removed: false, stored: [img(2), img(3)] });
    expect(d).toEqual({ mainGid: img(1), gids: [img(1), img(2), img(3)] });
  });
  it("native main stored in the list too (older saves): shown once, where the list has it (no pinning)", () => {
    const d = displayMain({ nativeMainGid: img(1), removed: false, stored: [img(2), img(1), img(3)] });
    expect(d.mainGid).toBe(img(1));
    expect(d.gids).toEqual([img(2), img(1), img(3)]);
  });
  it("a gallery of exactly [main] shows the main once", () => {
    expect(displayMain({ nativeMainGid: img(1), removed: false, stored: [img(1)] }).gids).toEqual([img(1)]);
  });
  it("a pending main (dragged to the first slot) is the main right away; the old main stays in the gallery", () => {
    const d = displayMain({ nativeMainGid: img(1), removed: false, pendingMain: img(3), stored: [img(3), img(1), img(2)] });
    expect(d).toEqual({ mainGid: img(3), gids: [img(3), img(1), img(2)] });
  });
  it("removed main: the next image is shown as the main right away", () => {
    const d = displayMain({ nativeMainGid: img(1), removed: true, stored: [img(1), img(2), img(3)] });
    expect(d).toEqual({ mainGid: img(2), gids: [img(2), img(3)] });
  });
  it("removed main, only videos left: no main", () => {
    expect(displayMain({ nativeMainGid: img(1), removed: true, stored: [vid(1)] }).mainGid).toBeNull();
  });
  it("a variant that never had a main image gets none promoted for display", () => {
    const d = displayMain({ nativeMainGid: null, removed: false, stored: [img(2), img(3)] });
    expect(d.mainGid).toBeNull();
    expect(d.gids).toEqual([img(2), img(3)]);
  });
});

describe("orderShowingMain", () => {
  it("puts the main first when an order exists but does not list it", () => {
    const o = order(["file", img(2)], ["url", "u"]);
    expect(JSON.parse(orderShowingMain(o, img(1))!)[0]).toEqual({ kind: "file", value: img(1) });
  });
  it("leaves an order that lists the main (anywhere) alone, and no order stays none", () => {
    const o = order(["file", img(2)], ["file", img(1)]);
    expect(orderShowingMain(o, img(1))).toBe(o);
    expect(orderShowingMain(null, img(1))).toBeNull();
  });
});

describe("buildVariantEmission: what a Save sends (explicit intents only)", () => {
  const variants = [
    { id: "v1", mainGid: img(1), galleryFileGids: [img(2)] },
    { id: "v2", mainGid: undefined, hasNativeImage: false, galleryFileGids: [img(5)] },
    { id: "v3", mainGid: undefined, galleryFileGids: [img(5)] }, // native image exists but cannot be named
  ];
  it("legacy stored [2,1,3] with main 1 plus a plain edit: galleryOnly, the main is never touched or re-chosen", () => {
    const { galleries, removedMainImages } = buildVariantEmission({ pending: { v1: [img(2), img(1), img(3)] }, removed: {}, variants });
    expect(galleries).toEqual([{ variantId: "v1", fileGids: [img(2), img(3)], galleryOnly: true, expectedMainGid: img(1) }]);
    expect(removedMainImages).toEqual([]);
  });
  it("an explicit pending main carries the main the editor showed as the expected one", () => {
    const { galleries } = buildVariantEmission({
      pending: { v1: [img(3), img(1), img(2)] },
      removed: {},
      pendingMain: { v1: { gid: img(3), expected: img(1) } },
      variants,
    });
    expect(galleries).toEqual([{ variantId: "v1", fileGids: [img(3), img(1), img(2)], mainGid: img(3), expectedMainGid: img(1) }]);
  });
  it("a pending main equal to the current main is no intent at all", () => {
    const { galleries } = buildVariantEmission({
      pending: { v1: [img(1), img(2)] },
      removed: {},
      pendingMain: { v1: { gid: img(1), expected: img(1) } },
      variants,
    });
    expect(galleries[0]).toMatchObject({ galleryOnly: true });
    expect(galleries[0].mainGid).toBeUndefined();
  });
  it("a variant with NO native image gets promoteIfEmpty on a real edit", () => {
    const { galleries } = buildVariantEmission({ pending: { v2: [img(5), img(6)] }, removed: {}, variants });
    expect(galleries).toEqual([{ variantId: "v2", fileGids: [img(5), img(6)], promoteIfEmpty: true }]);
  });
  it("a variant whose native image cannot be named is galleryOnly and NEVER cleared or promoted", () => {
    const { galleries, removedMainImages } = buildVariantEmission({ pending: { v3: [img(5), img(6)] }, removed: {}, variants });
    expect(galleries).toEqual([{ variantId: "v3", fileGids: [img(5), img(6)], galleryOnly: true }]);
    expect(removedMainImages).toEqual([]);
  });
  it("a removed main names the GID that was removed, with a pending gallery or without", () => {
    const withList = buildVariantEmission({ pending: { v1: [img(1), img(2)] }, removed: { v1: img(1) }, variants });
    expect(withList.galleries).toEqual([{ variantId: "v1", fileGids: [img(2)], removedMainGid: img(1) }]);
    expect(withList.removedMainImages).toEqual([]);
    const alone = buildVariantEmission({ pending: {}, removed: { v1: img(1) }, variants });
    expect(alone.galleries).toEqual([]);
    expect(alone.removedMainImages).toEqual([{ variantId: "v1", removedMainGid: img(1) }]);
  });
});

describe("planVariantWrite", () => {
  const lk = (main: string | null, gallery: string[] = [], orderJson: string | null = null) => ({ main, gallery, order: orderJson });
  const all = new Map([1, 2, 3, 4].map((n) => [img(n), "IMAGE"]));

  it("galleryOnly leaves mediaId alone and strips the server's main from the list", () => {
    const p = planVariantWrite({ fileGids: [img(1), img(2)], galleryOnly: true, lookup: lk(img(1)) });
    expect(p.mediaId).toBeUndefined();
    expect(p.gallery).toEqual([img(2)]);
  });

  describe("removal (removedMainGid)", () => {
    it("fresh main is the removed one: the next image moves up and leaves the gallery", () => {
      const p = planVariantWrite({ fileGids: null, removedMainGid: img(1), lookup: lk(img(1), [img(2), img(3)]), productMedia: all });
      expect(p).toMatchObject({ action: "write", mediaId: img(2), gallery: [img(3)], promoted: img(2) });
    });
    it("fresh main is empty (Shopify already detached the deleted medium): promotes as well", () => {
      const p = planVariantWrite({ fileGids: null, removedMainGid: img(1), lookup: lk(null, [img(2), img(3)]), productMedia: all });
      expect(p).toMatchObject({ mediaId: img(2), gallery: [img(3)] });
    });
    it("REPLAY: the fresh main is another image already (our earlier write): a bare removal does nothing", () => {
      const p = planVariantWrite({ fileGids: null, removedMainGid: img(1), lookup: lk(img(2), [img(3)]), productMedia: all });
      expect(p.action).toBe("skip");
    });
    it("STALE TAB: a removal that carries a list is refused when the fresh main is not what it would promote", () => {
      const p = planVariantWrite({ fileGids: [img(3), img(4)], removedMainGid: img(1), lookup: lk(img(2), [img(3)]), productMedia: all });
      expect(p).toMatchObject({ action: "refuse", refusal: "mainChangedElsewhere" });
    });
    it("retry after our own write landed (list carried, fresh main = what the removal promotes): no second promotion", () => {
      const p = planVariantWrite({ fileGids: [img(2), img(3)], removedMainGid: img(1), lookup: lk(img(2), [img(3)]), productMedia: all });
      expect(p).toMatchObject({ action: "write", mediaId: undefined, gallery: [img(3)] });
    });
    it("nothing left: the only case with no main (unset)", () => {
      expect(planVariantWrite({ fileGids: null, removedMainGid: img(1), lookup: lk(img(1), []), productMedia: all }).mediaId).toBeNull();
    });
    it("R4: a promoted main with an empty gallery writes the main-only order entry", () => {
      const p = planVariantWrite({ fileGids: null, removedMainGid: img(1), lookup: lk(img(1), [img(2)]), productMedia: all });
      expect(p).toMatchObject({ mediaId: img(2), gallery: [], order: mainOnlyOrder(img(2)) });
    });
    it("a promoted image the product does not hold yet is attached first", () => {
      const p = planVariantWrite({ fileGids: null, removedMainGid: img(1), lookup: lk(img(1), [img(9), img(2)]), productMedia: all });
      expect(p).toMatchObject({ mediaId: img(9), attach: img(9) });
    });
  });

  describe("explicit choice (mainGid + expectedMainGid)", () => {
    it("the fresh main is the expected one: set it, the old main stays in the list", () => {
      const p = planVariantWrite({ fileGids: [img(3), img(1), img(2)], mainGid: img(3), expectedMainGid: img(1), lookup: lk(img(1)), productMedia: all });
      expect(p).toMatchObject({ action: "write", mediaId: img(3), gallery: [img(1), img(2)] });
    });
    it("equal to the fresh main: a no-op for the main", () => {
      const p = planVariantWrite({ fileGids: [img(3), img(1)], mainGid: img(3), expectedMainGid: img(1), lookup: lk(img(3)), productMedia: all });
      expect(p.mediaId).toBeUndefined();
      expect(p.gallery).toEqual([img(1)]);
    });
    it("mismatch: refused", () => {
      const p = planVariantWrite({ fileGids: [img(3), img(1)], mainGid: img(3), expectedMainGid: img(1), lookup: lk(img(2)), productMedia: all });
      expect(p).toMatchObject({ action: "refuse", refusal: "mainChangedElsewhere" });
    });
    it("a main that is not a MediaImage is refused (generic file, video)", () => {
      const p = planVariantWrite({ fileGids: [vid(1)], mainGid: vid(1), expectedMainGid: img(1), lookup: lk(img(1)), productMedia: all });
      expect(p).toMatchObject({ action: "refuse", refusal: "notAnImage" });
    });
  });

  it("promoteIfEmpty: only an EMPTY variant gets its first own image; one that has a main is left alone", () => {
    expect(planVariantWrite({ fileGids: [img(2), img(3)], promoteIfEmpty: true, lookup: lk(null), productMedia: all })).toMatchObject({ mediaId: img(2), gallery: [img(3)] });
    const had = planVariantWrite({ fileGids: [img(2), img(3)], promoteIfEmpty: true, lookup: lk(img(1)), productMedia: all });
    expect(had.mediaId).toBeUndefined();
    expect(had.gallery).toEqual([img(2), img(3)]);
  });

  it("FAIL CLOSED: a failed lookup refuses every statement about a main image, and only a plain write falls back", () => {
    for (const intent of [{ removedMainGid: img(1) }, { mainGid: img(2), expectedMainGid: img(1) }, { promoteIfEmpty: true }]) {
      expect(planVariantWrite({ fileGids: [img(2)], lookup: null, ...intent })).toMatchObject({ action: "refuse", refusal: "lookupFailed" });
    }
    expect(planVariantWrite({ fileGids: [img(2)], galleryOnly: true, lookup: null })).toMatchObject({ action: "write", gallery: [img(2)] });
  });

  it("a stale single-entry main-only order is widened when a gallery image is added later (nothing hides it)", () => {
    const p = planVariantWrite({ fileGids: [img(5)], galleryOnly: true, lookup: lk(img(2), [], mainOnlyOrder(img(2))) });
    expect(JSON.parse(p.order!)).toEqual([
      { kind: "file", value: img(2) },
      { kind: "file", value: img(5) },
    ]);
  });
  it("R3: a variant [main] that becomes [] after an edit gets NO order entry", () => {
    const p = planVariantWrite({ fileGids: [], galleryOnly: true, lookup: lk(img(2), [img(3)]) });
    expect(p.order).toBeUndefined();
    expect(p.gallery).toEqual([]);
  });
});

describe("M5-fix: galleryOnly states which main the editor showed", () => {
  const lk = (main: string | null, gallery: string[] = [], orderJson: string | null = null) => ({ main, gallery, order: orderJson });
  it("a stale tab (tab A made 3 the main) is refused instead of stripping 3 and dropping 1", () => {
    const p = planVariantWrite({ fileGids: [img(2), img(3), img(9)], galleryOnly: true, expectedMainGid: img(1), lookup: lk(img(3), [img(1), img(2)]) });
    expect(p).toMatchObject({ action: "refuse", refusal: "mainChangedElsewhere" });
  });
  it("the same state with a matching expectation is written", () => {
    const p = planVariantWrite({ fileGids: [img(2), img(9)], galleryOnly: true, expectedMainGid: img(1), lookup: lk(img(1), [img(2)]) });
    expect(p.action).toBe("write");
  });
});

describe("removal replay with a client order", () => {
  it("does not write back the order that still lists the removed main", () => {
    const o = order(["file", img(1)], ["file", img(2)], ["file", img(3)]);
    const p = planVariantWrite({
      fileGids: [img(2), img(3)], removedMainGid: img(1), clientOrderJson: o,
      lookup: { main: img(2), gallery: [img(3)], order: null },
      productMedia: new Map([[img(2), "IMAGE"], [img(3), "IMAGE"]]),
    });
    expect(p.action).toBe("write");
    expect(JSON.parse(p.order!).map((e: { value: string }) => e.value)).not.toContain(img(1));
  });
});

describe("planVariantDrag (the first slot is the main image)", () => {
  const e = (id: string, isImage = true): DragEntry => ({ id, isImage });
  const M = e("M"), A = e("A"), B = e("B"), V = e("V", false), U = e("U", false);

  it("a plain reorder that keeps the first slot does not choose a main", () => {
    expect(planVariantDrag([M, A, B], "B", "A")).toEqual({ kind: "reorder", order: ["M", "B", "A"], newMain: null });
  });
  it("an image dragged to the first slot becomes the main; the old main moves to the drop position", () => {
    expect(planVariantDrag([M, A, B], "B", "M")).toEqual({ kind: "reorder", order: ["B", "M", "A"], newMain: "B" });
  });
  it("legacy order [2,1,3] (main not first): a drag that keeps slot one still chooses nothing", () => {
    expect(planVariantDrag([A, M, B], "B", "M")).toEqual({ kind: "reorder", order: ["A", "B", "M"], newMain: null });
  });
  it("a video / link / model dragged to the first slot is refused", () => {
    expect(planVariantDrag([M, A, V], "V", "M")).toEqual({ kind: "refused", reason: "nonImageFirst" });
  });
  it("[M, V, A] with M dragged to the end gives [A, V, M] with A as the main", () => {
    expect(planVariantDrag([M, V, A], "M", "A")).toEqual({ kind: "reorder", order: ["A", "V", "M"], newMain: "A" });
  });
  it("M is the only image: it stays and the drag is refused", () => {
    expect(planVariantDrag([M, V, U], "M", "U")).toEqual({ kind: "refused", reason: "onlyImage" });
  });
  it("an unknown or identical tile is no drag", () => {
    expect(planVariantDrag([M, A], "M", "M")).toBeNull();
    expect(planVariantDrag([M, A], "X", "A")).toBeNull();
  });
});

describe("helpers", () => {
  it("galleryWithout dedupes and excludes", () => {
    expect(galleryWithout([img(1), img(2), img(1), img(3)], img(2))).toEqual([img(1), img(3)]);
  });
  it("visibleFileOrder appends what the order does not cover", () => {
    expect(visibleFileOrder([img(1), img(2)], order(["file", img(2)]))).toEqual([img(2), img(1)]);
  });
});

describe("orderWithoutFiles (a pending order after a delete)", () => {
  const url = "https://youtu.be/x";
  it("the order still starts with a file: the first remaining file moves to the front", () => {
    const o = order(["file", img(1)], ["url", url], ["file", img(2)], ["file", img(3)]);
    expect(JSON.parse(orderWithoutFiles(o, new Set([img(1)]))!)).toEqual([
      { kind: "file", value: img(2) },
      { kind: "url", value: url },
      { kind: "file", value: img(3) },
    ]);
  });
  it("M-1: only a link left: the order is KEPT (the embed renders it from the order), only an empty order is dropped", () => {
    expect(JSON.parse(orderWithoutFiles(order(["file", img(1)], ["url", url]), new Set([img(1)]))!)).toEqual([{ kind: "url", value: url }]);
    expect(orderWithoutFiles(order(["file", img(1)]), new Set([img(1)]))).toBeNull();
  });
  it("nothing to remove from a valid order: unchanged content", () => {
    const o = order(["file", img(2)], ["url", url]);
    expect(orderWithoutFiles(o, new Set([img(9)]))).toBe(o);
  });
});

describe("third review: shared", () => {
  const all = new Map([1, 2, 3, 4].map((n) => [img(n), "IMAGE"]));
  it("M1: an explicit choice right after the removal replaces what the bare removal promoted (not refused)", () => {
    const p = planVariantWrite({
      fileGids: [img(2), img(3)], removedMainGid: img(1), mainGid: img(3), expectedMainGid: img(2),
      lookup: { main: img(2), gallery: [img(3)], order: null }, productMedia: all,
    });
    expect(p).toMatchObject({ action: "write", mediaId: img(3), gallery: [img(2)] });
  });
  it("M1: but a main that is neither the removed one nor the promoted one is still refused", () => {
    const p = planVariantWrite({
      fileGids: [img(2), img(3)], removedMainGid: img(1), mainGid: img(3),
      lookup: { main: img(4), gallery: [img(3)], order: null }, productMedia: all,
    });
    expect(p).toMatchObject({ action: "refuse", refusal: "mainChangedElsewhere" });
  });
  it("L7: the order leads with the first IMAGE file (a generic file or video file is not moved to the front)", () => {
    const g = "gid://shopify/GenericFile/7";
    const o = order(["file", g], ["file", img(2)], ["file", vid(1)]);
    expect(JSON.parse(orderWithoutFiles(o, new Set())!)[0]).toEqual({ kind: "file", value: img(2) });
    // no image file: the first FILE leads (the route accepts any file head); no file at all: no order
    expect(JSON.parse(orderWithoutFiles(order(["url", "u"], ["file", g], ["file", vid(1)]), new Set())!)[0]).toEqual({ kind: "file", value: g });
    expect(JSON.parse(orderWithoutFiles(order(["url", "u"], ["model", "m"]), new Set())!)).toHaveLength(2);
  });
});

describe("sixth review: shared", () => {
  it("L6: a removal that promotes nothing still takes the removed main's file entry out of the stored order", () => {
    const o = order(["file", img(1)], ["url", "https://youtu.be/x"]);
    const p = planVariantWrite({ fileGids: null, removedMainGid: img(1), lookup: { main: img(1), gallery: [], order: o }, productMedia: new Map() });
    expect(p.mediaId).toBeNull();
    expect(JSON.parse(p.order!)).toEqual([{ kind: "url", value: "https://youtu.be/x" }]);
  });
});
