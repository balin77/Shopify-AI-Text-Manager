import { describe, it, expect } from "vitest";
import {
  SEO_RUBRICS,
  SEO_SECTIONS,
  getActiveSeoRubric,
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
  it("does not claim the bulk editor — it is its own main-nav tab", () => {
    // The bulk editor lives at /app/bulk with its own main-nav entry
    // (PLAN_BULK_EDITOR.md §1.1) and no longer appears in the SEO sub-nav.
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
  it("every section has a unique id and a path under /app/seo", () => {
    const ids = SEO_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SEO_SECTIONS) {
      expect(s.path === "/app/seo" || s.path.startsWith("/app/seo/")).toBe(true);
    }
  });
});

describe("rubrics (Level 2)", () => {
  it("SEO_SECTIONS is exactly the flattened rubric entries", () => {
    expect(SEO_SECTIONS).toEqual(SEO_RUBRICS.flatMap((r) => r.entries));
  });

  it("rubric ids are unique and no rubric is empty", () => {
    const ids = SEO_RUBRICS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of SEO_RUBRICS) {
      expect(r.entries.length).toBeGreaterThan(0);
    }
  });

  it("every section belongs to exactly one rubric", () => {
    for (const s of SEO_SECTIONS) {
      const owners = SEO_RUBRICS.filter((r) => r.entries.some((e) => e.id === s.id));
      expect(owners).toHaveLength(1);
    }
  });

  it("resolves the rubric owning a pathname", () => {
    expect(getActiveSeoRubric("/app/seo")?.id).toBe("overview");
    expect(getActiveSeoRubric("/app/seo/internal-links")?.id).toBe("linking");
    expect(getActiveSeoRubric("/app/seo/structured-data")?.id).toBe("technical");
    expect(getActiveSeoRubric("/app/products")).toBeNull();
  });
});
