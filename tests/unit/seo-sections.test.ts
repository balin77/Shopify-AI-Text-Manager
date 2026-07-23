import { describe, it, expect } from "vitest";
import {
  SEO_SECTIONS,
  getActiveSeoSection,
  isSeoPath,
  isSeoIndexPath,
} from "~/config/seo-sections";

/**
 * Locks the section-descriptor contract (Phase 0.1b / A1): longest-path-first
 * matching (so "/app/seo" doesn't shadow its sub-paths) and the SEO/non-SEO
 * path predicate.
 */

describe("getActiveSeoSection — longest-path-first", () => {
  it("resolves the index to overview, not a prefix collision", () => {
    expect(getActiveSeoSection("/app/seo")?.id).toBe("overview");
  });
  it("resolves a sub-path to its own section", () => {
    expect(getActiveSeoSection("/app/seo/structured-data")?.id).toBe("structuredData");
  });
  it("returns null off the SEO tab", () => {
    expect(getActiveSeoSection("/app/products")).toBeNull();
    expect(getActiveSeoSection("/app/seoxyz")).toBeNull();
  });
  it("does not claim the bulk editor (its own main-nav tab) although the sub-nav links to it", () => {
    // PLAN_BULK_EDITOR.md §1.1: the bulkMeta entry links OUT to /app/bulk —
    // matching it here would light the SEO main-nav tab on the bulk editor.
    expect(getActiveSeoSection("/app/bulk")).toBeNull();
    expect(isSeoPath("/app/bulk")).toBe(false);
  });
});

describe("path predicates", () => {
  it("isSeoPath", () => {
    expect(isSeoPath("/app/seo")).toBe(true);
    expect(isSeoPath("/app/seo/structured-data")).toBe(true);
    expect(isSeoPath("/app/tasks")).toBe(false);
  });
  it("isSeoIndexPath only matches the index exactly", () => {
    expect(isSeoIndexPath("/app/seo")).toBe(true);
    expect(isSeoIndexPath("/app/seo/")).toBe(true);
    expect(isSeoIndexPath("/app/seo/structured-data")).toBe(false);
  });
});

describe("descriptor invariants", () => {
  it("every section has a unique id and a path under /app/seo — except the bulk-editor link-out", () => {
    const ids = SEO_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SEO_SECTIONS) {
      if (s.id === "bulkMeta") {
        // The bulk editor left the SEO section (PLAN_BULK_EDITOR.md §1.1);
        // its sub-nav entry stays as a deliberate link-out.
        expect(s.path).toBe("/app/bulk");
        continue;
      }
      expect(s.path === "/app/seo" || s.path.startsWith("/app/seo/")).toBe(true);
    }
  });
});
