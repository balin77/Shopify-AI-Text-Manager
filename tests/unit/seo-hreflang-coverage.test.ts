import { describe, it, expect } from "vitest";
import {
  computeLocaleCoverage,
  coveragePctOf,
  requiredKeysFor,
  HREFLANG_TYPES,
  type HreflangType,
  type PublishableItem,
  type TranslationKey,
  type TypeScan,
} from "~/services/seo/hreflang-coverage.shared";

/**
 * The pure coverage computation behind the language-coverage report. Three
 * rules carry it and each is a way to report work that does not exist: a key is
 * only demanded where the primary value exists, an empty cache is never
 * evidence, and a rounded 100 never stands beside something incomplete.
 */

function item(
  type: HreflangType,
  id: string,
  requiredKeys: TranslationKey[],
  title = id,
): PublishableItem {
  return { resourceType: type, id, title, requiredKeys };
}

/** Every audited type scanned, with the counts the items imply. */
function scansFrom(items: PublishableItem[], overrides: Partial<Record<HreflangType, Partial<TypeScan>>> = {}): TypeScan[] {
  return HREFLANG_TYPES.map((resourceType) => {
    const scanned = items.filter((i) => i.resourceType === resourceType).length;
    return {
      resourceType,
      cachedTotal: scanned,
      scanned,
      capped: false,
      known: scanned > 0,
      ...(overrides[resourceType] ?? {}),
    };
  });
}

function translated(entries: Record<string, TranslationKey[]>): Map<string, Set<string>> {
  return new Map(Object.entries(entries).map(([id, keys]) => [id, new Set<string>(keys)]));
}

const ALL_KEYS: TranslationKey[] = ["title", "body_html", "meta_title", "meta_description"];

describe("requiredKeysFor", () => {
  it("demands only the keys whose primary value really exists", () => {
    expect(
      requiredKeysFor({
        title: "Kumiko box",
        body: "<p>Handmade</p>",
        seoTitle: null,
        seoDescription: "",
      }),
    ).toEqual(["title", "body_html"]);
  });

  it("treats whitespace-only as absent", () => {
    expect(requiredKeysFor({ title: "T", body: "   \n ", seoTitle: "\t" })).toEqual(["title"]);
  });

  it("demands nothing from a resource with no primary content at all", () => {
    expect(requiredKeysFor({})).toEqual([]);
  });
});

describe("coveragePctOf (the 99% rule)", () => {
  it("caps at 99 while anything is still incomplete", () => {
    expect(coveragePctOf(997, 1000)).toBe(99);
  });

  it("only reaches 100 when everything is complete", () => {
    expect(coveragePctOf(1000, 1000)).toBe(100);
  });

  it("is 0 for an empty set rather than NaN", () => {
    expect(coveragePctOf(0, 0)).toBe(0);
  });
});

describe("computeLocaleCoverage", () => {
  it("counts a resource as translated only when EVERY required key is", () => {
    const items = [
      item("product", "gid-P1", ALL_KEYS),
      item("product", "gid-P2", ALL_KEYS),
    ];
    const r = computeLocaleCoverage({
      locale: "de",
      name: "German",
      items,
      typeScans: scansFrom(items),
      // P1 has only its title — the old "any key counts" rule called this done.
      translatedKeys: translated({ "gid-P1": ["title"], "gid-P2": ALL_KEYS }),
      missingListCap: 500,
    });

    expect(r.translated).toBe(1);
    expect(r.coveragePct).toBe(50);
    expect(r.missingTotal).toBe(1);
    expect(r.missing).toEqual([
      {
        resourceType: "product",
        resourceId: "gid-P1",
        title: "gid-P1",
        missingKeys: ["body_html", "meta_title", "meta_description"],
      },
    ]);
  });

  it("does NOT report a field whose primary value is empty", () => {
    // P1 has no meta description in the primary locale, so it can never have a
    // translated one — reporting it would invent work nobody can do.
    const items = [item("product", "gid-P1", ["title", "body_html"])];
    const r = computeLocaleCoverage({
      locale: "de",
      name: "German",
      items,
      typeScans: scansFrom(items),
      translatedKeys: translated({ "gid-P1": ["title", "body_html"] }),
      missingListCap: 500,
    });

    expect(r.missingTotal).toBe(0);
    expect(r.coveragePct).toBe(100);
    const gaps = Object.fromEntries(r.fieldGaps.map((g) => [g.key, g]));
    expect(gaps.meta_description).toEqual({ key: "meta_description", required: 0, missing: 0 });
    expect(gaps.title).toEqual({ key: "title", required: 1, missing: 0 });
  });

  it("reports per type, and a never-synced type is UNKNOWN rather than complete", () => {
    const items = [
      item("product", "gid-P1", ["title"]),
      item("product", "gid-P2", ["title"]),
      item("page", "gid-PG1", ["title"]),
    ];
    const r = computeLocaleCoverage({
      locale: "de",
      name: "German",
      items,
      typeScans: scansFrom(items),
      translatedKeys: translated({ "gid-P1": ["title"], "gid-PG1": ["title"] }),
      missingListCap: 500,
    });

    const byType = Object.fromEntries(r.byType.map((t) => [t.resourceType, t]));
    expect(r.byType.map((t) => t.resourceType)).toEqual([...HREFLANG_TYPES]);

    expect(byType.product).toMatchObject({
      known: true,
      scanned: 2,
      cachedTotal: 2,
      capped: false,
      complete: 1,
      incomplete: 1,
      coveragePct: 50,
    });
    expect(byType.page).toMatchObject({ known: true, scanned: 1, complete: 1, coveragePct: 100 });

    // Nothing cached for collections/articles: unknown, never "0 missing / 100%".
    expect(byType.collection).toMatchObject({ known: false, scanned: 0, complete: 0, coveragePct: 0 });
    expect(byType.article.known).toBe(false);
  });

  it("keeps a type unknown even when its cache is empty but its scan says so", () => {
    // known comes from the SCAN, not from how many items were seen: a type with
    // cached rows that all fell outside the page is still known.
    const items: PublishableItem[] = [];
    const typeScans = scansFrom(items, {
      product: { cachedTotal: 5, scanned: 0, known: true },
    });
    const r = computeLocaleCoverage({
      locale: "de",
      name: "German",
      items,
      typeScans,
      translatedKeys: translated({}),
      missingListCap: 500,
    });
    const byType = Object.fromEntries(r.byType.map((t) => [t.resourceType, t]));
    expect(byType.product.known).toBe(true);
    expect(byType.collection.known).toBe(false);
  });

  it("holds the 99% rule per type as well as overall", () => {
    const items = Array.from({ length: 200 }, (_, i) => item("product", `gid-P${i}`, ["title"]));
    const r = computeLocaleCoverage({
      locale: "de",
      name: "German",
      items,
      typeScans: scansFrom(items),
      // 199 of 200 → rounds to 100, must read 99 beside a non-empty list.
      translatedKeys: translated(
        Object.fromEntries(items.slice(0, 199).map((i) => [i.id, ["title"] as TranslationKey[]])),
      ),
      missingListCap: 500,
    });

    expect(r.coveragePct).toBe(99);
    expect(r.missingTotal).toBe(1);
    expect(r.byType[0].coveragePct).toBe(99);
  });

  it("counts field gaps per type and sums them overall", () => {
    const items = [
      item("product", "gid-P1", ["title", "meta_description"]),
      item("collection", "gid-C1", ["title", "meta_description"]),
    ];
    const r = computeLocaleCoverage({
      locale: "de",
      name: "German",
      items,
      typeScans: scansFrom(items),
      translatedKeys: translated({ "gid-P1": ["title"], "gid-C1": ["title"] }),
      missingListCap: 500,
    });

    const byType = Object.fromEntries(r.byType.map((t) => [t.resourceType, t]));
    const productGaps = Object.fromEntries(byType.product.fieldGaps.map((g) => [g.key, g.missing]));
    expect(productGaps.meta_description).toBe(1);
    expect(productGaps.title).toBe(0);

    const overall = Object.fromEntries(r.fieldGaps.map((g) => [g.key, g]));
    expect(overall.meta_description).toEqual({ key: "meta_description", required: 2, missing: 2 });
    expect(r.fieldGaps.map((g) => g.key)).toEqual([
      "title",
      "body_html",
      "meta_title",
      "meta_description",
    ]);
  });

  it("carries each type's own cap into its coverage, so a sampled bar says so", () => {
    const items = [item("product", "gid-P1", ["title"])];
    const r = computeLocaleCoverage({
      locale: "de",
      name: "German",
      items,
      typeScans: scansFrom(items, { product: { cachedTotal: 40000, scanned: 1, capped: true } }),
      translatedKeys: translated({ "gid-P1": ["title"] }),
      missingListCap: 500,
    });
    const product = r.byType.find((t) => t.resourceType === "product")!;
    expect(product).toMatchObject({ capped: true, cachedTotal: 40000, scanned: 1, coveragePct: 100 });
  });

  it("shares the capped missing list across types instead of filling it in scan order", () => {
    // More incomplete products than the whole budget: filled in scan order the
    // pages would never be listed at all, reading as "pages are fine".
    const items = [
      ...Array.from({ length: 50 }, (_, i) => item("product", `gid-P${i}`, ["title"])),
      item("page", "gid-PG1", ["title"]),
      item("page", "gid-PG2", ["title"]),
    ];
    const r = computeLocaleCoverage({
      locale: "de",
      name: "German",
      items,
      typeScans: scansFrom(items),
      translatedKeys: translated({}),
      missingListCap: 4,
    });

    expect(r.missingTotal).toBe(52);
    expect(r.missing).toHaveLength(4);
    expect(r.missing.map((m) => m.resourceType)).toContain("page");
  });

  it("caps the missing LIST without capping the missing COUNT", () => {
    const items = Array.from({ length: 10 }, (_, i) => item("page", `gid-PG${i}`, ["title"]));
    const r = computeLocaleCoverage({
      locale: "de",
      name: "German",
      items,
      typeScans: scansFrom(items),
      translatedKeys: translated({}),
      missingListCap: 3,
    });
    expect(r.missingTotal).toBe(10);
    expect(r.missing).toHaveLength(3);
  });

  it("treats a resource with no required keys as complete instead of missing", () => {
    const items = [item("page", "gid-PG1", [])];
    const r = computeLocaleCoverage({
      locale: "de",
      name: "German",
      items,
      typeScans: scansFrom(items),
      translatedKeys: translated({}),
      missingListCap: 500,
    });
    expect(r.missingTotal).toBe(0);
    expect(r.translated).toBe(1);
  });
});
