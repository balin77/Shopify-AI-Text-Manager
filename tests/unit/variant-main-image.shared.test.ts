import { describe, it, expect } from "vitest";
import {
  buildVariantEmission,
  displayMain,
  galleryWithout,
  orderAfterMainChange,
  pickPromotedMain,
  planVariantWrite,
  visibleFileOrder,
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
  it("skips what the product does not hold", () => {
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

describe("displayMain: the main image once, first, with the border", () => {
  it("native main stored in the metafield too (older saves): shown once, first", () => {
    const d = displayMain({ nativeMainGid: img(1), removed: false, stored: [img(2), img(1), img(3)] });
    expect(d.mainGid).toBe(img(1));
    expect(d.gids).toEqual([img(1), img(2), img(3)]);
  });
  it("a gallery of exactly [main] shows the main once", () => {
    expect(displayMain({ nativeMainGid: img(1), removed: false, stored: [img(1)] }).gids).toEqual([img(1)]);
  });
  it("removed main: the next image is shown as the main right away", () => {
    const d = displayMain({ nativeMainGid: img(1), removed: true, stored: [img(1), img(2), img(3)] });
    expect(d).toEqual({ mainGid: img(2), gids: [img(2), img(3)] });
  });
  it("removed main, only videos left: no main", () => {
    expect(displayMain({ nativeMainGid: img(1), removed: true, stored: [vid(1)] }).mainGid).toBeNull();
  });
  it("a variant that never had a main image gets none promoted", () => {
    const d = displayMain({ nativeMainGid: null, removed: false, stored: [img(2), img(3)] });
    expect(d.mainGid).toBeNull();
    expect(d.gids).toEqual([img(2), img(3)]);
  });
  it("with an order JSON that lists the main elsewhere: the main still leads (order JSON is untouched)", () => {
    const o = order(["file", img(2)], ["file", img(1)]);
    const d = displayMain({ nativeMainGid: img(1), removed: false, stored: [img(2)], orderJson: o });
    expect(d.gids[0]).toBe(img(1));
  });
});

describe("buildVariantEmission: what a Save sends", () => {
  const variants = [
    { id: "v1", mainGid: img(1), galleryFileGids: [img(2)] },
    { id: "v2", mainGid: undefined, galleryFileGids: [img(5)] },
  ];
  it("a reorder of the gallery never changes the main image: the main is pinned first", () => {
    const { galleries, clearVariantMainIds } = buildVariantEmission({
      pending: { v1: [img(3), img(1), img(2)] },
      removedMainVariantIds: new Set(),
      variants,
    });
    expect(galleries).toEqual([{ variantId: "v1", fileGids: [img(1), img(3), img(2)] }]);
    expect(clearVariantMainIds).toEqual([]);
  });
  it("a variant whose native image cannot be named is galleryOnly and is NEVER cleared", () => {
    const { galleries, clearVariantMainIds } = buildVariantEmission({
      pending: { v2: [img(5), img(6)] },
      removedMainVariantIds: new Set(),
      variants,
    });
    expect(galleries).toEqual([{ variantId: "v2", fileGids: [img(5), img(6)], galleryOnly: true }]);
    expect(clearVariantMainIds).toEqual([]);
  });
  it("a removed main: the gallery without it, and the variant is in the clear list", () => {
    const { galleries, clearVariantMainIds } = buildVariantEmission({
      pending: { v1: [img(1), img(2)] },
      removedMainVariantIds: new Set(["v1"]),
      variants,
    });
    expect(galleries).toEqual([{ variantId: "v1", fileGids: [img(2)] }]);
    expect(clearVariantMainIds).toEqual(["v1"]);
  });
  it("a removed main without any gallery edit still sends its stored gallery (minus the main)", () => {
    const { galleries } = buildVariantEmission({
      pending: {},
      removedMainVariantIds: new Set(["v1"]),
      variants: [{ id: "v1", mainGid: img(1), galleryFileGids: [img(1), img(2)] }],
    });
    expect(galleries).toEqual([{ variantId: "v1", fileGids: [img(2)] }]);
  });
});

describe("planVariantWrite", () => {
  it("normal: first file is the main, never in the gallery", () => {
    expect(planVariantWrite({ fileGids: [img(1), img(2), img(1)] })).toMatchObject({ mediaId: img(1), gallery: [img(2)] });
  });
  it("galleryOnly leaves mediaId alone and strips the server's main", () => {
    const p = planVariantWrite({ fileGids: [img(1), img(2)], galleryOnly: true, lookup: { main: img(1), gallery: [], order: null } });
    expect(p.mediaId).toBeUndefined();
    expect(p.gallery).toEqual([img(2)]);
  });
  it("clear with an image left: it moves up and leaves the gallery", () => {
    const p = planVariantWrite({ fileGids: null, clear: true, lookup: { main: null, gallery: [img(2), img(3)], order: null } });
    expect(p).toMatchObject({ mediaId: img(2), gallery: [img(3)], promoted: img(2) });
  });
  it("clear with nothing left: the only case with no main", () => {
    expect(planVariantWrite({ fileGids: [], clear: true }).mediaId).toBeNull();
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
