/**
 * Catalog readiness for AI channels — the pure half.
 *
 * The rule that needs the most protection is the `attributesSyncedAt` gate:
 * `vendor` and `categoryId` hold migration defaults on rows written by an older
 * sync, which is indistinguishable from "the merchant left them empty". A
 * report that cannot tell those apart must say nothing about them, not paint
 * the catalog red.
 */

import { describe, it, expect } from "vitest";
import {
  findingsForProduct,
  descriptionTextLength,
  MIN_DESCRIPTION_CHARS,
} from "~/services/seo/catalog-readiness.service";

const COMPLETE = {
  vendor: "Kumiko",
  categoryId: "gid://shopify/TaxonomyCategory/hg-1",
  descriptionHtml: "<p>" + "A hand-made oak box with a traditional pattern." + "</p>",
  featuredImageUrl: "https://cdn.shopify.com/x.jpg",
};

const KNOWN = { attributesKnown: true, hasGtin: true };

describe("findingsForProduct", () => {
  it("reports nothing for a complete product", () => {
    expect(findingsForProduct(COMPLETE, KNOWN)).toEqual([]);
  });

  it("reports each missing field", () => {
    expect(findingsForProduct({ ...COMPLETE, vendor: null }, KNOWN)).toEqual(["brandMissing"]);
    expect(findingsForProduct({ ...COMPLETE, categoryId: "" }, KNOWN)).toEqual(["categoryMissing"]);
    expect(findingsForProduct(COMPLETE, { ...KNOWN, hasGtin: false })).toEqual(["gtinMissing"]);
    expect(findingsForProduct({ ...COMPLETE, featuredImageUrl: null }, KNOWN)).toEqual([
      "imageMissing",
    ]);
  });

  it("treats whitespace as missing, not as a value", () => {
    expect(findingsForProduct({ ...COMPLETE, vendor: "   " }, KNOWN)).toEqual(["brandMissing"]);
  });

  it("never reports brand or category when the attribute block was not synced", () => {
    const bare = { vendor: null, categoryId: null, descriptionHtml: COMPLETE.descriptionHtml, featuredImageUrl: COMPLETE.featuredImageUrl };
    // Unknown ⇒ silence on both, even though both columns are empty.
    expect(findingsForProduct(bare, { attributesKnown: false, hasGtin: true })).toEqual([]);
    // Known ⇒ both reported.
    expect(findingsForProduct(bare, { attributesKnown: true, hasGtin: true })).toEqual([
      "brandMissing",
      "categoryMissing",
    ]);
  });

  it("still reports the checks that do not depend on the attribute block", () => {
    const findings = findingsForProduct(
      { vendor: null, categoryId: null, descriptionHtml: "", featuredImageUrl: null },
      { attributesKnown: false, hasGtin: false },
    );
    expect(findings).toEqual(["gtinMissing", "descriptionMissing", "imageMissing"]);
  });

  it("counts a too-short description as missing, measured on the text not the markup", () => {
    // Plenty of markup, almost no words — the case an HTML length check misses.
    const markupHeavy = `<div class="rte"><p><span style="font-weight:600">Neu</span></p></div>`;
    expect(descriptionTextLength(markupHeavy)).toBeLessThan(MIN_DESCRIPTION_CHARS);
    expect(findingsForProduct({ ...COMPLETE, descriptionHtml: markupHeavy }, KNOWN)).toEqual([
      "descriptionMissing",
    ]);
  });

  it("counts &nbsp; and collapsed whitespace as one space each", () => {
    expect(descriptionTextLength("<p>a&nbsp;&nbsp;b</p>")).toBe(3);
    expect(descriptionTextLength(null)).toBe(0);
  });
});
