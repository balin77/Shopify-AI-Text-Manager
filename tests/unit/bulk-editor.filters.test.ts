import { describe, it, expect, vi } from "vitest";
import { loadBulkRows } from "~/services/bulk-editor/load.server";
import {
  BULK_FILTER_IDS,
  filterIdsForType,
  type BulkFilterId,
  type BulkRowType,
} from "~/services/bulk-editor/columns.shared";

/**
 * Bulk editor filter vocabulary: status / visibility / collection kind are
 * OR groups, content gaps are AND flags, attribute filters only ever match
 * attribute-synced rows, and a filter id the type does not speak never
 * reaches the query.
 */

const SHOP = "test-shop.myshopify.com";

function baseOpts(type: BulkRowType, filters: BulkFilterId[]) {
  return { type, locale: "", marketId: "", search: "", filters, sort: null, skip: 0, take: 50 };
}

function mockDb(model: string) {
  const findMany = vi.fn(async (_args: unknown) => []);
  const count = vi.fn(async (_args: unknown) => 0);
  return { db: { [model]: { findMany, count } }, findMany };
}

function whereOf(findMany: ReturnType<typeof vi.fn>) {
  return (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
}

describe("filterIdsForType", () => {
  it("every offered id is part of the URL vocabulary", () => {
    const types: BulkRowType[] = ["product", "variant", "collection", "article", "page", "blog", "policy", "metaobject", "image"];
    for (const t of types) {
      for (const id of filterIdsForType(t)) expect(BULK_FILTER_IDS).toContain(id);
    }
  });

  it("offers status only where a status exists", () => {
    expect(filterIdsForType("product")).toContain("statusDraft");
    expect(filterIdsForType("variant")).toContain("statusDraft");
    expect(filterIdsForType("page")).not.toContain("statusDraft");
    expect(filterIdsForType("blog")).not.toContain("missingDescription");
    expect(filterIdsForType("page")).toContain("hidden");
    expect(filterIdsForType("collection")).toContain("smartCollection");
    expect(filterIdsForType("policy")).toEqual(["missingTranslation"]);
  });
});

describe("loadBulkRows — type filters", () => {
  it("OR-combines statuses and AND-combines content gaps (products)", async () => {
    const { db, findMany } = mockDb("product");
    await loadBulkRows(db as never, SHOP, baseOpts("product", ["statusActive", "statusDraft", "missingImage", "missingDescription"]));
    const and = whereOf(findMany).AND as unknown[];
    expect(and).toContainEqual({ status: { in: ["ACTIVE", "DRAFT"] } });
    expect(and).toContainEqual({ OR: [{ featuredImageUrl: null }, { featuredImageUrl: "" }] });
    expect(and).toContainEqual({ OR: [{ descriptionHtml: null }, { descriptionHtml: "" }] });
    // No attribute-gated filter selected ⇒ no sync gate.
    expect(and).not.toContainEqual({ attributesSyncedAt: { not: null } });
  });

  it("attribute filters only match attribute-synced rows", async () => {
    const { db, findMany } = mockDb("product");
    await loadBulkRows(db as never, SHOP, baseOpts("product", ["missingVendor", "missingTags", "missingCategory"]));
    const and = whereOf(findMany).AND as unknown[];
    expect(and).toContainEqual({ attributesSyncedAt: { not: null } });
    expect(and).toContainEqual({ tags: { isEmpty: true } });
    expect(and).toContainEqual({ categoryId: null });
  });

  it("visibility: one value filters, both values cancel out (but stay sync-gated)", async () => {
    const one = mockDb("page");
    await loadBulkRows(one.db as never, SHOP, baseOpts("page", ["hidden", "missingDescription"]));
    const andOne = whereOf(one.findMany).AND as unknown[];
    expect(andOne).toContainEqual({ isPublished: false });
    expect(andOne).toContainEqual({ attributesSyncedAt: { not: null } });
    expect(andOne).toContainEqual({ OR: [{ body: null }, { body: "" }] });

    const both = mockDb("page");
    await loadBulkRows(both.db as never, SHOP, baseOpts("page", ["hidden", "published"]));
    const andBoth = whereOf(both.findMany).AND as Record<string, unknown>[];
    expect(andBoth.some((c) => "isPublished" in c)).toBe(false);
    expect(andBoth).toContainEqual({ attributesSyncedAt: { not: null } });
  });

  it("collection kind maps onto isSmart", async () => {
    const { db, findMany } = mockDb("collection");
    await loadBulkRows(db as never, SHOP, baseOpts("collection", ["manualCollection"]));
    expect(whereOf(findMany).AND).toContainEqual({ isSmart: false });
  });

  it("drops ids the type does not speak instead of querying a missing column", async () => {
    const { db, findMany } = mockDb("page");
    await loadBulkRows(db as never, SHOP, baseOpts("page", ["statusDraft", "missingVendor", "missingSku"]));
    expect(whereOf(findMany).AND).toEqual([]);
  });

  it("variant rows filter by their product's status", async () => {
    const { db, findMany } = mockDb("productVariant");
    await loadBulkRows(db as never, SHOP, baseOpts("variant", ["statusArchived"]));
    expect(whereOf(findMany).product).toEqual({ shop: SHOP, status: { in: ["ARCHIVED"] } });
  });
});
