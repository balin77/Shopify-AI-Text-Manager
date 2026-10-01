/**
 * docs/plans/PLAN_TRANSLATION_WRITE_UNIFICATION.md, Phase D -- the behaviour of
 * app/actions/product/update.actions.ts (the product editor's save):
 *
 *   - updateTranslatedProduct  (foreign locale text: register + mirror, remove + delete)
 *   - updateImageAltTexts      (foreign alt translations + ProductImageAltTranslation)
 *   - updatePrimaryProduct     (primary-change purge of the foreign translations)
 *   - the response shapes the client reads (failedAltTextIndices, warning, ...)
 *
 * `handleUpdateProduct` runs for real over a mocked `admin.graphql` and a mocked
 * Prisma client. Written first as a characterisation of what the code does; the
 * cases that described the unverified gaps are flipped in the change that
 * closes them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  loggers: { product: vi.fn(), translation: vi.fn(), seo: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { marked } = vi.hoisted(() => ({ marked: [] as string[] }));
vi.mock("~/utils/translation-save-lock.server", () => ({
  markTranslationSaved: vi.fn((id: string) => {
    marked.push(id);
  }),
  isTranslationRecentlySaved: vi.fn().mockReturnValue(false),
}));

const { world, policy, repairs } = vi.hoisted(() => ({
  world: { db: null as any },
  policy: {
    purgeOnPrimaryChange: true,
    purgeUnreconciledSurfaces: true,
    autoTranslateExternalChanges: false,
    plan: "max",
  },
  repairs: { market: [] as any[] },
}));

vi.mock("~/db.server", () => ({
  get db() {
    return world.db;
  },
}));

// The action builds a gateway around `admin`; it delegates to the same mock so
// every call lands in one recorder.
vi.mock("~/services/shopify-api-gateway.service", () => ({
  ShopifyApiGateway: class {
    constructor(public admin: any, public shop: string) {}
    graphql(query: string, options?: any) {
      return this.admin.graphql(query, options);
    }
  },
}));

vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: vi.fn(async () => policy),
}));

vi.mock("~/services/translations/market-layer-purge.server", () => ({
  purgeMarketOverrides: vi.fn(async (args: any) => {
    repairs.market.push(args);
  }),
}));

vi.mock("~/services/translations/stale-translation-sync.server", () => ({
  contentTranslationMirror: vi.fn(() => ({})),
  reconcileAfterPrimarySave: vi.fn(async () => ({})),
}));

vi.mock("~/services/translations/product-alt-repair.server", () => ({
  altRepairRetranslates: vi.fn(() => false),
  repairChangedProductAlts: vi.fn(async () => ({})),
}));

vi.mock("~/services/sync-utils", () => ({
  fetchShopLocales: vi.fn(async () => []),
}));

import { handleUpdateProduct } from "../../app/actions/product/update.actions";

const SHOP = "test.myshopify.com";
const PRODUCT = "gid://shopify/Product/10";
const MEDIA = "gid://shopify/MediaImage/77";
const MARKET = "gid://shopify/Market/9";

interface WorldConfig {
  /** translatableContent of the product. */
  productDigests?: Array<{ key: string; digest: string | null }>;
  /** translatableContent of the media image. */
  mediaDigests?: Array<{ key: string; digest: string | null }>;
  /** Answer to translationsRegister; default = echo everything that was sent. */
  register?: (variables: any) => any;
  /** Answer to translationsRemove; default = echo every (key, locale) asked for. */
  remove?: (variables: any) => any;
  /** Answer to the removal re-read. */
  reread?: (variables: any) => any;
  /** Throw from translationsRemove. */
  removeThrows?: boolean;
  locales?: Array<{ locale: string; primary: boolean; published: boolean }>;
}

function installAdmin(config: WorldConfig = {}) {
  const calls: Array<{ kind: string; variables: any }> = [];
  const locales = config.locales ?? [
    { locale: "de", primary: true, published: true },
    { locale: "fr", primary: false, published: true },
    { locale: "it", primary: false, published: true },
  ];
  const productDigests = config.productDigests ?? [
    { key: "title", digest: "dg-title" },
    { key: "body_html", digest: "dg-body" },
    { key: "handle", digest: "dg-handle" },
    { key: "meta_title", digest: "dg-mt" },
    { key: "meta_description", digest: "dg-md" },
    { key: "product_type", digest: "dg-pt" },
  ];
  const mediaDigests = config.mediaDigests ?? [{ key: "alt", digest: "dg-alt" }];
  const graphql = vi.fn(async (query: string, options?: any) => {
    const variables = options?.variables;
    const answer = (body: unknown) => ({ ok: true, json: async () => body });

    if (query.includes("translationsRegister")) {
      calls.push({ kind: "register", variables });
      return answer(
        config.register
          ? config.register(variables)
          : {
              data: {
                translationsRegister: {
                  userErrors: [],
                  translations: (variables.translations ?? []).map((t: any) => ({
                    key: t.key,
                    locale: t.locale,
                    value: t.value,
                    market: t.marketId ? { id: t.marketId } : null,
                  })),
                },
              },
            },
      );
    }
    if (query.includes("translationsRemove")) {
      calls.push({ kind: "remove", variables });
      if (config.removeThrows) throw new Error("network down");
      return answer(
        config.remove
          ? config.remove(variables)
          : {
              data: {
                translationsRemove: {
                  userErrors: [],
                  translations: (variables.locales as string[]).flatMap((locale) =>
                    (variables.translationKeys as string[]).map((key) => ({ key, locale })),
                  ),
                },
              },
            },
      );
    }
    if (query.includes("verifyTranslationRemoval")) {
      calls.push({ kind: "reread", variables });
      return answer(config.reread ? config.reread(variables) : { data: { translatableResource: { translations: [] } } });
    }
    if (query.includes("translatableContent") || query.includes("bulkEditorTranslatableContent")) {
      calls.push({ kind: "digest", variables });
      const rows = variables.resourceId === MEDIA ? mediaDigests : productDigests;
      return answer({
        data: {
          translatableResource: {
            resourceId: variables.resourceId,
            translatableContent: rows.map((r) => ({ ...r, value: "src" })),
          },
        },
      });
    }
    if (query.includes("getShopLocales")) return answer({ data: { shopLocales: locales } });
    if (query.includes("getProduct(")) {
      return answer({ data: { product: { media: { edges: [{ node: { id: MEDIA, alt: "" } }] } } } });
    }
    if (query.includes("updateProduct")) {
      calls.push({ kind: "productUpdate", variables });
      return answer({
        data: {
          productUpdate: {
            product: { id: PRODUCT, title: "Shirt", handle: "shirt", seo: { title: "", description: "" } },
            userErrors: [],
          },
        },
      });
    }
    if (query.includes("updateMedia")) {
      calls.push({ kind: "updateMedia", variables });
      return answer({ data: { productUpdateMedia: { media: [{ alt: "x" }], mediaUserErrors: [] } } });
    }
    return answer({ data: {} });
  });
  return { admin: { graphql }, calls, of: (kind: string) => calls.filter((c) => c.kind === kind) };
}

function makeDb(images: Array<{ id: string; mediaId: string | null }> = [{ id: "img-1", mediaId: MEDIA }]) {
  const db: any = {
    product: {
      findUnique: vi.fn().mockResolvedValue({ shop: SHOP, images }),
      update: vi.fn().mockResolvedValue({}),
    },
    productImage: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ altText: null }),
      findFirst: vi.fn().mockResolvedValue(images[0] ? { id: images[0].id } : null),
    },
    productImageAltTranslation: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    contentTranslation: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    productCollection: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn(), createMany: vi.fn() },
    collection: { findMany: vi.fn().mockResolvedValue([]) },
  };
  db.$transaction = vi.fn(async (fn: any) => fn(db));
  world.db = db;
  return db;
}

function ctx(admin: any) {
  return { admin, session: { shop: SHOP } } as any;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** `data()` from react-router wraps the body; unwrap either shape. */
const body = (r: any) => (r && typeof r === "object" && "data" in r && "type" in r ? r.data : r);

const saveForeign = (admin: any, fields: Record<string, string>) =>
  handleUpdateProduct(ctx(admin), form({ locale: "fr", primaryLocale: "de", ...fields }), PRODUCT);

const savePrimary = (admin: any, fields: Record<string, string>) =>
  handleUpdateProduct(ctx(admin), form({ locale: "de", primaryLocale: "de", ...fields }), PRODUCT);

beforeEach(() => {
  marked.length = 0;
  repairs.market.length = 0;
  policy.purgeOnPrimaryChange = true;
  policy.purgeUnreconciledSurfaces = true;
  policy.autoTranslateExternalChanges = false;
});

// ---------------------------------------------------------------------------
describe("updateTranslatedProduct -- foreign register + mirror", () => {
  it("registers the field with its digest and mirrors the row WITH that digest", async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { title: "Hemd" }));

    expect(w.of("register")).toHaveLength(1);
    expect(w.of("register")[0].variables).toMatchObject({
      resourceId: PRODUCT,
      translations: [{ key: "title", value: "Hemd", locale: "fr", translatableContentDigest: "dg-title" }],
    });
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
    const arg = db.contentTranslation.upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({
      shop: SHOP, resourceId: PRODUCT, resourceType: "Product", key: "title", value: "Hemd", locale: "fr", marketId: "",
    });
    expect(arg.create.digest).toBe("dg-title");
    expect(result).toMatchObject({ success: true });
    expect(marked).toContain(PRODUCT);
  });

  it("maps every UI field to its Shopify key", async () => {
    const w = installAdmin();
    makeDb();
    await saveForeign(w.admin, {
      title: "T", descriptionHtml: "<p>B</p>", handle: "hemd", seoTitle: "S", metaDescription: "M", productType: "P",
    });
    const keys = w.of("register")[0].variables.translations.map((t: any) => t.key).sort();
    expect(keys).toEqual(["body_html", "handle", "meta_description", "meta_title", "product_type", "title"]);
  });

  it("a key with no digest is NOT sent and is mirrored locally with digest null (after one digest re-fetch)", async () => {
    const w = installAdmin({ productDigests: [{ key: "title", digest: "dg-title" }] });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { title: "Hemd", handle: "hemd" }));

    expect(w.of("register")[0].variables.translations.map((t: any) => t.key)).toEqual(["title"]);
    // Missing digest -> the translatableContent is fetched a second time.
    expect(w.of("digest")).toHaveLength(2);
    const byKey = Object.fromEntries(db.contentTranslation.upsert.mock.calls.map((c: any) => [c[0].create.key, c[0].create]));
    expect(byKey.title.digest).toBe("dg-title");
    expect(byKey.handle).toMatchObject({ value: "hemd", digest: null });
    expect(result).toMatchObject({ success: true });
  });

  it("a market save sends marketId, mirrors under it and marks the MARKET lock, not the product", async () => {
    const w = installAdmin();
    const db = makeDb();
    await saveForeign(w.admin, { title: "Hemd CH", marketId: MARKET });

    expect(w.of("register")[0].variables.translations[0]).toMatchObject({ marketId: MARKET });
    expect(db.contentTranslation.upsert.mock.calls[0][0].create.marketId).toBe(MARKET);
    expect(marked).toHaveLength(1);
    expect(marked[0]).not.toBe(PRODUCT);
    expect(marked[0]).toContain(PRODUCT);
  });

  it("a register refused with userErrors fails the save (500) and mirrors nothing", async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [{ message: "Title is invalid" }], translations: [] } } }),
    });
    const db = makeDb();
    const r: any = await saveForeign(w.admin, { title: "Hemd" });

    expect(r.init?.status).toBe(500);
    expect(body(r)).toMatchObject({ success: false, error: "Title is invalid" });
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it("CURRENT GAP: a register Shopify accepted but did not echo is still mirrored and reported as success", async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { title: "Hemd" }));

    expect(result).toMatchObject({ success: true });
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("updateTranslatedProduct -- foreign remove + DB delete", () => {
  it("a cleared field is removed for that locale and the local row is deleted", async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { title: "" }));

    expect(w.of("register")).toHaveLength(0);
    expect(w.of("remove")[0].variables).toMatchObject({
      resourceId: PRODUCT, translationKeys: ["title"], locales: ["fr"], marketIds: null,
    });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({
      resourceId: PRODUCT, resourceType: "Product", locale: "fr", marketId: "", key: "title",
    });
    expect(result).toMatchObject({ success: true });
  });

  it("a market-scoped clear removes only that market's override", async () => {
    const w = installAdmin();
    const db = makeDb();
    await saveForeign(w.admin, { seoTitle: "", marketId: MARKET });

    expect(w.of("remove")[0].variables.marketIds).toEqual([MARKET]);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({ marketId: MARKET, key: "meta_title" });
  });

  it("a removal refused with userErrors fails the save (500) and keeps the local row", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [{ message: "refused" }], translations: [] } } }),
    });
    const db = makeDb();
    const r: any = await saveForeign(w.admin, { title: "" });

    expect(r.init?.status).toBe(500);
    expect(body(r)).toMatchObject({ success: false, error: "refused" });
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("CURRENT GAP: a removal Shopify accepted but did not echo deletes the local row anyway", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { title: "" }));

    expect(result).toMatchObject({ success: true });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("updateImageAltTexts -- foreign alt translations", () => {
  it("registers the alt with its digest and upserts the ProductImageAltTranslation row", async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 0: "Alt fr" }) }));

    const reg = w.of("register").find((c) => c.variables.resourceId === MEDIA)!;
    expect(reg.variables.translations).toEqual([
      { key: "alt", value: "Alt fr", locale: "fr", translatableContentDigest: "dg-alt" },
    ]);
    expect(db.productImageAltTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(db.productImageAltTranslation.upsert.mock.calls[0][0]).toMatchObject({
      where: { imageId_locale_marketId: { imageId: "img-1", locale: "fr", marketId: "" } },
      update: { altText: "Alt fr" },
      create: { imageId: "img-1", locale: "fr", altText: "Alt fr", marketId: "" },
    });
    expect(result.failedAltTextIndices).toBeUndefined();
    expect(marked.some((id) => id !== PRODUCT)).toBe(true);
  });

  it("an empty alt removes the translation and deletes the mirror row", async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 0: "" }) }));

    const rem = w.of("remove").find((c) => c.variables.resourceId === MEDIA)!;
    expect(rem.variables).toMatchObject({ translationKeys: ["alt"], locales: ["fr"], marketIds: null });
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalledWith({
      where: { imageId: "img-1", locale: "fr", marketId: "" },
    });
    expect(result.failedAltTextIndices).toBeUndefined();
  });

  it("a register refused with userErrors lands in failedAltTextIndices and mirrors nothing", async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [{ message: "nope" }], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 0: "Alt fr" }) }));

    expect(result.failedAltTextIndices).toEqual([0]);
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
  });

  it("an image with no media id at all is reported in failedAltTextIndices", async () => {
    const w = installAdmin();
    makeDb([{ id: "img-1", mediaId: null }]);
    // Shopify's own media list has only index 0; index 3 resolves to nothing.
    const result = body(await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 3: "Alt" }) }));
    expect(result.failedAltTextIndices).toEqual([3]);
  });

  it("without a digest nothing is sent and the index fails", async () => {
    const w = installAdmin({ mediaDigests: [] });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 0: "Alt fr" }) }));

    expect(w.of("register").filter((c) => c.variables.resourceId === MEDIA)).toHaveLength(0);
    expect(result.failedAltTextIndices).toEqual([0]);
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
  });

  it("CURRENT GAP: an alt register that was not echoed is still mirrored", async () => {
    const w = installAdmin({
      register: (v: any) =>
        v.resourceId === MEDIA
          ? { data: { translationsRegister: { userErrors: [], translations: [] } } }
          : { data: { translationsRegister: { userErrors: [], translations: [] } } },
    });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 0: "Alt fr" }) }));

    expect(result.failedAltTextIndices).toBeUndefined();
    expect(db.productImageAltTranslation.upsert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("updatePrimaryProduct -- primary-change purge", () => {
  it("removes the changed field's translations in every foreign locale, then deletes the local rows", async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));

    expect(result).toMatchObject({ success: true });
    const rem = w.of("remove")[0].variables;
    expect(rem).toMatchObject({ resourceId: PRODUCT, translationKeys: ["title"], locales: ["fr", "it"] });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({
      resourceId: PRODUCT, resourceType: "Product", marketId: "", key: "title", locale: { in: ["fr", "it"] },
    });
    // The market layer is purged beside it, through its own module.
    expect(repairs.market).toHaveLength(1);
    expect(repairs.market[0]).toMatchObject({ locales: ["fr", "it"], keys: ["title"] });
  });

  it("does nothing to translations when the merchant switched the purge off", async () => {
    policy.purgeOnPrimaryChange = false;
    const w = installAdmin();
    const db = makeDb();
    await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) });

    expect(w.of("remove")).toHaveLength(0);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("sends no removal for a field with no translation key", async () => {
    const w = installAdmin();
    makeDb();
    await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["vendor"]) });
    expect(w.of("remove")).toHaveLength(0);
  });

  it("an error in the purge never fails the primary write that already succeeded", async () => {
    const w = installAdmin({ removeThrows: true });
    makeDb();
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));
    expect(result).toMatchObject({ success: true });
  });

  it("CURRENT GAP: the local rows are deleted even though Shopify's removal answered userErrors", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [{ message: "refused" }], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));

    expect(result).toMatchObject({ success: true });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("CURRENT GAP: the delete's `where` carries no shop", async () => {
    const w = installAdmin();
    const db = makeDb();
    await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) });
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where.shop).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("response shapes the client reads", () => {
  it("a primary save returns the product and the retranslation task ids", async () => {
    const w = installAdmin();
    makeDb();
    const result = body(await savePrimary(w.admin, { title: "Shirt" }));
    expect(result).toMatchObject({ success: true, product: { id: PRODUCT } });
    expect(result.retranslationTaskIds).toBeDefined();
  });

  it("failed primary alt writes are merged into the answer as failedAltTextIndices", async () => {
    const w = installAdmin();
    makeDb([{ id: "img-1", mediaId: null }]);
    const result = body(await savePrimary(w.admin, { title: "Shirt", imageAltTexts: JSON.stringify({ 5: "x" }) }));
    expect(result).toMatchObject({ success: true, failedAltTextIndices: [5] });
  });

  it("a foreign save with nothing to write answers a plain success", async () => {
    const w = installAdmin();
    makeDb();
    const result = body(await saveForeign(w.admin, {}));
    expect(result).toEqual({ success: true });
  });

  it("rejects a product owned by another shop", async () => {
    const w = installAdmin();
    const db = makeDb();
    db.product.findUnique.mockResolvedValue({ shop: "other.myshopify.com", images: [] });
    const r: any = await saveForeign(w.admin, { title: "x" });
    expect(r.init?.status).toBe(404);
  });
});
