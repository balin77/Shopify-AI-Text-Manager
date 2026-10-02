import { describe, it, expect } from "vitest";
import {
  altFlushKey,
  altFlushSummary,
  createAltFlushWaiter,
  planAltFlush,
  restoreAltDrafts,
  settleAltFlushWaiter,
  releaseAltFlushToken,
  transferAltFlushWaiter,
  selectAltSends,
  unsentAltDrafts,
  settledAltTarget,
  settledAltRenames,
  rekeyAltDrafts,
} from "~/components/image-manager/alt-draft";
import { gidForUrl, tilesByUrl, variantTileReplaceState, isModel3dGid } from "~/components/image-manager/url-gid";

const G1 = "gid://shopify/MediaImage/1";
const G2 = "gid://shopify/MediaImage/2";

describe("planAltFlush: what the page Save sends", () => {
  const base = { productId: "p1", productTitle: "T", urlToGid: { "u1": G1, "u2": G2 } as Record<string, string> };

  it("sends one save per dirty image, in the view's language and market", () => {
    const plan = planAltFlush({ ...base, dirtyUrls: ["u1", "u2"], texts: { u1: "eins", u2: "" }, locale: "de", marketId: "gid://shopify/Market/7" });
    expect(plan.unaddressable).toEqual([]);
    expect(plan.entries).toEqual([
      { url: "u1", mediaId: G1, altText: "eins", locale: "de", marketId: "gid://shopify/Market/7", productId: "p1", productTitle: "T" },
      // an emptied field is a draft too (it clears the alt)
      { url: "u2", mediaId: G2, altText: "", locale: "de", marketId: "gid://shopify/Market/7", productId: "p1", productTitle: "T" },
    ]);
  });

  it("the global layer carries no market", () => {
    const plan = planAltFlush({ ...base, dirtyUrls: ["u1"], texts: { u1: "x" }, locale: "en", marketId: "" });
    expect(plan.entries[0].marketId).toBeUndefined();
  });

  it("an image with no media id yet is reported as not sendable, never silently dropped", () => {
    const plan = planAltFlush({ ...base, dirtyUrls: ["u1", "blob:new", "u3"], texts: { u1: "a", "blob:new": "b", u3: "c" }, urlToGid: { u1: G1, u3: "u3" } });
    expect(plan.entries.map((e) => e.url)).toEqual(["u1"]);
    expect(plan.unaddressable).toEqual(["blob:new", "u3"]);
  });

  it("a dirty flag without a text is a draft that was taken back", () => {
    expect(planAltFlush({ ...base, dirtyUrls: ["u1"], texts: {} }).entries).toEqual([]);
  });
});

describe("restoreAltDrafts: Discard", () => {
  it("puts the pre-edit value back and removes a value that did not exist", () => {
    const baselines = new Map<string, string | undefined>([["u1", "saved"], ["u2", undefined]]);
    const next = restoreAltDrafts({ u1: "typed", u2: "typed too", u3: "untouched" }, baselines, ["u1", "u2"]);
    expect(next).toEqual({ u1: "saved", u3: "untouched" });
  });
});

describe("flush waiter: the page reports only what was answered", () => {
  const e = (mediaId: string, altText = "x") => ({ url: mediaId, mediaId, altText, locale: "de", marketId: undefined });

  it("keys a save by what it writes to", () => {
    expect(altFlushKey({ mediaId: G1, locale: "de", marketId: "m" })).toBe(`${G1}|de|m`);
    expect(altFlushKey({ mediaId: G1 })).toBe(`${G1}||`);
  });

  it("completes once every save was answered and counts ok and failed apart", () => {
    const a = e(G1); const b = e(G2);
    const w = createAltFlushWaiter([a, b]);
    expect(settleAltFlushWaiter(w, a, true)).toBe(false);
    expect(settleAltFlushWaiter(w, b, false)).toBe(true);
    expect(altFlushSummary(w)).toEqual({ ok: 1, failed: 1, unsent: 0 });
  });

  it("ignores an answer nobody waits for", () => {
    const w = createAltFlushWaiter([e(G1)]);
    expect(settleAltFlushWaiter(w, e(G2), true)).toBe(false);
    expect(altFlushSummary(w).ok).toBe(0);
  });

  it("a save dropped before it was answered counts as unsent, never as saved", () => {
    const a = e(G1); const b = e(G2);
    const w = createAltFlushWaiter([a, b], 1);
    settleAltFlushWaiter(w, a, true);
    expect(altFlushSummary(w)).toEqual({ ok: 1, failed: 0, unsent: 2 });
  });

  it("an answer for an OLDER save of the same medium does not settle the newer one (E)", () => {
    const older = e(G1, "eins"); const newer = e(G1, "zwei");
    const w = createAltFlushWaiter([newer]);
    expect(settleAltFlushWaiter(w, older, true)).toBe(false);
    expect(settleAltFlushWaiter(w, newer, true)).toBe(true);
  });

  it("a replaced queued save hands its waiter over to the newer one", () => {
    const older = e(G1, "eins"); const newer = e(G1, "zwei");
    const w = createAltFlushWaiter([older]);
    transferAltFlushWaiter(w, older, newer);
    expect(settleAltFlushWaiter(w, older, true)).toBe(false);
    expect(settleAltFlushWaiter(w, newer, true)).toBe(true);
    expect(altFlushSummary(w)).toEqual({ ok: 1, failed: 0, unsent: 0 });
  });

  it("a released token (never sendable) counts as unsent", () => {
    const placeholder = {};
    const w = createAltFlushWaiter([placeholder]);
    expect(releaseAltFlushToken(w, placeholder)).toBe(true);
    expect(altFlushSummary(w)).toEqual({ ok: 0, failed: 0, unsent: 1 });
  });
});

describe("selectAltSends: a second Save (E)", () => {
  const q = (altText: string) => ({ url: "u1", mediaId: G1, altText, locale: "de" });

  it("waits for a pending save with the same text instead of sending it twice", () => {
    const pending = [q("eins")];
    const { send, reuse } = selectAltSends([q("eins")], pending);
    expect(send).toEqual([]);
    expect(reuse[0]).toBe(pending[0]);
  });

  it("sends a CHANGED text although a save of the same medium is still out", () => {
    const { send, reuse } = selectAltSends([q("zwei")], [q("eins")]);
    expect(send.map((s) => s.altText)).toEqual(["zwei"]);
    expect(reuse).toEqual([]);
  });

  it("compares with the LAST pending save of that medium", () => {
    const pending = [q("eins"), q("zwei")];
    expect(selectAltSends([q("eins")], pending).send.map((s) => s.altText)).toEqual(["eins"]);
    expect(selectAltSends([q("zwei")], pending).reuse[0]).toBe(pending[1]);
  });
});

describe("planAltFlush: one medium under two tile urls (F)", () => {
  it("merges the drafts of one medium, the latest edit wins and the other rides along", () => {
    const plan = planAltFlush({
      productId: "p1",
      dirtyUrls: ["https://cdn/a.jpg?v=1", "https://cdn/a.jpg?v=2"],
      texts: { "https://cdn/a.jpg?v=1": "neu", "https://cdn/a.jpg?v=2": "alt" },
      urlToGid: { "https://cdn/a.jpg?v=1": G1, "https://cdn/a.jpg?v=2": G1 },
      editOrder: new Map([["https://cdn/a.jpg?v=1", 5], ["https://cdn/a.jpg?v=2", 2]]),
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].url).toBe("https://cdn/a.jpg?v=1");
    expect(plan.entries[0].altText).toBe("neu");
    expect(plan.entries[0].aliases).toEqual([{ url: "https://cdn/a.jpg?v=2", altText: "alt" }]);
  });
});

describe("unsent drafts: what a switch would lose (B)", () => {
  it("a draft whose text is already queued (or carried over) is not at risk", () => {
    expect(unsentAltDrafts(["u1"], { u1: "a" }, [{ url: "u1", altText: "a" }])).toEqual([]);
    expect(unsentAltDrafts(["u2"], { u2: "a" }, [{ url: "u1", altText: "a", aliases: [{ url: "u2", altText: "a" }] }])).toEqual([]);
  });
  it("typed on after the Save: at risk", () => {
    expect(unsentAltDrafts(["u1"], { u1: "ab" }, [{ url: "u1", altText: "a" }])).toEqual(["u1"]);
  });
});

describe("drafts on an unsaved upload are carried over, never stranded (A)", () => {
  const settling = [{ productId: "p1", mediaId: G1, previewUrl: "blob:x" }, { productId: "p2", mediaId: G2, previewUrl: "blob:y" }];

  it("names the real media id once the save created it, and the real url once Shopify reports it", () => {
    expect(settledAltTarget("blob:x", settling, "p1", {})).toEqual({ mediaId: G1, url: null });
    expect(settledAltTarget("blob:x", settling, "p1", { [G1]: "https://cdn/x.jpg" })).toEqual({ mediaId: G1, url: "https://cdn/x.jpg" });
    expect(settledAltTarget("blob:y", settling, "p1", { [G2]: "https://cdn/y.jpg" })).toBeNull();
    expect(settledAltTarget("blob:none", settling, "p1", {})).toBeNull();
  });

  it("moves a draft from the preview url to the tile's real url", () => {
    const renames = settledAltRenames(settling, "p1", { [G1]: "https://cdn/x.jpg", [G2]: "https://cdn/y.jpg" });
    expect(renames).toEqual({ "blob:x": "https://cdn/x.jpg" });
    const next = rekeyAltDrafts({
      texts: { "blob:x": "Text", other: "o" },
      dirty: new Set(["blob:x"]),
      baselines: new Map([["blob:x", undefined]]),
      failed: new Set(),
      editOrder: new Map([["blob:x", 3]]),
    }, renames);
    expect(next.texts).toEqual({ "https://cdn/x.jpg": "Text", other: "o" });
    expect([...next.dirty]).toEqual(["https://cdn/x.jpg"]);
    expect(next.baselines.has("https://cdn/x.jpg")).toBe(true);
    expect(next.baselines.has("blob:x")).toBe(false);
    expect(next.editOrder.get("https://cdn/x.jpg")).toBe(3);
  });
});

describe("url-gid: which medium a tile stands for", () => {
  const map = { "https://cdn/a.jpg?v=2": G1, "https://cdn/b.jpg": "https://cdn/b.jpg" };

  it("exact first, then without the version query; a non-GID is no answer", () => {
    expect(gidForUrl(map, "https://cdn/a.jpg?v=2")).toBe(G1);
    expect(gidForUrl(map, "https://cdn/a.jpg?v=1")).toBe(G1);
    expect(gidForUrl(map, "https://cdn/b.jpg")).toBeNull();
    expect(gidForUrl(map, "https://cdn/zzz.jpg")).toBeNull();
  });

  it("builds the tile map per SHOWN url, so a tile whose url is not a map key still gets its replacement", () => {
    const tiles = tilesByUrl(["https://cdn/a.jpg?v=1", "https://cdn/b.jpg"], map, (gid) => (gid === G1 ? { src: "r.jpg" } : null));
    expect(tiles).toEqual({ "https://cdn/a.jpg?v=1": { src: "r.jpg" } });
  });
});

describe("variant tile: what the replace button offers (G, H)", () => {
  const base = {
    galleryFileGids: [G1, "res://upload-1", "gid://shopify/Model3d/9", "gid://shopify/MediaImage/77"],
    fileUrlMap: { [G1]: "https://cdn/a.jpg", "res://upload-1": "blob:up", "gid://shopify/Model3d/9": "https://cdn/m-preview.jpg", "gid://shopify/MediaImage/77": "https://cdn/only-variant.jpg" } as Record<string, string>,
    urlToGid: {} as Record<string, string>,
    externalVideoUrls: ["https://youtu.be/abc"],
    threeDModelUrls: ["https://cdn/model.glb"],
    productMediaIds: new Set([G1, "gid://shopify/Model3d/9"]),
  };

  it("a saved product medium is offered under the GID it is stored under", () => {
    expect(variantTileReplaceState({ ...base, url: "https://cdn/a.jpg" })).toEqual({ kind: "replace", mediaId: G1 });
  });
  it("an unsaved upload offers nothing (not a false 'only in the variant gallery')", () => {
    expect(variantTileReplaceState({ ...base, url: "blob:up" })).toEqual({ kind: "none" });
    expect(variantTileReplaceState({ ...base, url: "blob:unknown" })).toEqual({ kind: "none" });
  });
  it("a link or a variant-only file is not a product medium", () => {
    expect(variantTileReplaceState({ ...base, url: "https://youtu.be/abc" })).toEqual({ kind: "notProductMedium" });
    expect(variantTileReplaceState({ ...base, url: "https://cdn/only-variant.jpg" })).toEqual({ kind: "notProductMedium" });
  });
  it("a 3D model says so, by url or by GID", () => {
    expect(variantTileReplaceState({ ...base, url: "https://cdn/model.glb" })).toEqual({ kind: "model3d" });
    expect(variantTileReplaceState({ ...base, url: "https://cdn/m-preview.jpg" })).toEqual({ kind: "model3d" });
    expect(isModel3dGid("gid://shopify/Model3d/9")).toBe(true);
    expect(isModel3dGid(G1)).toBe(false);
  });
});
