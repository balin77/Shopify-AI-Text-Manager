import { describe, expect, it } from "vitest";
import {
  draftKey,
  draftsAfterRemove,
  draftsAfterSet,
  draftsToWrite,
  effectiveEntries,
  entryDisplayName,
  filenameFromUrl,
  hasOwnReplacement,
  pruneDrafts,
  replacementView,
  type LocalizedMediaDraft,
  findOrphanEntries,
  isForeignShopLocale,
  isStaleAnswer,
  replacedMediaIds,
} from "../../app/components/localized-images/localized-media-view.shared";
import type { LocalizedMediaEntry } from "../../app/services/localized-media/localized-media.shared";

const entry = (m: string, l: string, k = ""): LocalizedMediaEntry => ({
  o: "a.jpg", m, l, k, u: "https://cdn.shopify.com/x.jpg", f: "x.jpg", a: "manual", s: "", t: "",
});

describe("replacedMediaIds", () => {
  const entries = [entry("m1", "de"), entry("m2", "de", "7"), entry("m3", "fr")];
  const ids = ["m1", "m2", "m3", "m4"];

  it("marks nothing in the primary locale", () => {
    expect(replacedMediaIds(entries, ids, "", "").size).toBe(0);
  });

  it("marks a medium with an every-market entry, also from a specific market (inherited)", () => {
    expect([...replacedMediaIds(entries, ids, "de", "")].sort()).toEqual(["m1"]);
    expect([...replacedMediaIds(entries, ids, "de", "7")].sort()).toEqual(["m1", "m2"]);
  });

  it("does not mark a market-only entry for another market or for every market", () => {
    expect(replacedMediaIds(entries, ids, "de", "8").has("m2")).toBe(false);
  });

  it("is per language and case-insensitive on the locale", () => {
    expect([...replacedMediaIds(entries, ids, "FR", "")]).toEqual(["m3"]);
  });
});

describe("findOrphanEntries", () => {
  const locales = [{ locale: "en", primary: true }, { locale: "de", primary: false }];
  const markets = [{ id: "gid://shopify/Market/7" }];
  const ids = new Set(["m1"]);

  it("keeps reachable entries", () => {
    expect(findOrphanEntries([entry("m1", "de"), entry("m1", "de", "7")], ids, markets, locales)).toEqual([]);
  });

  it("lists an entry whose original, market or language is gone", () => {
    const gone = entry("m9", "de");
    const market = entry("m1", "de", "99");
    const lang = entry("m1", "fr");
    expect(findOrphanEntries([gone, market, lang], ids, markets, locales)).toEqual([gone, market, lang]);
  });

  it("judges markets and languages only when their lists answered", () => {
    const e = [entry("m1", "fr", "99")];
    expect(findOrphanEntries(e, ids, [], [])).toEqual([]);
  });
});

describe("isForeignShopLocale", () => {
  const locales = [{ locale: "en", primary: true }, { locale: "de", primary: false }];
  it("is true only for a non-primary shop locale", () => {
    expect(isForeignShopLocale("de", locales)).toBe(true);
    expect(isForeignShopLocale("en", locales)).toBe(false);
    expect(isForeignShopLocale("fr", locales)).toBe(false);
    expect(isForeignShopLocale(undefined, locales)).toBe(false);
    expect(isForeignShopLocale("de", [])).toBe(false);
  });
});

describe("isStaleAnswer", () => {
  it("is stale only when the editor moved to another product", () => {
    expect(isStaleAnswer("p1", "p1")).toBe(false);
    expect(isStaleAnswer("p1", "p2")).toBe(true);
  });
});

describe("drafts behind the save bar", () => {
  const set = (over: Partial<LocalizedMediaDraft> = {}): LocalizedMediaDraft => ({
    op: "set", mediaId: "m1", locale: "de", k: "", marketId: "", mediaKind: "image",
    fileId: "gid://shopify/MediaImage/9", previewUrl: "https://cdn.shopify.com/new.jpg", name: "new.jpg", ...over,
  });
  const none = {} as Record<string, LocalizedMediaDraft>;

  it("keys a draft by medium, normalized language and market", () => {
    expect(draftKey("m1", "DE", "7")).toBe("m1|de|7");
    const d = draftsAfterSet(none, set({ locale: "DE" }));
    expect(Object.keys(d)).toEqual(["m1|de|"]);
  });

  it("keeps the same medium separate per language and market", () => {
    let d = draftsAfterSet(none, set());
    d = draftsAfterSet(d, set({ locale: "fr" }));
    d = draftsAfterSet(d, set({ k: "7", marketId: "gid://shopify/Market/7" }));
    expect(Object.keys(d).sort()).toEqual(["m1|de|", "m1|de|7", "m1|fr|"]);
  });

  it("shows a set draft in place of the original, marked as a draft", () => {
    const v = replacementView([], draftsAfterSet(none, set()), "m1", "de", "");
    expect(v).toEqual({ name: "new.jpg", url: "https://cdn.shopify.com/new.jpg", draft: true, inherited: false });
  });

  it("shows the saved replacement when there is no draft, and nothing in the primary locale", () => {
    const saved = entry("m1", "de");
    expect(replacementView([saved], none, "m1", "de", "")).toMatchObject({ draft: false, name: "x.jpg" });
    expect(replacementView([saved], draftsAfterSet(none, set()), "m1", "", "")).toBeNull();
  });

  it("lets a draft override the saved entry of its own slot only", () => {
    const saved = [entry("m1", "de"), entry("m1", "de", "7")];
    const eff = effectiveEntries(saved, draftsAfterSet(none, set({ k: "7" })));
    expect(eff.filter((e) => e.k === "7")).toHaveLength(1);
    expect(eff.find((e) => e.k === "7")?.t).toBe("draft");
    expect(eff.find((e) => e.k === "")?.t).toBe("");
  });

  it("a remove draft drops the saved entry from the view, but the every-market one still counts from a market", () => {
    const saved = [entry("m1", "de"), entry("m1", "de", "7")];
    const target = { mediaId: "m1", locale: "de", k: "7", marketId: "gid://shopify/Market/7", mediaKind: "image" as const };
    const d = draftsAfterRemove(saved, none, target);
    expect(d["m1|de|7"].op).toBe("remove");
    expect(replacementView(saved, d, "m1", "de", "7")).toMatchObject({ inherited: true, draft: false });
    expect(hasOwnReplacement(saved, d, "m1", "de", "7")).toBe(false);
    expect(hasOwnReplacement(saved, none, "m1", "de", "7")).toBe(true);
  });

  it("removing a replacement that exists only as a draft just drops the draft", () => {
    const d = draftsAfterSet(none, set());
    const next = draftsAfterRemove([], d, { mediaId: "m1", locale: "de", k: "", marketId: "", mediaKind: "image" });
    expect(next).toEqual({});
  });

  it("writes removals first and prunes set drafts of media that are gone", () => {
    let d = draftsAfterSet(none, set());
    d = { ...d, "m2|de|": { ...set({ mediaId: "m2" }), op: "remove" } };
    expect(draftsToWrite(d).map((x) => x.op)).toEqual(["remove", "set"]);
    const pruned = pruneDrafts(d, new Set(["m2"]));
    expect(Object.keys(pruned)).toEqual(["m2|de|"]);
    // an orphan clean-up (original already gone) survives the prune
    expect(Object.keys(pruneDrafts(d, new Set()))).toEqual(["m2|de|"]);
  });

  it("names a replacement for the hover text by kind", () => {
    expect(filenameFromUrl("https://cdn.shopify.com/a/b%20c.jpg?v=3")).toBe("b c.jpg");
    expect(entryDisplayName({ ...entry("m1", "de"), u: "https://cdn.shopify.com/p.jpg" })).toBe("p.jpg");
    expect(entryDisplayName({ ...entry("m1", "de"), x: "v", w: [{ u: "https://cdn.shopify.com/v/clip.mp4", t: "video/mp4" }] })).toBe("clip.mp4");
    expect(entryDisplayName({ ...entry("m1", "de"), x: "e", r: "https://www.youtube.com/embed/abc" })).toBe("https://www.youtube.com/embed/abc");
  });
});
