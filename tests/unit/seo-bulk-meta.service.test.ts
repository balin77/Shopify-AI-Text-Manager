import { describe, it, expect } from "vitest";
import { computeDiff, groupDiffByRow, type BulkMetaRow } from "~/services/seo/bulk-meta.service";

/**
 * Locks the diff-only save-all contract (SEO_TAB_IMPLEMENTATION_PLAN.md
 * Anhang C3): only cells whose value actually changed are ever submitted, a
 * deliberate clear (typing nothing) still counts as a real change, and
 * whitespace-only edits don't.
 */

const rows: BulkMetaRow[] = [
  {
    id: "gid://shopify/Product/1",
    type: "product",
    title: "Blue Shoes",
    seoTitle: "Blue Shoes | Shop",
    seoDescription: "Comfortable running shoes.",
    handle: "blue-shoes",
  },
  {
    id: "gid://shopify/Collection/2",
    type: "collection",
    title: "Summer Sale",
    seoTitle: "",
    seoDescription: "",
    handle: "summer-sale",
  },
];

describe("computeDiff", () => {
  it("returns nothing when there are no edits", () => {
    expect(computeDiff(rows, {})).toEqual([]);
  });

  it("ignores an edit that matches the original value exactly", () => {
    const edits = { "gid://shopify/Product/1:title": "Blue Shoes" };
    expect(computeDiff(rows, edits)).toEqual([]);
  });

  it("ignores a whitespace-only change (trims both sides before comparing)", () => {
    const edits = { "gid://shopify/Product/1:title": "  Blue Shoes  " };
    expect(computeDiff(rows, edits)).toEqual([]);
  });

  it("reports a real single-field change", () => {
    const edits = { "gid://shopify/Product/1:seoTitle": "New SEO Title" };
    expect(computeDiff(rows, edits)).toEqual([
      { id: "gid://shopify/Product/1", type: "product", field: "seoTitle", value: "New SEO Title" },
    ]);
  });

  it("treats a deliberate clear (empty string) as a real, save-worthy change", () => {
    const edits = { "gid://shopify/Product/1:seoDescription": "" };
    expect(computeDiff(rows, edits)).toEqual([
      { id: "gid://shopify/Product/1", type: "product", field: "seoDescription", value: "" },
    ]);
  });

  it("does not flag a field that was already empty and stays empty", () => {
    const edits = { "gid://shopify/Collection/2:seoTitle": "   " };
    expect(computeDiff(rows, edits)).toEqual([]);
  });

  it("handles multiple dirty cells across multiple rows, in edit-map order", () => {
    const edits = {
      "gid://shopify/Product/1:title": "Blue Sneakers",
      "gid://shopify/Product/1:handle": "blue-shoes", // unchanged, filtered out
      "gid://shopify/Collection/2:handle": "summer-clearance",
    };
    expect(computeDiff(rows, edits)).toEqual([
      { id: "gid://shopify/Product/1", type: "product", field: "title", value: "Blue Sneakers" },
      { id: "gid://shopify/Collection/2", type: "collection", field: "handle", value: "summer-clearance" },
    ]);
  });

  it("ignores edits for an id no longer present in the loaded rows (stale page)", () => {
    const edits = { "gid://shopify/Product/999:title": "Ghost" };
    expect(computeDiff(rows, edits)).toEqual([]);
  });

  it("ignores a malformed key with no field separator", () => {
    const edits = { malformedkey: "value" };
    expect(computeDiff(rows, edits)).toEqual([]);
  });

  it("splits on the LAST colon so a GID's own colon doesn't break parsing", () => {
    const edits = { "gid://shopify/Product/1:handle": "new-handle" };
    expect(computeDiff(rows, edits)).toEqual([
      { id: "gid://shopify/Product/1", type: "product", field: "handle", value: "new-handle" },
    ]);
  });
});

describe("groupDiffByRow", () => {
  it("groups multiple dirty fields on the same row into one patch", () => {
    const diff = computeDiff(rows, {
      "gid://shopify/Product/1:title": "Blue Sneakers",
      "gid://shopify/Product/1:handle": "blue-sneakers",
    });
    const groups = groupDiffByRow(diff);
    expect(groups).toEqual([
      {
        type: "product",
        id: "gid://shopify/Product/1",
        fields: { title: "Blue Sneakers", handle: "blue-sneakers" },
      },
    ]);
  });

  it("keeps different rows in separate groups", () => {
    const diff = computeDiff(rows, {
      "gid://shopify/Product/1:title": "Blue Sneakers",
      "gid://shopify/Collection/2:handle": "summer-clearance",
    });
    expect(groupDiffByRow(diff)).toHaveLength(2);
  });
});
