/**
 * Package planning (PLAN_BULK_TRANSLATE_BATCHING 3.1 / 3.2): grouping by
 * (kind, instruction text, locale signature), the three size bounds, oversized
 * entries, dedup, halving.
 */
import { describe, it, expect } from "vitest";
import {
  PACKAGE_MAX_ITEMS,
  buildPackageItems,
  groupKeyOf,
  halvePackage,
  itemOutputTokens,
  packageBudgetFor,
  packageMaxTokens,
  packageTimeoutMs,
  planPackages,
  singlePackages,
  type PackageEntry,
} from "~/services/bulk-editor/translate-packages.shared";

const entry = (owner: string, source: string, extra: Partial<PackageEntry> = {}): PackageEntry => ({
  owner,
  kind: "short",
  fieldKey: "title",
  source,
  locales: ["fr", "es"],
  ...extra,
});

const BIG = packageBudgetFor({ modelMaxOutput: 32_000, bucketTpm: null });

describe("buildPackageItems", () => {
  it("collapses identical (group, source) into ONE item with every owner", () => {
    const items = buildPackageItems([entry("a", "Schal"), entry("b", "Mütze"), entry("c", "Schal")]);
    expect(items).toHaveLength(2);
    expect(items[0].owners).toEqual(["a", "c"]);
    expect(items[1].owners).toEqual(["b"]);
  });

  it("does NOT collapse equal texts of a different instruction set, locale set or kind", () => {
    const items = buildPackageItems([
      entry("a", "Schal"),
      entry("b", "Schal", { instructions: "max 60 chars" }),
      entry("c", "Schal", { locales: ["fr"] }),
      entry("d", "Schal", { kind: "value" }),
    ]);
    expect(items).toHaveLength(4);
  });

  it("a handle with another title as context is a different item", () => {
    const items = buildPackageItems([
      entry("a", "schal", { kind: "handle", context: "Schal" }),
      entry("b", "schal", { kind: "handle", context: "Wollschal" }),
    ]);
    expect(items).toHaveLength(2);
  });

  it("locale order does not matter for the signature", () => {
    expect(groupKeyOf({ kind: "short", locales: ["fr", "es"] })).toBe(groupKeyOf({ kind: "short", locales: ["es", "fr"] }));
  });
});

describe("planPackages", () => {
  it("never mixes groups: a different instruction text (SEO cap) or locale set is its own package", () => {
    const items = buildPackageItems([
      entry("a", "Schal"),
      entry("b", "Mütze", { instructions: "cap 60" }),
      entry("c", "Hut", { locales: ["fr"] }),
      entry("d", "Jacke"),
    ]);
    const { packages } = planPackages(items, BIG);
    expect(packages).toHaveLength(3);
    const sizes = packages.map((p) => p.items.map((i) => i.owners[0]).join(""));
    expect(sizes).toEqual(["ad", "b", "c"]);
    // A package only ever translates into the locales ITS items need.
    expect(packages.find((p) => p.items[0].owners[0] === "c")!.locales).toEqual(["fr"]);
  });

  it("closes a package at the item cap", () => {
    const items = buildPackageItems(Array.from({ length: PACKAGE_MAX_ITEMS + 5 }, (_, i) => entry(`o${i}`, `Text ${i}`)));
    const { packages } = planPackages(items, BIG);
    expect(packages.map((p) => p.items.length)).toEqual([PACKAGE_MAX_ITEMS, 5]);
  });

  it("closes a package at the planned OUTPUT budget", () => {
    const long = "x".repeat(2000);
    const items = buildPackageItems(
      Array.from({ length: 6 }, (_, i) => entry(`o${i}`, `${i}${long}`, { kind: "long", fieldKey: "body_html" })),
    );
    const one = itemOutputTokens(items[0]);
    const { packages, oversized } = planPackages(items, { ...BIG, outputTokens: one * 2 + 10 });
    expect(oversized).toHaveLength(0);
    expect(packages.map((p) => p.items.length)).toEqual([2, 2, 2]);
  });

  it("an item that does not fit ALONE is oversized, not dropped and not packaged", () => {
    const huge = entry("h", "y".repeat(40_000), { kind: "long", fieldKey: "body_html" });
    const items = buildPackageItems([huge, entry("a", "Schal")]);
    const { packages, oversized } = planPackages(items, packageBudgetFor({ modelMaxOutput: 8192, bucketTpm: null }));
    expect(oversized.map((i) => i.owners[0])).toEqual(["h"]);
    expect(packages.flatMap((p) => p.items.map((i) => i.owners[0]))).toEqual(["a"]);
  });

  it("the TPM rail keeps a package below the bucket: input + planned output stays under 80 % of TPM", () => {
    const items = buildPackageItems(
      Array.from({ length: 40 }, (_, i) => entry(`o${i}`, `Produkt Nummer ${i} mit etwas laengerem Namen`, { locales: ["fr", "es", "it", "nl"] })),
    );
    const small = packageBudgetFor({ modelMaxOutput: 32_000, bucketTpm: 3000 });
    const { packages } = planPackages(items, small);
    expect(packages.length).toBeGreaterThan(1);
    for (const pkg of packages) {
      const out = pkg.items.reduce((sum, item) => sum + itemOutputTokens(item), 0);
      expect(out).toBeLessThanOrEqual(small.outputTokens);
    }
  });

  it("an item that exceeds the TPM rail alone is oversized (goes to the per-row path)", () => {
    const items = buildPackageItems([entry("a", "z".repeat(6000), { kind: "long", fieldKey: "body_html" })]);
    const { packages, oversized } = planPackages(items, packageBudgetFor({ modelMaxOutput: 32_000, bucketTpm: 2000 }));
    expect(packages).toHaveLength(0);
    expect(oversized).toHaveLength(1);
  });

  it("keeps scan order within a group and first-seen order across groups", () => {
    const items = buildPackageItems([
      entry("a", "A", { kind: "value", fieldKey: "mf" }),
      entry("b", "B"),
      entry("c", "C", { kind: "value", fieldKey: "mf" }),
    ]);
    const { packages } = planPackages(items, BIG);
    expect(packages.map((p) => p.kind)).toEqual(["value", "short"]);
    expect(packages[0].items.map((i) => i.owners[0])).toEqual(["a", "c"]);
  });
});

describe("halving and singles", () => {
  const items = buildPackageItems(Array.from({ length: 5 }, (_, i) => entry(`o${i}`, `T${i}`)));
  const { packages } = planPackages(items, BIG);
  it("halves into ceil(n/2) + rest; a single stays", () => {
    const halves = halvePackage(packages[0]);
    expect(halves.map((p) => p.items.length)).toEqual([3, 2]);
    expect(halvePackage(halves[1].items.length === 2 ? { ...halves[1], items: [halves[1].items[0]] } : halves[1])).toHaveLength(1);
  });
  it("singles: one package per item", () => {
    expect(singlePackages(packages[0]).map((p) => p.items.length)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe("request sizing", () => {
  it("max_tokens = plan x 1.5, never above the model ceiling", () => {
    expect(packageMaxTokens(4000, 32_000)).toBe(6000);
    expect(packageMaxTokens(4000, 4096)).toBe(4096);
  });
  it("timeout is sized from the plan: 120-240 s", () => {
    expect(packageTimeoutMs(100)).toBe(120_000);
    expect(packageTimeoutMs(4000)).toBe(164_000);
    expect(packageTimeoutMs(100_000)).toBe(240_000);
  });
});
