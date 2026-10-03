/**
 * The image manager's alt texts: market layer on load/save, and the medium of
 * "translate to all languages" resolved by its id (never by position).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loggers: new Proxy({}, { get: () => vi.fn() }),
}));

const { markTranslationSaved } = vi.hoisted(() => ({ markTranslationSaved: vi.fn() }));
vi.mock("~/utils/translation-save-lock.server", () => ({
  markTranslationSaved,
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
vi.mock("~/services/tasks/resource-title.server", () => ({
  taskTitleOrFallback: vi.fn(async () => "Box"),
}));
const { translateProduct } = vi.hoisted(() => ({ translateProduct: vi.fn() }));
vi.mock("../../src/services/translation.service", () => ({
  TranslationService: class {
    translateProduct = translateProduct;
  },
}));

import { pickProductImage, ALT_IMAGE_NOT_FOUND } from "~/services/product-image-pick.shared";

const SHOP = "s.myshopify.com";
const MEDIA_A = "gid://shopify/MediaImage/1";
const MEDIA_B = "gid://shopify/MediaImage/2";
const MARKET = "gid://shopify/Market/77";

function fakeAdmin() {
  const registers: Array<{ resourceId: string; translations: any[] }> = [];
  const removes: Array<Record<string, any>> = [];
  const graphql = vi.fn(async (query: string, options?: { variables?: Record<string, any> }) => {
    const v = options?.variables ?? {};
    let body: unknown = { data: {} };
    if (query.includes("translationsRegister(")) {
      registers.push({ resourceId: v.resourceId, translations: v.translations });
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
      body = {
        data: { translationsRemove: { userErrors: [], translations: v.locales.map((l: string) => ({ key: "alt", locale: l })) } },
      };
    } else if (query.includes("translatableResource")) {
      body = {
        data: { translatableResource: { resourceId: v.resourceId ?? v.id, translatableContent: [{ key: "alt", digest: "dg", value: "x" }] } },
      };
    }
    return { ok: true, status: 200, json: async () => body };
  });
  return { graphql, registers, removes };
}

function makeDb(images = [{ id: "row-a", mediaId: MEDIA_A, productId: "p1", position: 0 }, { id: "row-b", mediaId: MEDIA_B, productId: "p1", position: 1 }]) {
  const db: any = {
    task: { create: vi.fn(async () => ({ id: "t1" })), update: vi.fn(async () => ({})) },
    product: { findUnique: vi.fn(async () => ({ id: "p1", title: "Box", images })) },
    productImage: {
      findFirst: vi.fn(async ({ where }: any) => images.find((i) => i.mediaId === where.mediaId) ?? null),
      findMany: vi.fn(async ({ where }: any) => images.filter((i) => i.mediaId === where.mediaId).map((i) => ({ id: i.id }))),
    },
    productImageAltTranslation: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  return db;
}

beforeEach(() => vi.clearAllMocks());

describe("pickProductImage", () => {
  const images = [{ mediaId: MEDIA_A }, { mediaId: MEDIA_B }];
  it("resolves by media id, whatever the position", () => {
    expect(pickProductImage(images, { mediaId: MEDIA_B, imageIndex: 0 })).toBe(images[1]);
  });
  it("an unknown media id is NOT image 0", () => {
    expect(pickProductImage(images, { mediaId: "gid://shopify/MediaImage/999", imageIndex: 0 })).toBeUndefined();
  });
  it("index only for callers without a media id; out of range / negative is a miss", () => {
    expect(pickProductImage(images, { imageIndex: 1 })).toBe(images[1]);
    expect(pickProductImage(images, { imageIndex: -1 })).toBeUndefined();
    expect(pickProductImage(images, {})).toBeUndefined();
  });
});

describe("handleTranslateAltTextToAllLocales resolves by mediaId", () => {
  async function run(db: any, admin: any, fields: Record<string, string>) {
    const { handleTranslateAltTextToAllLocales } = await import("~/actions/content/alt-text.action");
    translateProduct.mockResolvedValue({ de: { altText_0: "Kiste" } });
    const fd = new FormData();
    fd.set("sourceAltText", "Box");
    fd.set("targetLocales", JSON.stringify(["de"]));
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const res: any = await handleTranslateAltTextToAllLocales(
      {
        admin, session: { shop: SHOP }, db, itemId: "p1", provider: "claude", serviceConfig: {},
        contentConfig: { resourceType: "Product", contentType: "products" },
        shopifyContentService: {}, aiSettings: null,
      } as never,
      fd,
    );
    return { body: res.data ?? res, status: res.init?.status };
  }

  it("writes to the image named by mediaId even when the index points elsewhere", async () => {
    const admin = fakeAdmin();
    const { body } = await run(makeDb(), admin, { mediaId: MEDIA_B, imageIndex: "0" });
    expect(body.savedLocales).toEqual(["de"]);
    expect(admin.registers.map((r) => r.resourceId)).toEqual([MEDIA_B]);
  });

  it("refuses an unknown mediaId: 404, errorCode, no AI work, no write", async () => {
    const admin = fakeAdmin();
    const db = makeDb();
    const { body, status } = await run(db, admin, { mediaId: "gid://shopify/MediaImage/999", imageIndex: "0" });
    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe(ALT_IMAGE_NOT_FOUND);
    expect(translateProduct).not.toHaveBeenCalled();
    expect(db.task.create).not.toHaveBeenCalled();
    expect(admin.registers).toEqual([]);
  });
});

describe("handleLoadImageAltTranslations market filter", () => {
  async function load(db: any, fields: Record<string, string>) {
    const { handleLoadImageAltTranslations } = await import("~/actions/content/alt-text.action");
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const res: any = await handleLoadImageAltTranslations({ db, itemId: "p1", session: { shop: SHOP } } as never, fd);
    return res.data ?? res;
  }

  it("without a market only the GLOBAL layer is queried", async () => {
    const db = makeDb();
    await load(db, { productId: "p1", locale: "de" });
    expect(db.productImageAltTranslation.findMany.mock.calls[0][0].where.marketId).toBe("");
    // Scoped to the caller's shop through the product, never by productId alone.
    expect(db.productImageAltTranslation.findMany.mock.calls[0][0].where.image).toEqual({
      productId: "p1",
      product: { shop: SHOP },
    });
  });

  it("with a market: that market's rows override the global ones, global shows as inherited", async () => {
    const db = makeDb();
    db.productImageAltTranslation.findMany.mockResolvedValue([
      { altText: "global A", marketId: "", image: { mediaId: MEDIA_A } },
      { altText: "market A", marketId: MARKET, image: { mediaId: MEDIA_A } },
      { altText: "global B", marketId: "", image: { mediaId: MEDIA_B } },
    ]);
    const body = await load(db, { productId: "p1", locale: "de", marketId: MARKET });
    expect(db.productImageAltTranslation.findMany.mock.calls[0][0].where.marketId).toEqual({ in: ["", MARKET] });
    expect(body.altTexts).toEqual({ [MEDIA_A]: "market A", [MEDIA_B]: "global B" });
    expect(body.inheritedMediaIds).toEqual([MEDIA_B]);
  });

  it("a global-only view is not polluted by a market row that sorts last", async () => {
    const db = makeDb();
    // The query filters on the DB side; the handler must not need the filter to be right.
    db.productImageAltTranslation.findMany.mockResolvedValue([
      { altText: "global A", marketId: "", image: { mediaId: MEDIA_A } },
      { altText: "market A", marketId: MARKET, image: { mediaId: MEDIA_A } },
    ]);
    const body = await load(db, { productId: "p1", locale: "de" });
    expect(body.altTexts[MEDIA_A]).toBe("global A");
  });

  it("refuses a malformed marketId", async () => {
    const body = await load(makeDb(), { productId: "p1", locale: "de", marketId: "evil" });
    expect(body.success).toBe(false);
  });
});

describe("handleSaveImageAltText on a market layer", () => {
  async function save(admin: any, db: any, altText: string, marketId?: string) {
    const { handleSaveImageAltText } = await import("~/actions/content/alt-text.action");
    const fd = new FormData();
    fd.set("mediaId", MEDIA_A);
    fd.set("altText", altText);
    fd.set("locale", "de");
    fd.set("primaryLocale", "en");
    if (marketId) fd.set("marketId", marketId);
    const res: any = await handleSaveImageAltText({ admin, db, session: { shop: SHOP } } as never, fd);
    return { body: res.data ?? res, status: res.init?.status };
  }

  it("registers with the marketId, mirrors under it and marks the market-layer key", async () => {
    const admin = fakeAdmin();
    const db = makeDb();
    const { body } = await save(admin, db, "Kiste", MARKET);
    expect(body.success).toBe(true);
    expect(admin.registers[0].translations[0].marketId).toBe(MARKET);
    const upsert = db.productImageAltTranslation.upsert.mock.calls[0][0];
    expect(upsert.where.imageId_locale_marketId.marketId).toBe(MARKET);
    expect(markTranslationSaved).toHaveBeenCalledWith(`${MEDIA_A}#market`);
    expect(markTranslationSaved).not.toHaveBeenCalledWith(MEDIA_A);
    expect(markTranslationSaved).toHaveBeenCalledWith("p1#altTextShield");
  });

  it("a global save is unchanged: no marketId, bare lock key", async () => {
    const admin = fakeAdmin();
    const db = makeDb();
    await save(admin, db, "Kiste");
    expect(admin.registers[0].translations[0].marketId).toBeUndefined();
    expect(markTranslationSaved).toHaveBeenCalledWith(MEDIA_A);
  });

  it("clearing removes in the market and deletes only that market's mirror row", async () => {
    const admin = fakeAdmin();
    const db = makeDb();
    await save(admin, db, "", MARKET);
    expect(admin.removes[0].marketIds).toEqual([MARKET]);
    expect(db.productImageAltTranslation.deleteMany.mock.calls[0][0].where.marketId).toBe(MARKET);
  });

  it("refuses a malformed marketId before anything is sent", async () => {
    const admin = fakeAdmin();
    const { body, status } = await save(admin, makeDb(), "Kiste", "not-a-gid");
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(admin.graphql).not.toHaveBeenCalled();
  });
});
