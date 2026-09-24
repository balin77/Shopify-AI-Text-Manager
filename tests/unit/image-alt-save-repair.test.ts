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

const policy = { autoTranslateExternalChanges: true, purgeUnreconciledSurfaces: false, purgeOnPrimaryChange: false };
vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: vi.fn(async () => policy),
}));
vi.mock("~/services/sync-utils", () => ({
  fetchShopLocales: vi.fn(async () => [
    { locale: "de", primary: true, published: true },
    { locale: "en", primary: false, published: true },
    { locale: "fr", primary: false, published: false },
  ]),
}));
const repair = vi.fn(async (_params: Record<string, unknown>) => ({ taskId: "task-1" }));
vi.mock("~/services/translations/product-alt-repair.server", () => ({ repairChangedProductAlts: repair }));
vi.mock("~/services/shopify-api-gateway.service", () => ({
  ShopifyApiGateway: class {
    graphql = vi.fn();
  },
}));

const { saveImageAltTextPrimary } = await import("~/actions/content/alt-text.action");

const MEDIA = "gid://shopify/MediaImage/9";

function setup(previousAlt: string | null) {
  const admin = {
    graphql: vi.fn(async () => ({
      json: async () => ({ data: { fileUpdate: { userErrors: [] as Array<{ message: string }> } } }),
    })),
  };
  const db = {
    productImage: {
      findFirst: vi.fn(async () => ({
        id: "img-row",
        productId: "gid://shopify/Product/1",
        altText: previousAlt,
        product: { title: "Box" },
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  return { admin, db };
}

beforeEach(() => vi.clearAllMocks());

describe("saveImageAltTextPrimary — the image manager's alt save repairs translations", () => {
  it("hands a CHANGED alt to the repair — every foreign locale, unpublished included", async () => {
    const { admin, db } = setup(null);
    const result = await saveImageAltTextPrimary({
      admin: admin as never,
      db: db as never,
      shop: "s.myshopify.com",
      mediaId: MEDIA,
      altText: "Neue Box",
    });

    expect(result).toMatchObject({ saved: true, retranslationTaskId: "task-1" });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair.mock.calls[0][0]).toMatchObject({
      productId: "gid://shopify/Product/1",
      changes: [{ imageId: "img-row", mediaId: MEDIA, alt: "Neue Box" }],
      foreignLocales: ["en", "fr"],
      primaryLocale: "de",
    });
  });

  it("an UNCHANGED alt is no change event — nothing re-translated, nothing deleted", async () => {
    const { admin, db } = setup("Neue Box");
    await saveImageAltTextPrimary({ admin: admin as never, db: db as never, shop: "s", mediaId: MEDIA, altText: "Neue Box " });
    expect(repair).not.toHaveBeenCalled();
  });

  it("a failed primary write repairs nothing", async () => {
    const { admin, db } = setup("alt");
    admin.graphql.mockResolvedValueOnce({
      json: async () => ({ data: { fileUpdate: { userErrors: [{ message: "bad" }] } } }),
    });
    const result = await saveImageAltTextPrimary({ admin: admin as never, db: db as never, shop: "s", mediaId: MEDIA, altText: "x" });
    expect(result.saved).toBe(false);
    expect(repair).not.toHaveBeenCalled();
  });
});
