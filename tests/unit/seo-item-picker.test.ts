import { describe, it, expect, vi } from "vitest";

// The item-picker route pulls in Shopify auth + Prisma + logger at module load.
// buildWhere / buildCursorArgs are pure and touch none of them, so we stub the
// server-only deps just enough for the module to import cleanly.
vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ db: {} }));
vi.mock("../../app/utils/logger.server", () => ({ logger: { error: vi.fn() } }));

import { buildWhere, buildCursorArgs } from "../../app/routes/api.seo.item-picker";

const SHOP = "s.myshopify.com";

describe("item-picker buildWhere (§4.2)", () => {
  it("Product with productType + q combines shop, insensitive title contains, and productType", () => {
    expect(buildWhere(SHOP, "Product", "vase", "Vasen")).toEqual({
      shop: SHOP,
      title: { contains: "vase", mode: "insensitive" },
      productType: "Vasen",
    });
  });

  it("omits the title filter when q is empty", () => {
    expect(buildWhere(SHOP, "Product", "", "Vasen")).toEqual({
      shop: SHOP,
      productType: "Vasen",
    });
  });

  it("applies productType only for Product (ignored for other types)", () => {
    // A Collection query must not carry a productType filter even if one is passed.
    expect(buildWhere(SHOP, "Collection", "vase", "Vasen")).toEqual({
      shop: SHOP,
      title: { contains: "vase", mode: "insensitive" },
    });
  });

  it("is just the shop scope when neither q nor productType is set", () => {
    expect(buildWhere(SHOP, "Page", "", "")).toEqual({ shop: SHOP });
  });
});

describe("item-picker buildCursorArgs (§4.2 paging)", () => {
  it("returns an empty object for the first page (no cursor)", () => {
    expect(buildCursorArgs(SHOP, "")).toEqual({});
  });

  it("skips the cursor row itself on a cursor page", () => {
    expect(buildCursorArgs(SHOP, "prod_123")).toEqual({
      cursor: { shop_id: { shop: SHOP, id: "prod_123" } },
      skip: 1,
    });
  });
});
