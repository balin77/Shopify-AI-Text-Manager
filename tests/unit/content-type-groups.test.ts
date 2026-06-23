/**
 * Unit tests for isThemeContentType.
 *
 * Guards the Phase-2 review fix: the shared editor's theme-content behaviour
 * must fire for ALL four ThemeContent-backed rubrics, not just "templates".
 */

import { describe, it, expect } from "vitest";
import { isThemeContentType } from "~/utils/content-type-groups";

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
