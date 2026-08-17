/**
 * PLAN_CONTENT_CREATION §Phase 3.1/3.2 — the merchandising half of a save.
 *
 * The editor sends every field as a flat string; Shopify wants an enum, a
 * boolean, a string array and a nullable string, across four different inputs.
 * Almost every test here guards a case where getting that wrong FAILS SILENTLY
 * rather than loudly:
 *
 *   - a bad enum value fails at the GraphQL SCHEMA level, which comes back as a
 *     top-level `errors` array with `data: null` and never reaches
 *     `userErrors` — so a caller checking only `userErrors` reads the whole
 *     save as a success while nothing was written;
 *   - an attribute a resource does not have makes Shopify reject the WHOLE
 *     input, taking the merchant's text edits down with it;
 *   - collapsing "" and absent removes the ability to clear a field at all.
 */

import { describe, it, expect } from "vitest";
import { attributeInputFor, parseTagList, isValidProductStatus, isValidSortOrder } from "~/services/content-attributes.shared";

describe("parseTagList", () => {
  it("trims and drops empties, the way Shopify stores them", () => {
    // Without this a stray comma becomes a tag, and the very next save reports
    // a change that never happened.
    expect(parseTagList("sale, new ,, summer ")).toEqual(["sale", "new", "summer"]);
  });

  it("de-duplicates case-insensitively", () => {
    // Shopify collapses "Sale" and "sale" into one, so keeping both would show
    // two tags in the editor where the shop holds one.
    expect(parseTagList("Sale, sale, SALE")).toEqual(["Sale"]);
  });

  it("turns an empty string into an empty list, not a list with one empty tag", () => {
    // The empty string is how a merchant clears every tag — a meaningful value.
    expect(parseTagList("")).toEqual([]);
    expect(parseTagList("  ,  ")).toEqual([]);
  });
});

describe("enum validation", () => {
  it("accepts all four product statuses, UNLISTED included", () => {
    // Three-value assumptions are what made unlisted products invisible to
    // several features in this app already.
    for (const s of ["ACTIVE", "DRAFT", "UNLISTED", "ARCHIVED"]) {
      expect(isValidProductStatus(s)).toBe(true);
    }
    expect(isValidProductStatus("PUBLISHED")).toBe(false);
  });

  it("accepts the collection sort orders and nothing else", () => {
    expect(isValidSortOrder("BEST_SELLING")).toBe(true);
    expect(isValidSortOrder("alpha_asc")).toBe(true);
    expect(isValidSortOrder("RANDOM")).toBe(false);
  });
});

describe("attributeInputFor — presence is not intent", () => {
  /**
   * THE load-bearing rule of this module, and the one whose absence was a data
   * loss bug rather than a cosmetic one.
   *
   * A primary-locale save carries EVERY field, changed or not — only foreign
   * saves are filtered client-side. So "the client sent `tags`" says nothing
   * about whether the merchant touched them. Acting on presence alone meant
   * editing a TITLE also rewrote the merchandising block from whatever the
   * cache happened to hold, and on any shop that had not run the attribute
   * sync that cache holds the migration's defaults: empty.
   *
   * Shopify REPLACES rather than merges. The result was a title edit deleting
   * every tag, clearing the author and PUBLISHING a hidden article.
   */
  it("writes nothing when the field was not among the changed ones", () => {
    const updates = { title: "New title", tags: "sale, new", author: "Ada", isPublished: "true" };
    expect(attributeInputFor("Article", updates, ["title"])).toEqual({});
  });

  it("writes only the attributes that actually changed", () => {
    const updates = { title: "New title", tags: "sale", author: "Ada", templateSuffix: "wide" };
    expect(attributeInputFor("Article", updates, ["title", "tags"])).toEqual({ tags: ["sale"] });
  });

  it("writes nothing at all when the caller does not say what changed", () => {
    // A caller that omits `changedFields` is indistinguishable from one where
    // nothing changed. Of the two readings, only this one is safe.
    expect(attributeInputFor("Article", { tags: "sale", author: "Ada" })).toEqual({});
    expect(attributeInputFor("Article", { tags: "sale" }, undefined)).toEqual({});
  });
});

describe("attributeInputFor", () => {
  /** Every case below assumes the merchant DID touch the field — the gate
   *  above is tested separately, so these pass the key explicitly. */
  const touched = (...keys: string[]) => keys;

  it("gives each resource ONLY the attributes it has", () => {
    // A `sortOrder` on a page is not a harmless extra — Shopify rejects the
    // whole input, so the merchant's text edits are lost with it.
    expect(attributeInputFor("Page", { sortOrder: "BEST_SELLING", isPublished: "true" }, touched("sortOrder", "isPublished")))
      .toEqual({ isPublished: true });
    expect(attributeInputFor("Collection", { isPublished: "false", sortOrder: "BEST_SELLING" }, touched("isPublished", "sortOrder")))
      .toEqual({ sortOrder: "BEST_SELLING" });
    expect(attributeInputFor("Blog", { author: "Ada", templateSuffix: "wide" }, touched("author", "templateSuffix")))
      .toEqual({ templateSuffix: "wide" });
  });

  it("leaves a field the client never sent completely alone", () => {
    // Absent means "not changed". Writing a default here would silently
    // overwrite whatever the merchant set in the Shopify admin.
    expect(attributeInputFor("Article", { title: "Anything" }, touched("title"))).toEqual({});
  });

  it("distinguishes CLEARED from absent for the template suffix", () => {
    // "" is a real instruction: put the item back on the theme's default
    // template, which Shopify expresses as null.
    expect(attributeInputFor("Page", { templateSuffix: "" }, touched("templateSuffix"))).toEqual({ templateSuffix: null });
    expect(attributeInputFor("Page", { templateSuffix: "   " }, touched("templateSuffix"))).toEqual({ templateSuffix: null });
    expect(attributeInputFor("Page", {}, touched("templateSuffix"))).toEqual({});
  });

  it("treats anything but an explicit 'false' as published", () => {
    // Matches the column's own default. An item written before the attribute
    // sync existed must not be silently unpublished by a save.
    expect(attributeInputFor("Page", { isPublished: "true" }, touched("isPublished")).isPublished).toBe(true);
    expect(attributeInputFor("Page", { isPublished: "" }, touched("isPublished")).isPublished).toBe(true);
    expect(attributeInputFor("Page", { isPublished: "false" }, touched("isPublished")).isPublished).toBe(false);
  });

  it("DROPS an unrecognised sort order and names it, instead of sending it", () => {
    // Sent, it would fail at the schema level and the save would report
    // success while nothing was written.
    const input = attributeInputFor("Collection", { sortOrder: "RANDOM" }, touched("sortOrder"));
    expect(input.sortOrder).toBeUndefined();
    expect(input.rejected).toEqual(["sortOrder"]);
  });

  it("treats an empty sort order as 'nothing to write', not as an error", () => {
    const input = attributeInputFor("Collection", { sortOrder: "" }, touched("sortOrder"));
    expect(input.sortOrder).toBeUndefined();
    expect(input.rejected).toBeUndefined();
  });

  it("normalises a valid enum's case", () => {
    expect(attributeInputFor("Collection", { sortOrder: "best_selling" }, touched("sortOrder")).sortOrder).toBe("BEST_SELLING");
  });

  it("refuses to empty an article's author", () => {
    // `ArticleCreateInput.author` is REQUIRED, so an article always has one —
    // an emptied field is a mistake, not an instruction to remove it.
    const input = attributeInputFor("Article", { author: "  " }, touched("author"));
    expect(input.author).toBeUndefined();
    expect(input.rejected).toEqual(["author"]);
  });

  it("lets an empty tag list clear every tag", () => {
    // Unlike author, tags ARE removable, and Shopify replaces the whole list.
    expect(attributeInputFor("Article", { tags: "" }, touched("tags"))).toEqual({ tags: [] });
  });

  it("returns nothing at all for a resource with no attribute block", () => {
    expect(attributeInputFor("ShopPolicy" as never, { isPublished: "false" }, touched("isPublished"))).toEqual({});
  });
});
