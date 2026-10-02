/**
 * The image manager's alt texts for a MEDIA-LIBRARY file (a library pick in a
 * variant gallery, no ProductImage row): the foreign save mirrors into
 * ContentTranslation("MediaImage") -- the bulk editor's store for it -- and the
 * load reads that store back for the gallery's GIDs, with the same layering.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loggers: new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock("~/utils/translation-save-lock.server", () => ({
  markTranslationSaved: vi.fn(),
  isTranslationRecentlySaved: vi.fn().mockReturnValue(false),
}));
vi.mock("~/services/shopify-api-gateway.service", () => ({
  ShopifyApiGateway: class {
    constructor(private admin: { graphql: (q: string, o?: unknown) => Promise<unknown> }) {}
    graphql(q: string, o?: unknown) {
      return this.admin.graphql(q, o);
    }
  },
}));

const SHOP = "s.myshopify.com";
const PRODUCT_MEDIA = "gid://shopify/MediaImage/1";
const LIBRARY = "gid://shopify/MediaImage/900";
const MARKET = "gid://shopify/Market/77";

function fakeAdmin() {
  const removes: Array<Record<string, any>> = [];
  const graphql = vi.fn(async (query: string, options?: { variables?: Record<string, any> }) => {
    const v = options?.variables ?? {};
    let body: unknown = { data: {} };
    if (query.includes("translationsRegister(")) {
      body = {
        data: {
          translationsRegister: {
            userErrors: [],
            translations: v.translations.map((x: any) => ({ key: x.key, locale: x.locale, value: x.value, market: null })),
          },
        },
      };
    } else if (query.includes("translationsRemove(")) {
      removes.push(v);
      body = { data: { translationsRemove: { userErrors: [], translations: v.locales.map((l: string) => ({ key: "alt", locale: l })) } } };
    } else if (query.includes("translatableResource")) {
      body = { data: { translatableResource: { resourceId: v.resourceId ?? v.id, translatableContent: [{ key: "alt", digest: "dg", value: "x" }] } } };
    }
    return { ok: true, status: 200, json: async () => body };
  });
  return { graphql, removes };
}

function makeDb() {
  const productImages = [{ id: "row-a", mediaId: PRODUCT_MEDIA, productId: "p1" }];
  return {
    productImage: {
      findFirst: vi.fn(async ({ where }: any) => productImages.find((i) => i.mediaId === where.mediaId) ?? null),
      findMany: vi.fn(async ({ where }: any) =>
        productImages.filter((i) => where.mediaId.in.includes(i.mediaId)).map((i) => ({ mediaId: i.mediaId })),
      ),
    },
    productImageAltTranslation: {
      findMany: vi.fn(async () => [] as any[]),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    contentTranslation: {
      findMany: vi.fn(async () => [] as any[]),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  } as any;
}

beforeEach(() => vi.clearAllMocks());

async function save(admin: any, db: any, altText: string, marketId?: string) {
  const { handleSaveImageAltText } = await import("~/actions/content/alt-text.action");
  const fd = new FormData();
  fd.set("mediaId", LIBRARY);
  fd.set("altText", altText);
  fd.set("locale", "de");
  fd.set("primaryLocale", "en");
  if (marketId) fd.set("marketId", marketId);
  const res: any = await handleSaveImageAltText({ admin, db, session: { shop: SHOP } } as never, fd);
  return res.data ?? res;
}

describe("handleSaveImageAltText on a media-library file", () => {
  it("mirrors into ContentTranslation(MediaImage) with the register's digest", async () => {
    const db = makeDb();
    const body = await save(fakeAdmin(), db, "Kiste", MARKET);
    expect(body.success).toBe(true);
    expect(body.notMirrored).toBeUndefined();
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
    const call = db.contentTranslation.upsert.mock.calls[0][0];
    expect(call.where.shop_resourceId_key_locale_marketId).toEqual({
      shop: SHOP,
      resourceId: LIBRARY,
      key: "alt",
      locale: "de",
      marketId: MARKET,
    });
    expect(call.create).toMatchObject({ resourceType: "MediaImage", value: "Kiste", digest: "dg" });
  });

  it("a confirmed clear deletes only that layer's library row", async () => {
    const db = makeDb();
    const admin = fakeAdmin();
    const body = await save(admin, db, "", MARKET);
    expect(body.success).toBe(true);
    expect(admin.removes[0].marketIds).toEqual([MARKET]);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toEqual({
      shop: SHOP,
      resourceId: LIBRARY,
      resourceType: "MediaImage",
      key: "alt",
      locale: "de",
      marketId: MARKET,
    });
  });

  it("a mirror failure is reported, not swallowed (Shopify holds the value)", async () => {
    const db = makeDb();
    db.contentTranslation.upsert.mockRejectedValue(new Error("db down"));
    const body = await save(fakeAdmin(), db, "Kiste");
    expect(body.success).toBe(true);
    expect(body.notMirrored).toBe(true);
  });
});

describe("handleLoadImageAltTranslations reads library files too", () => {
  async function load(db: any, fields: Record<string, string>) {
    const { handleLoadImageAltTranslations } = await import("~/actions/content/alt-text.action");
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const res: any = await handleLoadImageAltTranslations({ db, itemId: "p1", session: { shop: SHOP } } as never, fd);
    return res.data ?? res;
  }

  it("layers the library rows like the product ones, and only for MediaImage GIDs without a ProductImage row", async () => {
    const db = makeDb();
    db.productImageAltTranslation.findMany.mockResolvedValue([
      { altText: "Produkt", marketId: "", image: { mediaId: PRODUCT_MEDIA } },
    ]);
    db.contentTranslation.findMany.mockResolvedValue([
      { resourceId: LIBRARY, marketId: "", value: "Bibliothek global" },
    ]);
    const body = await load(db, {
      productId: "p1",
      locale: "de",
      marketId: MARKET,
      mediaIds: JSON.stringify([PRODUCT_MEDIA, LIBRARY, "gid://shopify/Product/5", 42]),
    });
    const where = db.contentTranslation.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ shop: SHOP, resourceType: "MediaImage", key: "alt", locale: "de", marketId: { in: ["", MARKET] } });
    expect(where.resourceId).toEqual({ in: [LIBRARY] });
    expect(body.altTexts).toEqual({ [PRODUCT_MEDIA]: "Produkt", [LIBRARY]: "Bibliothek global" });
    expect(body.inheritedMediaIds.sort()).toEqual([PRODUCT_MEDIA, LIBRARY].sort());
  });

  it("without mediaIds nothing but the product's own rows is read", async () => {
    const db = makeDb();
    await load(db, { productId: "p1", locale: "de" });
    expect(db.contentTranslation.findMany).not.toHaveBeenCalled();
  });
});

describe("layerImageAltRows", () => {
  it("a market row overrides, a global-only value is inherited, an empty one is not", async () => {
    const { layerImageAltRows } = await import("~/actions/content/alt-text.action");
    const out = layerImageAltRows(
      [
        { mediaId: "a", marketId: "", altText: "g a" },
        { mediaId: "a", marketId: MARKET, altText: "m a" },
        { mediaId: "b", marketId: "", altText: "g b" },
        { mediaId: "c", marketId: "", altText: " " },
      ],
      MARKET,
    );
    expect(out.altTexts).toEqual({ a: "m a", b: "g b", c: " " });
    expect(out.inheritedMediaIds).toEqual(["b"]);
    expect(layerImageAltRows([{ mediaId: "a", marketId: MARKET, altText: "m" }], "").altTexts).toEqual({});
  });
});

describe("shared media: this product's row wins (F4)", () => {
  it("drops another product's rows for a medium this product has a row for", async () => {
    const { preferOwnProductAltRows } = await import("~/actions/content/alt-text.action");
    const rows = preferOwnProductAltRows(
      [
        { altText: "eigen global", marketId: "", image: { mediaId: "m1", productId: "p1" } },
        { altText: "fremd markt", marketId: MARKET, image: { mediaId: "m1", productId: "p2" } },
        { altText: "fremd global", marketId: "", image: { mediaId: "m1", productId: "p2" } },
        { altText: "nur fremd", marketId: "", image: { mediaId: "m2", productId: "p2" } },
        { altText: "ohne media", marketId: "", image: { mediaId: null, productId: "p1" } },
      ],
      "p1",
    );
    expect(rows).toEqual([
      { mediaId: "m1", marketId: "", altText: "eigen global" },
      { mediaId: "m2", marketId: "", altText: "nur fremd" },
    ]);
  });

  it("the foreign save mirrors into THIS product's ProductImage row", async () => {
    const db = makeDb();
    const P1 = "gid://shopify/Product/1";
    db.productImage.findFirst.mockImplementation(async ({ where }: any) =>
      where.mediaId === PRODUCT_MEDIA && (!where.productId || where.productId === P1) ? { id: "row-own", productId: P1 } : null,
    );
    const { handleSaveImageAltText } = await import("~/actions/content/alt-text.action");
    const fd = new FormData();
    fd.set("mediaId", PRODUCT_MEDIA);
    fd.set("altText", "Kiste");
    fd.set("locale", "de");
    fd.set("primaryLocale", "en");
    fd.set("productId", P1);
    const res: any = await handleSaveImageAltText({ admin: fakeAdmin(), db, session: { shop: SHOP } } as never, fd);
    const body = res.data ?? res;
    expect(body.success).toBe(true);
    const scoped = db.productImage.findFirst.mock.calls.find(([a]: any) => a.where.productId === P1);
    expect(scoped).toBeTruthy();
    expect(db.productImageAltTranslation.upsert.mock.calls[0][0].create.imageId).toBe("row-own");
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it("refuses a foreign save for an id that is not a MediaImage GID", async () => {
    const { handleSaveImageAltText } = await import("~/actions/content/alt-text.action");
    const fd = new FormData();
    fd.set("mediaId", "gid://shopify/Product/5");
    fd.set("altText", "x");
    fd.set("locale", "de");
    fd.set("primaryLocale", "en");
    const res: any = await handleSaveImageAltText({ admin: fakeAdmin(), db: makeDb(), session: { shop: SHOP } } as never, fd);
    expect((res.data ?? res).success).toBe(false);
  });
});

describe("mirrorImageAltAnyStore never writes a stray library row for a product medium (F5)", () => {
  const p2003 = () => Object.assign(new Error("fk"), { code: "P2003" });

  it("retries once when a concurrent sync recreated the row", async () => {
    const { mirrorImageAltAnyStore } = await import("~/services/translations/verified-translations.server");
    const db = makeDb();
    db.productImageAltTranslation.upsert.mockRejectedValueOnce(p2003());
    const out = await mirrorImageAltAnyStore(db, { shop: SHOP, mediaId: PRODUCT_MEDIA, locale: "de", value: "x", retryDelayMs: 0 });
    expect(out).toBe("product");
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it("still gone after the retry: notMirrored, no library row", async () => {
    const { mirrorImageAltAnyStore } = await import("~/services/translations/verified-translations.server");
    const db = makeDb();
    db.productImageAltTranslation.upsert.mockRejectedValue(p2003());
    const out = await mirrorImageAltAnyStore(db, { shop: SHOP, mediaId: PRODUCT_MEDIA, locale: "de", value: "x", retryDelayMs: 0 });
    expect(out).toBe("notMirrored");
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it("a non-MediaImage id never takes the library branch", async () => {
    const { mirrorImageAltAnyStore } = await import("~/services/translations/verified-translations.server");
    const db = makeDb();
    const out = await mirrorImageAltAnyStore(db, { shop: SHOP, mediaId: "gid://shopify/Video/3", locale: "de", value: "x", retryDelayMs: 0 });
    expect(out).toBe("notMirrored");
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it("a MediaImage with no ProductImage row anywhere is a library file", async () => {
    const { mirrorImageAltAnyStore } = await import("~/services/translations/verified-translations.server");
    const db = makeDb();
    const out = await mirrorImageAltAnyStore(db, { shop: SHOP, mediaId: LIBRARY, locale: "de", value: "x", retryDelayMs: 0 });
    expect(out).toBe("library");
  });
});
