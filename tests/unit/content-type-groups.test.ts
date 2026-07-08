/**
 * Unit tests for isThemeContentType.
 *
 * Guards the Phase-2 review fix: the shared editor's theme-content behaviour
 * must fire for ALL four ThemeContent-backed rubrics, not just "templates".
 */

import { describe, it, expect } from "vitest";
import { isThemeContentType, isResourceBackedThemeContent } from "~/utils/content-type-groups";

describe("isThemeContentType", () => {
  it("returns true for every ThemeContent-backed rubric", () => {
    for (const ct of ["templates", "system", "sellingPlans", "onlineStoreExtras"]) {
      expect(isThemeContentType(ct)).toBe(true);
    }
  });

  it("returns false for non-theme content types", () => {
    for (const ct of ["products", "collections", "blogs", "pages", "policies", "metaobjects", "directTranslations"]) {
      expect(isThemeContentType(ct)).toBe(false);
    }
  });

  it("returns false for undefined / empty", () => {
    expect(isThemeContentType(undefined)).toBe(false);
    expect(isThemeContentType("")).toBe(false);
  });
});

describe("isResourceBackedThemeContent", () => {
  it("returns true for the resource-backed rubrics (main language read-only)", () => {
    for (const ct of ["system", "delivery", "sellingPlans", "onlineStoreExtras"]) {
      expect(isResourceBackedThemeContent(ct)).toBe(true);
    }
  });

  it("returns false for templates (theme-file backed, primary editable)", () => {
    expect(isResourceBackedThemeContent("templates")).toBe(false);
  });

  it("returns false for non-theme content and empty input", () => {
    for (const ct of ["products", "collections", "metaobjects", "", undefined]) {
      expect(isResourceBackedThemeContent(ct)).toBe(false);
    }
  });
});
