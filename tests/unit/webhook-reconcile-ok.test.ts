/** reconcileWebhookBackedTypes reports `ok` per type (plan 2.4): the catch-up clears its flag only when all are ok. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  settings: vi.fn(),
  productFind: vi.fn(),
  collectionFind: vi.fn(),
  syncProduct: vi.fn(),
  syncCollection: vi.fn(),
}));
vi.mock("../../app/db.server", () => ({
  db: {
    aISettings: { findUnique: (...a: unknown[]) => h.settings(...a) },
    product: { findMany: (...a: unknown[]) => h.productFind(...a) },
    collection: { findMany: (...a: unknown[]) => h.collectionFind(...a) },
  },
}));
vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../app/services/product-sync.service", () => ({
  ProductSyncService: class {
    syncProduct = (...a: unknown[]) => h.syncProduct(...a);
    deleteProduct = vi.fn();
  },
}));
vi.mock("../../app/services/content-sync.service", () => ({
  ContentSyncService: class {
    syncCollection = (...a: unknown[]) => h.syncCollection(...a);
    deleteCollection = vi.fn();
  },
}));

import { reconcileWebhookBackedTypes } from "../../app/services/webhook-reconcile.service";

const listing = (root: string, nodes: Array<{ id: string; updatedAt: string }>, fail = false) => ({
  graphql: vi.fn(async (q: string) => ({
    json: async () => {
      if (fail && q.includes(root)) return { errors: [{ message: "x" }] };
      return {
        data: {
          products: { pageInfo: { hasNextPage: false }, edges: root === "products" || !q.includes("collections") ? nodes.map((node) => ({ node })) : [] },
          collections: { pageInfo: { hasNextPage: false }, edges: nodes.map((node) => ({ node })) },
        },
      };
    },
  })),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.settings.mockResolvedValue({ subscriptionPlan: "max" });
  h.productFind.mockResolvedValue([{ id: "p1", shopifyUpdatedAt: new Date("2026-01-01") }]);
  h.collectionFind.mockResolvedValue([{ id: "p1", shopifyUpdatedAt: new Date("2026-01-01") }]);
  h.syncProduct.mockResolvedValue(undefined);
  h.syncCollection.mockResolvedValue(undefined);
});

describe("reconcileWebhookBackedTypes ok", () => {
  it("is ok for a clean pass", async () => {
    const r = await reconcileWebhookBackedTypes(listing("x", [{ id: "p1", updatedAt: "2026-01-01T00:00:00Z" }]) as never, "s.myshopify.com");
    expect(r.ok).toEqual({ products: true, collections: true });
  });

  it("an item that fails to sync makes its type not ok", async () => {
    h.syncProduct.mockRejectedValue(new Error("boom"));
    const r = await reconcileWebhookBackedTypes(listing("x", [{ id: "p1", updatedAt: "2027-01-01T00:00:00Z" }]) as never, "s.myshopify.com");
    expect(r.ok.products).toBe(false);
    expect(r.ok.collections).toBe(true);
  });

  it("a failed listing makes the type not ok", async () => {
    const r = await reconcileWebhookBackedTypes(listing("collections", [], true) as never, "s.myshopify.com");
    expect(r.ok.collections).toBe(false);
  });

  it("an inconclusive empty answer (shop has local rows) is not ok", async () => {
    const r = await reconcileWebhookBackedTypes(listing("x", []) as never, "s.myshopify.com");
    expect(r.ok.products).toBe(false);
  });
});
