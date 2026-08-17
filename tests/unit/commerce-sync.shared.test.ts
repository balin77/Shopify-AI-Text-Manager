/**
 * PLAN_CONTENT_CREATION Phase 4 — the commerce block's read side.
 *
 * Almost every test here is about a NUMBER not being written when it is not
 * known. Stock is money: a 0 where the answer is "untracked" tells a merchant
 * they are sold out of something they can sell without limit, and a
 * `commerceSyncedAt` stamped on a half-delivered response makes every reader
 * downstream treat defaults as measurements.
 */

import { describe, it, expect } from "vitest";
import {
  hasVariantCommerce,
  inventoryLevelRows,
  productPublicationRows,
  stockIsMeaningful,
  variantCommerceColumns,
} from "../../app/services/commerce-sync.shared";

const NOW = new Date("2026-08-17T00:00:00.000Z");

const fullVariant = (overrides: Record<string, unknown> = {}) => ({
  taxable: true,
  inventoryPolicy: "DENY",
  inventoryItem: {
    id: "gid://shopify/InventoryItem/1",
    tracked: true,
    requiresShipping: true,
    countryCodeOfOrigin: "DE",
    harmonizedSystemCode: "610910",
    unitCost: { amount: "4.50" },
    measurement: { weight: { value: 0.35, unit: "KILOGRAMS" } },
    inventoryLevels: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          location: { id: "gid://shopify/Location/1", name: "Berlin", isActive: true },
          quantities: [
            { name: "on_hand", quantity: 12 },
            { name: "available", quantity: 9 },
          ],
        },
      ],
    },
  },
  ...overrides,
});

describe("hasVariantCommerce", () => {
  it("checks for the KEYS, not for truthy values", () => {
    // `taxable: false` and `inventoryItem: null` are real answers. A truthiness
    // check would read a legitimately untracked variant as an unfetched one.
    expect(hasVariantCommerce({ taxable: false, inventoryPolicy: "", inventoryItem: null })).toBe(true);
  });

  it("is false when the query did not select the block", () => {
    expect(hasVariantCommerce({ title: "M", sku: "A-1" })).toBe(false);
    expect(hasVariantCommerce(null)).toBe(false);
  });

  it("is false for a HALF-delivered block", () => {
    // Worse than nothing: written as defaults it would stamp
    // `commerceSyncedAt`, which every reader takes as "this is real data".
    expect(hasVariantCommerce({ taxable: true, inventoryPolicy: "DENY" })).toBe(false);
  });
});

describe("variantCommerceColumns", () => {
  it("maps a full block, money as a STRING", () => {
    const columns = variantCommerceColumns(fullVariant() as never, NOW);
    expect(columns).toMatchObject({
      inventoryItemId: "gid://shopify/InventoryItem/1",
      // A float conversion here is the rounding error the Decimal column
      // exists to avoid.
      cost: "4.50",
      taxable: true,
      requiresShipping: true,
      weight: "0.35",
      weightUnit: "KILOGRAMS",
      harmonizedSystemCode: "610910",
      countryCodeOfOrigin: "DE",
      inventoryTracked: true,
      inventoryPolicy: "DENY",
      commerceSyncedAt: NOW,
    });
  });

  it("writes NOTHING when the block is absent", () => {
    // `{}` spreads into the upsert as nothing, so the existing columns — and
    // `commerceSyncedAt` with them — survive a narrower query.
    expect(variantCommerceColumns({ title: "M" } as never, NOW)).toEqual({});
  });

  it("never stamps commerceSyncedAt on an unwritten block", () => {
    expect(variantCommerceColumns(undefined, NOW).commerceSyncedAt).toBeUndefined();
  });

  it("carries an untracked variant as FALSE, not as missing", () => {
    const columns = variantCommerceColumns(
      fullVariant({ inventoryItem: { id: "gid://shopify/InventoryItem/2", tracked: false } }) as never,
      NOW,
    );
    expect(columns.inventoryTracked).toBe(false);
    expect(columns.commerceSyncedAt).toBe(NOW);
  });

  it("maps a variant with no inventory item at all", () => {
    const columns = variantCommerceColumns(fullVariant({ inventoryItem: null }) as never, NOW);
    expect(columns.inventoryItemId).toBeNull();
    expect(columns.cost).toBeNull();
    // Still a real answer, so the block counts as synced.
    expect(columns.commerceSyncedAt).toBe(NOW);
  });
});

describe("inventoryLevelRows", () => {
  it("returns the rows and the locations they mention", () => {
    const result = inventoryLevelRows("s.myshopify.com", "42", fullVariant() as never);
    expect(result?.rows).toEqual([
      {
        shop: "s.myshopify.com",
        inventoryItemId: "gid://shopify/InventoryItem/1",
        variantId: "42",
        locationId: "gid://shopify/Location/1",
        onHand: 12,
        available: 9,
      },
    ]);
    expect(result?.locations[0]).toMatchObject({ id: "gid://shopify/Location/1", name: "Berlin", isActive: true });
    expect(result?.hasMore).toBe(false);
  });

  it("returns NULL when the block was not delivered", () => {
    // The caller's signal to SKIP the rebuild. Wiping instead would report
    // stock that vanished.
    expect(inventoryLevelRows("s", "42", { title: "M" } as never)).toBeNull();
  });

  it("distinguishes 'no stock anywhere' from 'not delivered'", () => {
    const result = inventoryLevelRows("s", "42", fullVariant({ inventoryItem: null }) as never);
    expect(result).not.toBeNull();
    expect(result?.rows).toEqual([]);
  });

  it("reads a quantity Shopify did not return as UNKNOWN, never 0", () => {
    const variant = fullVariant({
      inventoryItem: {
        id: "gid://shopify/InventoryItem/1",
        inventoryLevels: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              location: { id: "gid://shopify/Location/1", name: "Berlin", isActive: true },
              quantities: [{ name: "on_hand", quantity: 3 }],
            },
          ],
        },
      },
    });
    const result = inventoryLevelRows("s", "42", variant as never);
    expect(result?.rows[0].onHand).toBe(3);
    // 0 would say "sold out". Null says "we do not know".
    expect(result?.rows[0].available).toBeNull();
  });

  it("reports a cut-off location window", () => {
    const variant = fullVariant({
      inventoryItem: {
        id: "gid://shopify/InventoryItem/1",
        inventoryLevels: { pageInfo: { hasNextPage: true }, nodes: [] },
      },
    });
    expect(inventoryLevelRows("s", "42", variant as never)?.hasMore).toBe(true);
  });

  it("mirrors a deactivated location rather than dropping it", () => {
    const variant = fullVariant({
      inventoryItem: {
        id: "gid://shopify/InventoryItem/1",
        inventoryLevels: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              location: { id: "gid://shopify/Location/9", name: "Old depot", isActive: false },
              quantities: [{ name: "on_hand", quantity: 5 }],
            },
          ],
        },
      },
    });
    // It keeps its stock, so hiding it would read as stock that disappeared.
    expect(inventoryLevelRows("s", "42", variant as never)?.locations[0].isActive).toBe(false);
  });
});

describe("productPublicationRows", () => {
  it("takes Shopify's own isPublished verbatim", () => {
    // It already accounts for a future publish date. Recomputing it from the
    // date is a second answer to one question, and the two would drift.
    const result = productPublicationRows("s", "7", {
      pageInfo: { hasNextPage: false },
      nodes: [
        { isPublished: true, publishDate: null, publication: { id: "gid://shopify/Publication/1", name: "Online Store" } },
        { isPublished: false, publishDate: "2099-01-01T00:00:00Z", publication: { id: "gid://shopify/Publication/2", name: "POS" } },
      ],
    } as never);
    expect(result?.rows[0]).toMatchObject({ publicationId: "gid://shopify/Publication/1", isPublished: true });
    // Scheduled is NOT live — collapsing the two makes a planned launch look
    // like a mistake.
    expect(result?.rows[1].isPublished).toBe(false);
    expect(result?.rows[1].publishDate).toBeInstanceOf(Date);
  });

  it("returns NULL when the block was not delivered", () => {
    // An empty publication list IS a meaningful state (§2.3 — invisible
    // everywhere), so wiping on a partial response would manufacture exactly
    // the alarming state this feature exists to reveal.
    expect(productPublicationRows("s", "7", null)).toBeNull();
  });

  it("reads an EMPTY channel list as a real answer", () => {
    const result = productPublicationRows("s", "7", { pageInfo: { hasNextPage: false }, nodes: [] } as never);
    expect(result).not.toBeNull();
    expect(result?.rows).toEqual([]);
  });

  it("drops an unparsable publish date rather than storing Invalid Date", () => {
    const result = productPublicationRows("s", "7", {
      nodes: [{ isPublished: true, publishDate: "not a date", publication: { id: "gid://shopify/Publication/1", name: "X" } }],
    } as never);
    expect(result?.rows[0].publishDate).toBeNull();
  });
});

describe("stockIsMeaningful", () => {
  it("separates untracked from unknown", () => {
    expect(stockIsMeaningful(true)).toBe(true);
    // Shopify keeps no count — there is nothing to show and nothing to write.
    expect(stockIsMeaningful(false)).toBe(false);
    // Never synced. A third state, and it renders as "unknown", not as 0.
    expect(stockIsMeaningful(null)).toBe(false);
  });
});
