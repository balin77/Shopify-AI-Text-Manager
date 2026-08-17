import { describe, it, expect } from "vitest";
import {
  getCharacterCeilingRequirement,
  getCharacterLimitRequirement,
} from "~/utils/character-limits";

/**
 * The ceiling variant exists because generation's requirement is a TARGET while
 * formatting's is a CAP. Holding existing text to the full range pads it up to
 * the minimum — with the shipped defaults (handleMin 50, descriptionMin 150)
 * that means an inflated URL handle and a fabricated description.
 */

describe("getCharacterCeilingRequirement", () => {
  it("returns only the upper bound where the range version returns both", () => {
    expect(getCharacterLimitRequirement("productHandle")).toBe("50-70 characters");
    expect(getCharacterCeilingRequirement("productHandle")).toBe("maximum 70 characters");
  });

  it("returns null for minimum-only fields so formatting is never told to expand", () => {
    expect(getCharacterLimitRequirement("productDescription")).toBe("minimum 150 characters");
    expect(getCharacterCeilingRequirement("productDescription")).toBeNull();
    expect(getCharacterCeilingRequirement("pageDescription")).toBeNull();
    expect(getCharacterCeilingRequirement("policyDescription")).toBeNull();
  });

  it("honours the suffix-adjusted SEO title max", () => {
    expect(getCharacterCeilingRequirement("productSeoTitle", { seoTitleMaxChars: 48 })).toBe(
      "maximum 48 characters",
    );
  });

  it("honours merchant limit overrides", () => {
    expect(getCharacterCeilingRequirement("productMetaDesc", { limits: { metaDescMax: 200 } })).toBe(
      "maximum 200 characters",
    );
  });

  it("returns null for an unknown field key", () => {
    expect(getCharacterCeilingRequirement("somethingElse")).toBeNull();
  });

  it("covers every field key the range version knows, except the minimum-only ones", () => {
    const minimumOnly = new Set([
      "productDescription",
      "collectionDescription",
      "blogDescription",
      "pageDescription",
      "policyDescription",
    ]);
    const keys = [
      "productTitle", "collectionTitle", "blogTitle", "pageTitle",
      "productDescription", "collectionDescription", "blogDescription", "pageDescription", "policyDescription",
      "productSeoTitle", "collectionSeoTitle", "blogSeoTitle", "pageSeoTitle",
      "productMetaDesc", "collectionMetaDesc", "blogMetaDesc", "pageMetaDesc",
      "productHandle", "collectionHandle", "blogHandle", "pageHandle",
      "productAltText",
    ];
    for (const key of keys) {
      expect(getCharacterLimitRequirement(key), `range for ${key}`).not.toBeNull();
      const ceiling = getCharacterCeilingRequirement(key);
      if (minimumOnly.has(key)) {
        expect(ceiling, `ceiling for ${key}`).toBeNull();
      } else {
        expect(ceiling, `ceiling for ${key}`).toMatch(/^maximum \d+ characters$/);
      }
    }
  });
});
