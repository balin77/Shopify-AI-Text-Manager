import { describe, it, expect } from "vitest";
import {
  altFlushKey,
  altFlushSummary,
  createAltFlushWaiter,
  planAltFlush,
  restoreAltDrafts,
  settleAltFlushWaiter,
} from "~/components/image-manager/alt-draft";
import { gidForUrl, tilesByUrl } from "~/components/image-manager/url-gid";

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
  const e = (mediaId: string) => ({ mediaId, locale: "de", marketId: undefined });

  it("keys a save by what it writes to", () => {
    expect(altFlushKey({ mediaId: G1, locale: "de", marketId: "m" })).toBe(`${G1}|de|m`);
    expect(altFlushKey({ mediaId: G1 })).toBe(`${G1}||`);
  });

  it("completes once every save was answered and counts ok and failed apart", () => {
    const w = createAltFlushWaiter([altFlushKey(e(G1)), altFlushKey(e(G2))]);
    expect(settleAltFlushWaiter(w, altFlushKey(e(G1)), true)).toBe(false);
    expect(settleAltFlushWaiter(w, altFlushKey(e(G2)), false)).toBe(true);
    expect(altFlushSummary(w)).toEqual({ ok: 1, failed: 1, unsent: 0 });
  });

  it("ignores an answer nobody waits for", () => {
    const w = createAltFlushWaiter([altFlushKey(e(G1))]);
    expect(settleAltFlushWaiter(w, altFlushKey(e(G2)), true)).toBe(false);
    expect(altFlushSummary(w).ok).toBe(0);
  });

  it("a save dropped before it was answered counts as unsent, never as saved", () => {
    const w = createAltFlushWaiter([altFlushKey(e(G1)), altFlushKey(e(G2))], 1);
    settleAltFlushWaiter(w, altFlushKey(e(G1)), true);
    expect(altFlushSummary(w)).toEqual({ ok: 1, failed: 0, unsent: 2 });
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
