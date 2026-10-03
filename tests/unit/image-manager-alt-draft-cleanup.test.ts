import { describe, it, expect } from "vitest";
import {
  selectAltSends,
  mergeAltAliases,
  altSaveInView,
  altDraftUrlsOfDeletedMedia,
  strandedAltDraftUrls,
  dropAltDrafts,
  partitionAltQueue,
  unsentAltDrafts,
} from "~/components/image-manager/alt-draft";
import { gidForUrl, variantTileAltEditable } from "~/components/image-manager/url-gid";
import type { QueuedAltSave } from "~/services/alt-text-feedback.shared";

const G1 = "gid://shopify/MediaImage/1";
const G2 = "gid://shopify/MediaImage/2";

describe("a confirmed delete takes the deleted media's drafts with it (finding 1)", () => {
  const lookup = { "https://cdn/a.jpg?v=1": G1, "https://cdn/b.jpg?v=1": G2 };

  it("finds every draft url of a deleted medium, including one shown under another ?v=", () => {
    const urls = ["https://cdn/a.jpg?v=1", "https://cdn/a.jpg?v=2", "https://cdn/b.jpg?v=1", "blob:x"];
    expect(altDraftUrlsOfDeletedMedia(urls, lookup, new Set([G1]), new Set(), gidForUrl)).toEqual([
      "https://cdn/a.jpg?v=1",
      "https://cdn/a.jpg?v=2",
    ]);
  });

  it("a removed unsaved upload's preview url goes too; a refused delete keeps everything", () => {
    expect(altDraftUrlsOfDeletedMedia(["blob:x", "https://cdn/b.jpg?v=1"], lookup, new Set(), new Set(["blob:x"]), gidForUrl)).toEqual(["blob:x"]);
    expect(altDraftUrlsOfDeletedMedia(Object.keys(lookup), lookup, new Set(), new Set(), gidForUrl)).toEqual([]);
  });

  it("dropAltDrafts removes text, dirty and failed flags, baseline and edit order -- and nothing else", () => {
    const state = {
      texts: { a: "x", b: "y" },
      dirty: new Set(["a", "b"]),
      baselines: new Map<string, string | undefined>([["a", "old"], ["b", undefined]]),
      failed: new Set(["a"]),
      editOrder: new Map([["a", 1], ["b", 2]]),
    };
    const next = dropAltDrafts(state, ["a"]);
    expect(next.texts).toEqual({ b: "y" });
    expect([...next.dirty]).toEqual(["b"]);
    expect([...next.baselines.keys()]).toEqual(["b"]);
    expect(next.failed.size).toBe(0);
    expect([...next.editOrder.keys()]).toEqual(["b"]);
    // the input is not mutated
    expect(state.dirty.has("a")).toBe(true);
  });

  it("partitionAltQueue splits the queue by the predicate", () => {
    const q: QueuedAltSave[] = [
      { url: "a", mediaId: G1, altText: "x", locale: "de" },
      { url: "b", mediaId: G2, altText: "y", locale: "en" },
    ];
    const { kept, dropped } = partitionAltQueue(q, (e) => e.mediaId === G1);
    expect(kept).toEqual([q[1]]);
    expect(dropped).toEqual([q[0]]);
  });
});

describe("drafts stranded under a url nothing addresses any more (finding 1, WebP swap)", () => {
  const base = { carried: new Set<string>(), settlingPreviews: new Set<string>(), gidOf: gidForUrl };

  it("drops a draft of a medium that vanished from every map and every tile", () => {
    expect(strandedAltDraftUrls({
      ...base,
      dirtyUrls: ["https://cdn/old.jpg?v=1", "https://cdn/new.webp?v=1"],
      lookup: { "https://cdn/new.webp?v=1": G2 },
      shown: new Set(["https://cdn/new.webp?v=1"]),
    })).toEqual(["https://cdn/old.jpg?v=1"]);
  });

  it("keeps a draft whose medium still resolves under another ?v=, and one that is shown", () => {
    expect(strandedAltDraftUrls({
      ...base,
      dirtyUrls: ["https://cdn/a.jpg?v=1", "https://cdn/c.jpg"],
      lookup: { "https://cdn/a.jpg?v=2": G1 },
      shown: new Set(["https://cdn/c.jpg"]),
    })).toEqual([]);
  });

  it("never drops a carried-over draft or one under a settling upload's preview", () => {
    expect(strandedAltDraftUrls({
      ...base,
      dirtyUrls: ["blob:a", "blob:b"],
      lookup: { "https://cdn/x.jpg": G1 },
      shown: new Set(),
      carried: new Set(["blob:a"]),
      settlingPreviews: new Set(["blob:b"]),
    })).toEqual([]);
  });

  it("does not judge a real url while the gallery is still loading (empty maps)", () => {
    expect(strandedAltDraftUrls({ ...base, dirtyUrls: ["https://cdn/a.jpg", "blob:z"], lookup: {}, shown: new Set() }))
      .toEqual(["blob:z"]);
  });
});

describe("a variant tile that is not a medium has no alt box (finding 1)", () => {
  const args = {
    galleryFileGids: [G1, "https://staging/upload.jpg"],
    fileUrlMap: { [G1]: "https://cdn/a.jpg", "https://staging/upload.jpg": "blob:preview" },
    urlToGid: { "https://cdn/a.jpg": G1 },
    externalVideoUrls: ["https://youtu.be/abc"],
    threeDModelUrls: ["https://cdn/model.glb"],
  };
  it("a medium and an unsaved upload can carry an alt", () => {
    expect(variantTileAltEditable({ ...args, url: "https://cdn/a.jpg" })).toBe(true);
    expect(variantTileAltEditable({ ...args, url: "blob:preview" })).toBe(true);
  });
  it("a YouTube/Vimeo link or a 3D model url stored on the variant cannot", () => {
    expect(variantTileAltEditable({ ...args, url: "https://youtu.be/abc" })).toBe(false);
    expect(variantTileAltEditable({ ...args, url: "https://cdn/model.glb" })).toBe(false);
    expect(variantTileAltEditable({ ...args, url: "https://elsewhere/x.jpg" })).toBe(false);
  });
});

describe("Discard only takes back the view it is pressed in (finding 3)", () => {
  const view = { productId: "p1", locale: "fr", marketId: "gid://shopify/Market/1" };
  it("matches product, language and market", () => {
    expect(altSaveInView({ productId: "p1", locale: "fr", marketId: "gid://shopify/Market/1" }, view)).toBe(true);
    expect(altSaveInView({ productId: "p1", locale: "de", marketId: "gid://shopify/Market/1" }, view)).toBe(false);
    expect(altSaveInView({ productId: "p1", locale: "fr" }, view)).toBe(false);
    expect(altSaveInView({ productId: "p2", locale: "fr", marketId: "gid://shopify/Market/1" }, view)).toBe(false);
  });
  it("the global layer: undefined and empty market are the same", () => {
    expect(altSaveInView({ productId: "p1", locale: "de", marketId: undefined }, { productId: "p1", locale: "de", marketId: "" })).toBe(true);
  });
  it("a queued save of another language under the same url survives a Discard", () => {
    const queue: QueuedAltSave[] = [
      { url: "u", mediaId: G1, altText: "de", locale: "de", productId: "p1" },
      { url: "u", mediaId: G1, altText: "fr", locale: "fr", productId: "p1", marketId: "gid://shopify/Market/1" },
    ];
    const urls = new Set(["u"]);
    const { kept, dropped } = partitionAltQueue(queue, (q) => urls.has(q.url) && altSaveInView(q, view));
    expect(kept.map((q) => q.locale)).toEqual(["de"]);
    expect(dropped.map((q) => q.locale)).toEqual(["fr"]);
  });
});

describe("a reused pending save picks up newly planned alias tiles (finding 4)", () => {
  it("adds the new tile as an alias of the pending save, which stays the same object", () => {
    const pending: QueuedAltSave = { url: "u1", mediaId: G1, altText: "same", locale: "de" };
    const planned: QueuedAltSave = { url: "u1", mediaId: G1, altText: "same", locale: "de", aliases: [{ url: "u1-variant", altText: "same" }] };
    const { send, reuse } = selectAltSends([planned], [pending]);
    expect(send).toEqual([]);
    expect(reuse[0]).toBe(pending);
    expect(pending.aliases).toEqual([{ url: "u1-variant", altText: "same" }]);
    // so the alias counts as covered (no "unsent" prompt) and settles on the answer
    expect(unsentAltDrafts(["u1", "u1-variant"], { u1: "same", "u1-variant": "same" }, [pending])).toEqual([]);
  });

  it("the planned winner under another url becomes an alias too; nothing is duplicated", () => {
    const pending = { url: "u1", aliases: [{ url: "u2", altText: "s" }] };
    expect(mergeAltAliases(pending, { url: "u3", altText: "s", aliases: [{ url: "u2", altText: "s" }, { url: "u1", altText: "s" }] }))
      .toEqual([{ url: "u3", altText: "s" }]);
    expect(mergeAltAliases(pending, { url: "u1", altText: "s" })).toEqual([]);
  });
});
