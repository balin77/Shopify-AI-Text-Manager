import { describe, it, expect } from "vitest";
import { partialLocaleCounts } from "~/services/translations/partial-result.shared";

/**
 * The bug this exists for: `translateAllContent` SEEDS its translation map
 * with an empty entry per TARGET locale, so a failed locale appears in the map
 * AND on the failed list. Three call sites summed the two and counted every
 * failure twice — a three-language run in which all three failed reported
 * "0 of 6 languages succeeded".
 */
describe("partialLocaleCounts", () => {
  it("counts a seeded-but-failed locale ONCE, not twice", () => {
    // Exactly the shape translateAllContent produces when every locale failed.
    const seeded = { fr: {}, de: {}, it: {} };
    expect(partialLocaleCounts(seeded, ["fr", "de", "it"])).toEqual({
      succeeded: 0,
      total: 3,
    });
  });

  it("reports the mixed run the merchant actually had", () => {
    const map = { fr: { title: "Sac" }, de: {}, it: {} };
    expect(partialLocaleCounts(map, ["de", "it"])).toEqual({ succeeded: 1, total: 3 });
  });

  it("never counts a locale that carries only empty strings as a success", () => {
    const map = { fr: { title: "   " }, de: { title: "Tasche" } };
    expect(partialLocaleCounts(map, [])).toEqual({ succeeded: 1, total: 2 });
  });

  it("accepts the flat single-field shape too", () => {
    // The per-field path hands back Record<locale, value>, not a nested map.
    expect(partialLocaleCounts({ fr: "Sac", de: "" }, ["de"])).toEqual({
      succeeded: 1,
      total: 2,
    });
  });

  it("keeps a failed locale that is NOT a key of the map in the denominator", () => {
    // A path that only adds locales once they succeed still has to report the
    // failures it was asked about.
    expect(partialLocaleCounts({ fr: "Sac" }, ["de"])).toEqual({ succeeded: 1, total: 2 });
  });

  it("never counts a locale as succeeded while it is on the failed list", () => {
    // Belt and braces: a runner that wrote a value AND flagged the locale is
    // contradicting itself, and the failure is the safer reading.
    expect(partialLocaleCounts({ fr: "Sac" }, ["fr"])).toEqual({ succeeded: 0, total: 1 });
  });

  it("is total against junk", () => {
    expect(partialLocaleCounts(null, null)).toEqual({ succeeded: 0, total: 0 });
    expect(partialLocaleCounts(undefined, undefined)).toEqual({ succeeded: 0, total: 0 });
    expect(partialLocaleCounts({}, [])).toEqual({ succeeded: 0, total: 0 });
    expect(partialLocaleCounts({ fr: null }, [])).toEqual({ succeeded: 0, total: 1 });
    expect(partialLocaleCounts({ fr: 42 as unknown }, ["", null as unknown as string])).toEqual({
      succeeded: 0,
      total: 1,
    });
  });
});
