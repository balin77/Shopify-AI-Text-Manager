/**
 * The plan-time read of the primary text (PLAN §19.1): before any AI work the
 * run asks Shopify what the text is NOW. A cell whose live text differs from
 * the cached source is dropped (counted, never a failure), the digests become
 * the cell's `expected` map, and a resource Shopify did not answer for is a
 * per-cell failure.
 */
import { describe, it, expect, vi } from "vitest";
import { planTranslateRead, planCellKey, type PlanJob } from "~/services/bulk-editor/translate-plan-read.server";
import {
  buildColumnsForType,
  BULK_COLUMNS_BY_TYPE,
  metafieldColumnId,
  optionColumnId,
  type ProductColumnCaps,
} from "~/services/bulk-editor/columns.shared";

const SHOP = "s.myshopify.com";
const caps: ProductColumnCaps = { metafields: true, options: true, imageAlt: false };
const productCols = buildColumnsForType("product", [{ namespace: "custom", key: "care", type: "single_line_text_field" }], caps);
const col = (id: string) => productCols.find((c) => c.id === id)!;
const P1 = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";

type Content = Record<string, { value: string; digest: string }>;

/** Aliased state query + the single-resource featured-image query. */
function gatewayFor(nodes: Record<string, Content | null>, extra: (q: string, v: any) => unknown = () => undefined) {
  const queries: string[] = [];
  const gateway = {
    graphql: async (query: string, o?: { variables?: Record<string, any> }) => {
      queries.push(query);
      const custom = extra(query, o?.variables);
      if (custom !== undefined) return { json: async () => custom };
      const data: Record<string, unknown> = {};
      const variables = o?.variables ?? {};
      for (let i = 0; `r${i}` in variables; i++) {
        const node = nodes[variables[`r${i}`]];
        data[`a${i}`] = node
          ? { translatableContent: Object.entries(node).map(([key, v]) => ({ key, value: v.value, digest: v.digest })) }
          : null;
      }
      return { json: async () => ({ data }) };
    },
  };
  return { gateway, queries };
}

const job = (rowId: string, cells: PlanJob["cells"]): PlanJob => ({ rowId, cells });
const cell = (columnId: string, source: string, locales = ["fr"]) => ({ column: col(columnId), source, locales });

const noDb = {
  productMetafield: { findMany: vi.fn(async () => []) },
  productOption: { findMany: vi.fn(async () => []) },
} as never;

describe("planTranslateRead", () => {
  it("keeps a cell whose live text equals the cached source and records the digest as expected", async () => {
    const { gateway } = gatewayFor({ [P1]: { title: { value: "Scarf", digest: "dt" }, body_html: { value: "<p>Wool</p>", digest: "db" } } });
    const plan = await planTranslateRead({ db: noDb, shop: SHOP, gateway, rowType: "product" }, [
      job(P1, [cell("field.title", "Scarf"), cell("field.descriptionHtml", "<p>Wool</p>")]),
    ]);
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].cells).toHaveLength(2);
    expect(plan.skippedChanged).toBe(0);
    expect(plan.expected.get(planCellKey(P1, "field.title"))).toEqual({ [P1]: "dt", "#order": P1 });
    expect(plan.expected.get(planCellKey(P1, "field.descriptionHtml"))).toEqual({ [P1]: "db", "#order": P1 });
  });

  it("drops a cell whose source changed at Shopify (counted in UNITS, not a failure); line endings and padding do not count as change", async () => {
    const { gateway } = gatewayFor({
      [P1]: { title: { value: "Scarf NEW", digest: "dt" }, body_html: { value: "<p>a</p>\r\n<p>b</p> ", digest: "db" } },
    });
    const plan = await planTranslateRead({ db: noDb, shop: SHOP, gateway, rowType: "product" }, [
      job(P1, [cell("field.title", "Scarf", ["fr", "es", "it"]), cell("field.descriptionHtml", "<p>a</p>\n<p>b</p>")]),
    ]);
    expect(plan.skippedChanged).toBe(3);
    expect(plan.failures).toEqual([]);
    expect(plan.jobs[0].cells.map((c) => c.column.id)).toEqual(["field.descriptionHtml"]);
    expect(plan.expected.has(planCellKey(P1, "field.title"))).toBe(false);
    expect(plan.mismatchesByKey).toEqual({ title: 3 });
  });

  it("a job with no cell left disappears", async () => {
    const { gateway } = gatewayFor({ [P1]: { title: { value: "different", digest: "dt" } } });
    const plan = await planTranslateRead({ db: noDb, shop: SHOP, gateway, rowType: "product" }, [
      job(P1, [cell("field.title", "Scarf")]),
    ]);
    expect(plan.jobs).toEqual([]);
    expect(plan.skippedChanged).toBe(1);
  });

  it("a resource Shopify did not answer for fails ITS cells before any AI is paid (unknown is not unchanged)", async () => {
    const { gateway } = gatewayFor({ [P1]: { title: { value: "Scarf", digest: "dt" } }, [P2]: null });
    const plan = await planTranslateRead({ db: noDb, shop: SHOP, gateway, rowType: "product" }, [
      job(P1, [cell("field.title", "Scarf")]),
      job(P2, [cell("field.title", "Hat", ["fr", "es"])]),
    ]);
    expect(plan.jobs.map((j) => j.rowId)).toEqual([P1]);
    expect(plan.failures).toEqual([
      expect.objectContaining({ rowId: P2, columnId: "field.title", units: 2 }),
    ]);
    expect(plan.skippedChanged).toBe(0);
  });

  it("a whole failed read fails every cell and keeps none", async () => {
    const gateway = { graphql: async () => { throw new Error("down"); } };
    const plan = await planTranslateRead({ db: noDb, shop: SHOP, gateway: gateway as never, rowType: "product" }, [
      job(P1, [cell("field.title", "Scarf")]),
    ]);
    expect(plan.jobs).toEqual([]);
    expect(plan.failures).toHaveLength(1);
  });

  it("a key Shopify does not list is left to the write path's own digest rule (a sentinel expectation, not dropped)", async () => {
    const { gateway } = gatewayFor({ [P1]: { title: { value: "Scarf", digest: "dt" } } });
    const plan = await planTranslateRead({ db: noDb, shop: SHOP, gateway, rowType: "product" }, [
      job(P1, [cell("field.seoTitle", "SEO scarf")]),
    ]);
    expect(plan.jobs[0].cells).toHaveLength(1);
    expect(plan.expected.get(planCellKey(P1, "field.seoTitle"))).toEqual({ [P1]: "#absent", "#order": P1 });
  });

  it("a metafield and an option-values cell are read on their OWN resources, entry by entry", async () => {
    const MF = "gid://shopify/Metafield/3";
    const V1 = "gid://shopify/ProductOptionValue/1";
    const V2 = "gid://shopify/ProductOptionValue/2";
    const db = {
      productMetafield: { findMany: vi.fn(async () => [{ id: MF, productId: P1, namespace: "custom", key: "care" }]) },
      productOption: {
        findMany: vi.fn(async () => [
          {
            id: "gid://shopify/ProductOption/5",
            productId: P1,
            position: 1,
            values: JSON.stringify([{ id: V1, name: "Red" }, { id: V2, name: "Blue" }]),
            linkedMetafieldKey: null,
          },
        ]),
      },
    } as never;
    const { gateway } = gatewayFor({
      [MF]: { value: { value: "Wash cold", digest: "dm" } },
      [V1]: { name: { value: "Red", digest: "d1" } },
      [V2]: { name: { value: "Blue", digest: "d2" } },
    });
    const plan = await planTranslateRead({ db, shop: SHOP, gateway, rowType: "product" }, [
      job(P1, [
        cell(metafieldColumnId("custom", "care"), "Wash cold"),
        cell(optionColumnId(1, "values"), "Red | Blue"),
      ]),
    ]);
    expect(plan.jobs[0].cells).toHaveLength(2);
    expect(plan.expected.get(planCellKey(P1, metafieldColumnId("custom", "care")))).toEqual({ [MF]: "dm", "#order": MF });
    expect(plan.expected.get(planCellKey(P1, optionColumnId(1, "values")))).toEqual({ [V1]: "d1", [V2]: "d2", "#order": `${V1},${V2}` });
  });

  it("an option-values cell is dropped when ANY of its entries changed", async () => {
    const V1 = "gid://shopify/ProductOptionValue/1";
    const V2 = "gid://shopify/ProductOptionValue/2";
    const db = {
      productMetafield: { findMany: vi.fn(async () => []) },
      productOption: {
        findMany: vi.fn(async () => [
          { id: "gid://shopify/ProductOption/5", productId: P1, position: 1, values: JSON.stringify([{ id: V1, name: "Red" }, { id: V2, name: "Blue" }]), linkedMetafieldKey: null },
        ]),
      },
    } as never;
    const { gateway } = gatewayFor({
      [V1]: { name: { value: "Red", digest: "d1" } },
      [V2]: { name: { value: "Navy", digest: "d2" } },
    });
    const plan = await planTranslateRead({ db, shop: SHOP, gateway, rowType: "product" }, [
      job(P1, [cell(optionColumnId(1, "values"), "Red | Blue", ["fr", "es"])]),
    ]);
    expect(plan.jobs).toEqual([]);
    expect(plan.skippedChanged).toBe(2);
  });

  it("a featured-alt cell is read on the IMAGE resource; a collection without an image fails its cell", async () => {
    const IMG = "gid://shopify/CollectionImage/9";
    const C1 = "gid://shopify/Collection/1";
    const C2 = "gid://shopify/Collection/2";
    const { gateway } = gatewayFor(
      { [IMG]: { alt: { value: "Blue vase", digest: "da" } } },
      (query, variables) =>
        query.includes("bulkFeaturedImageId")
          ? { data: { collection: { image: variables.id === C1 ? { id: IMG } : null } } }
          : undefined,
    );
    const colCols = BULK_COLUMNS_BY_TYPE.collection;
    const alt = colCols.find((c) => c.id === "img.featuredAlt")!;
    const plan = await planTranslateRead({ db: noDb, shop: SHOP, gateway, rowType: "collection" }, [
      job(C1, [{ column: alt, source: "Blue vase", locales: ["fr"] }]),
      job(C2, [{ column: alt, source: "Red vase", locales: ["fr"] }]),
    ]);
    expect(plan.expected.get(planCellKey(C1, "img.featuredAlt"))).toEqual({ [IMG]: "da", "#order": IMG });
    expect(plan.failures).toEqual([expect.objectContaining({ rowId: C2 })]);
    expect(plan.jobs.map((j) => j.rowId)).toEqual([C1]);
  });
  it("a THROWING featured-image lookup is an unreadable cell, not 'no featured image'", async () => {
    const C1 = "gid://shopify/Collection/1";
    const { gateway } = gatewayFor({}, (query) => {
      if (query.includes("bulkFeaturedImageId")) throw new Error("throttled");
      return undefined;
    });
    const alt = BULK_COLUMNS_BY_TYPE.collection.find((c) => c.id === "img.featuredAlt")!;
    const plan = await planTranslateRead({ db: noDb, shop: SHOP, gateway, rowType: "collection" }, [
      job(C1, [{ column: alt, source: "Blue vase", locales: ["fr"] }]),
    ]);
    expect(plan.failures).toEqual([expect.objectContaining({ rowId: C1, message: expect.stringContaining("could not be read") })]);
    expect(plan.failures[0].message).not.toMatch(/no featured image/);
  });
});
