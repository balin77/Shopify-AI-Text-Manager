/**
 * The options & metafields card's staged overlay: when an entry EXPIRES, and
 * how a clear-all settles against values staged while it was in flight.
 */
import { describe, expect, it } from "vitest";
import { pruneExpiredOverlay, stampOverlay } from "../../app/services/editor/sub-resource-overlay.shared";
import { settleClearAll, stageClearAll } from "../../app/services/editor/sub-resource-clear.shared";

type Overlay = Record<string, Record<string, Record<string, string>>>;

describe("pruneExpiredOverlay", () => {
  const KEEP = 120_000;
  const mk = (): Overlay => ({ en: { a: { name: "A" }, b: { name: "" } }, fr: { a: { name: "Afr" } } });

  it("drops an entry older than the window once the item was loaded after it", () => {
    const overlay = mk();
    const stamps = new Map<string, number>();
    stampOverlay(stamps, "en", ["a", "b"], 1_000);
    stampOverlay(stamps, "fr", ["a"], 1_000);
    expect(pruneExpiredOverlay(overlay, stamps, { now: 1_000 + KEEP + 1, itemLoadedAt: 2_000, maxAgeMs: KEEP })).toBe(true);
    expect(overlay).toEqual({});
    expect(stamps.size).toBe(0);
  });

  it("keeps an entry inside the window, one the item predates, an unstamped one and a kept id", () => {
    const overlay = mk();
    const stamps = new Map<string, number>();
    stampOverlay(stamps, "en", ["a"], 1_000);
    stampOverlay(stamps, "fr", ["a"], 1_000);
    // Inside the window: kept although the item is newer.
    expect(pruneExpiredOverlay(overlay, stamps, { now: 1_000 + KEEP, itemLoadedAt: 5_000, maxAgeMs: KEEP })).toBe(false);
    // Out of the window but the item was loaded BEFORE the write: kept.
    expect(pruneExpiredOverlay(overlay, stamps, { now: 1_000 + KEEP * 2, itemLoadedAt: 500, maxAgeMs: KEEP })).toBe(false);
    // A kept id (an unconfirmed purge) stays; "b" is unstamped and stays.
    expect(
      pruneExpiredOverlay(overlay, stamps, { now: 1_000 + KEEP * 2, itemLoadedAt: 5_000, maxAgeMs: KEEP, keepIds: new Set(["a"]) }),
    ).toBe(false);
    expect(overlay).toEqual(mk());
  });
});

describe("settleClearAll", () => {
  it("an UNCONFIRMED clear restores the snapshot only while the overlay still holds its staged empty value", () => {
    const overlay: Overlay = { en: { a: { name: "Old" }, b: { name: "OldB" } } };
    const snapshot = stageClearAll(overlay, "en", { a: { name: "" }, b: { name: "" } });
    // A translate answer landed for "a" while the clear was in flight: newer.
    overlay.en.a.name = "Newer";
    settleClearAll(overlay, "en", snapshot, new Set(), false);
    expect(overlay.en.a.name).toBe("Newer");
    expect(overlay.en.b.name).toBe("OldB");
  });

  it("an UNCONFIRMED clear does not resurrect a pair something else removed", () => {
    const overlay: Overlay = { en: { a: { name: "Old" } } };
    const snapshot = stageClearAll(overlay, "en", { a: { name: "" } });
    delete overlay.en;
    settleClearAll(overlay, "en", snapshot, new Set(), false);
    expect(overlay.en).toBeUndefined();
  });

  it("a CONFIRMED global clear drops a value staged over it before the confirmation", () => {
    const overlay: Overlay = {};
    const snapshot = stageClearAll(overlay, "en", { a: { name: "" }, b: { name: "" } });
    overlay.en.a.name = "Staged meanwhile";
    settleClearAll(overlay, "en", snapshot, new Set(["a", "b"]), false);
    expect(overlay.en).toEqual({ a: { name: "" }, b: { name: "" } });
  });

  it("a CONFIRMED market clear removes the pair (the market inherits)", () => {
    const overlay: Overlay = {};
    const snapshot = stageClearAll(overlay, "en@@m", { a: { name: "" } });
    settleClearAll(overlay, "en@@m", snapshot, new Set(["a"]), true);
    expect(overlay["en@@m"]).toBeUndefined();
  });
});
