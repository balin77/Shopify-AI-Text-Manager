import { describe, it, expect } from "vitest";
import {
  publicationCatalogKind,
  countsAsSalesChannel,
  productPublicationRows,
  marketPublicationView,
} from "../../app/services/commerce-sync.shared";

describe("publicationCatalogKind", () => {
  it("maps Shopify's three catalog types", () => {
    expect(publicationCatalogKind("AppCatalog")).toBe("app");
    expect(publicationCatalogKind("MarketCatalog")).toBe("market");
    expect(publicationCatalogKind("CompanyLocationCatalog")).toBe("companyLocation");
  });

  it("reads anything else as UNKNOWN, never as a sales channel", () => {
    // A nullable catalog, a type this app has not seen yet, or a row cached
    // before the column existed — all three must be indistinguishable from
    // each other and none of them may claim to be an AppCatalog.
    for (const value of [undefined, null, "", "SomethingNew", 42]) {
      expect(publicationCatalogKind(value)).toBe("");
    }
  });
});

describe("countsAsSalesChannel", () => {
  it("excludes only what is KNOWN to be something else", () => {
    expect(countsAsSalesChannel("app")).toBe(true);
    expect(countsAsSalesChannel("market")).toBe(false);
    expect(countsAsSalesChannel("companyLocation")).toBe(false);
  });

  it("counts an unknown catalog, so the invisibility alarm cannot misfire", () => {
    expect(countsAsSalesChannel("")).toBe(true);
  });
});

describe("productPublicationRows", () => {
  const node = (id: string, typename: string | null, isPublished = true) => ({
    isPublished,
    publishDate: null,
    publication: {
      id: `gid://shopify/Publication/${id}`,
      name: id,
      catalog: typename === null ? null : { __typename: typename },
    },
  });

  it("carries the catalog type onto every row", () => {
    const result = productPublicationRows("s.myshopify.com", "gid://shopify/Product/1", {
      pageInfo: { hasNextPage: false },
      nodes: [node("online", "AppCatalog"), node("ch", "MarketCatalog"), node("acme", "CompanyLocationCatalog")],
    } as never);

    expect(result!.rows.map((r) => r.catalogType)).toEqual(["app", "market", "companyLocation"]);
  });

  it("stores an absent catalog as unknown rather than dropping the row", () => {
    const result = productPublicationRows("s.myshopify.com", "gid://shopify/Product/1", {
      pageInfo: { hasNextPage: false },
      nodes: [node("mystery", null)],
    } as never);

    expect(result!.rows).toHaveLength(1);
    expect(result!.rows[0].catalogType).toBe("");
    expect(countsAsSalesChannel(result!.rows[0].catalogType)).toBe(true);
  });

  it("still reports a truncated window and still refuses a missing response", () => {
    expect(productPublicationRows("s", "p", null)).toBeNull();
    const truncated = productPublicationRows("s", "p", {
      pageInfo: { hasNextPage: true },
      nodes: [node("online", "AppCatalog")],
    } as never);
    expect(truncated!.hasMore).toBe(true);
  });
});

describe("marketPublicationView", () => {
  const marketCatalog = (
    marketIds: string[],
    isPublished: boolean,
    opts?: { marketsTruncated?: boolean },
  ) => ({
    isPublished,
    publication: {
      id: "gid://shopify/Publication/1",
      catalog: {
        __typename: "MarketCatalog",
        markets: {
          pageInfo: { hasNextPage: opts?.marketsTruncated === true },
          nodes: marketIds.map((id) => ({ id })),
        },
      },
    },
  });

  it("splits scoped from published", () => {
    const view = marketPublicationView({
      pageInfo: { hasNextPage: false },
      nodes: [
        marketCatalog(["gid://shopify/Market/1"], true),
        marketCatalog(["gid://shopify/Market/2"], false),
      ],
    })!;

    expect(view.scopedMarketIds.sort()).toEqual(["gid://shopify/Market/1", "gid://shopify/Market/2"]);
    expect(view.publishedMarketIds).toEqual(["gid://shopify/Market/1"]);
    expect(view.truncated).toBe(false);
  });

  it("counts a market published if ANY of its catalogs carries the product", () => {
    const view = marketPublicationView({
      pageInfo: { hasNextPage: false },
      nodes: [
        marketCatalog(["gid://shopify/Market/1"], false),
        marketCatalog(["gid://shopify/Market/1"], true),
      ],
    })!;

    expect(view.publishedMarketIds).toEqual(["gid://shopify/Market/1"]);
  });

  it("ignores sales channels and B2B catalogs", () => {
    const view = marketPublicationView({
      pageInfo: { hasNextPage: false },
      nodes: [
        { isPublished: true, publication: { id: "p1", catalog: { __typename: "AppCatalog" } } },
        { isPublished: true, publication: { id: "p2", catalog: { __typename: "CompanyLocationCatalog" } } },
      ],
    })!;

    expect(view.scopedMarketIds).toEqual([]);
    expect(view.publishedMarketIds).toEqual([]);
  });

  it("propagates truncation from BOTH windows", () => {
    const outer = marketPublicationView({
      pageInfo: { hasNextPage: true },
      nodes: [marketCatalog(["gid://shopify/Market/1"], true)],
    })!;
    expect(outer.truncated).toBe(true);

    const inner = marketPublicationView({
      pageInfo: { hasNextPage: false },
      nodes: [marketCatalog(["gid://shopify/Market/1"], true, { marketsTruncated: true })],
    })!;
    expect(inner.truncated).toBe(true);
  });

  it("refuses a missing block rather than reporting every market as unscoped", () => {
    expect(marketPublicationView(null)).toBeNull();
    expect(marketPublicationView(undefined)).toBeNull();
    // Delivered but empty IS an answer: the shop has no market catalogs.
    expect(marketPublicationView({ pageInfo: { hasNextPage: false }, nodes: [] })).toEqual({
      scopedMarketIds: [],
      publishedMarketIds: [],
      scheduledMarketIds: [],
      truncated: false,
    });
  });

  it("reports a SCHEDULED market launch as scheduled, not as missing", () => {
    // Shopify answers `isPublished: false` for a future publish date. Read as
    // "not in the catalog" it would tell a merchant to add what they already
    // added.
    const view = marketPublicationView({
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          isPublished: false,
          publishDate: "2099-01-01T00:00:00Z",
          publication: {
            id: "gid://shopify/Publication/1",
            catalog: {
              __typename: "MarketCatalog",
              markets: { pageInfo: { hasNextPage: false }, nodes: [{ id: "gid://shopify/Market/1" }] },
            },
          },
        },
      ],
    })!;

    expect(view.scopedMarketIds).toEqual(["gid://shopify/Market/1"]);
    expect(view.publishedMarketIds).toEqual([]);
    expect(view.scheduledMarketIds).toEqual(["gid://shopify/Market/1"]);
  });

  it("keeps a market with NO date as genuinely missing", () => {
    const view = marketPublicationView({
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          isPublished: false,
          publishDate: null,
          publication: {
            id: "gid://shopify/Publication/1",
            catalog: {
              __typename: "MarketCatalog",
              markets: { pageInfo: { hasNextPage: false }, nodes: [{ id: "gid://shopify/Market/1" }] },
            },
          },
        },
      ],
    })!;

    expect(view.scheduledMarketIds).toEqual([]);
    expect(view.publishedMarketIds).toEqual([]);
    expect(view.scopedMarketIds).toEqual(["gid://shopify/Market/1"]);
  });
});
