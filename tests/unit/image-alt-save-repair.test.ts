/**
 * The image manager's per-image alt save (`saveImageAltTextPrimary`) used to
 * write the primary alt and do NOTHING else: no re-translation with
 * auto-translate on, no deletion with it off — while the product editor's own
 * save did both. It now hands a CHANGED alt to the same repair
 * (product-alt-repair.server.ts); an unchanged one is no change event.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loggers: new Proxy({}, { get: () => vi.fn() }),
}));

const snapshot = new Map([["gid://shopify/MediaImage/9", { imageId: "img-row", productId: "p", altText: null, productTitle: "Box" }]]);
const snapshotProductAlts = vi.fn(async (_db: unknown, _shop: string, _ids: string[]) => snapshot);
const repairAltsAfterWrite = vi.fn(async (_params: Record<string, unknown>) => ["task-1"]);
vi.mock("~/services/translations/product-alt-repair.server", () => ({ snapshotProductAlts, repairAltsAfterWrite }));
vi.mock("~/services/shopify-api-gateway.service", () => ({
  ShopifyApiGateway: class {
    graphql = vi.fn();
  },
}));

const { saveImageAltTextPrimary } = await import("~/actions/content/alt-text.action");

const MEDIA = "gid://shopify/MediaImage/9";

function setup(echoedAlt?: string) {
  const admin = {
    graphql: vi.fn(async () => ({
      json: async () => ({
        data: {
          fileUpdate: {
            files: echoedAlt === undefined ? [] : [{ id: MEDIA, alt: echoedAlt }],
            userErrors: [] as Array<{ message: string }>,
          },
        },
      }),
    })),
  };
  const db = { productImage: { updateMany: vi.fn(async () => ({ count: 1 })) } };
  return { admin, db };
}

beforeEach(() => vi.clearAllMocks());

describe("saveImageAltTextPrimary — the image manager's alt save repairs translations", () => {
  it("snapshots BEFORE the write and hands what Shopify stored to the repair", async () => {
    const { admin, db } = setup("Neue Box");
    const result = await saveImageAltTextPrimary({
      admin: admin as never,
      db: db as never,
      shop: "s.myshopify.com",
      mediaId: MEDIA,
      altText: "Neue Box ",
    });

    expect(result).toMatchObject({ saved: true, retranslationTaskId: "task-1" });
    expect(snapshotProductAlts.mock.invocationCallOrder[0]).toBeLessThan(admin.graphql.mock.invocationCallOrder[0]);
    expect(repairAltsAfterWrite.mock.calls[0][0]).toMatchObject({
      snapshot,
      written: [{ mediaId: MEDIA, alt: "Neue Box" }],
    });
  });

  it("a failed primary write repairs nothing", async () => {
    const { admin, db } = setup();
    admin.graphql.mockResolvedValueOnce({
      json: async () => ({ data: { fileUpdate: { files: [], userErrors: [{ message: "bad" }] } } }),
    });
    const result = await saveImageAltTextPrimary({ admin: admin as never, db: db as never, shop: "s", mediaId: MEDIA, altText: "x" });
    expect(result.saved).toBe(false);
    expect(repairAltsAfterWrite).not.toHaveBeenCalled();
  });
});
