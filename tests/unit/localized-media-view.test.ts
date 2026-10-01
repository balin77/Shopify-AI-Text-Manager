import { describe, expect, it } from "vitest";
import {
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
