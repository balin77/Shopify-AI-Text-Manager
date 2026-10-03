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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  repairs: { market: [] as any[], marketFailedKeys: [] as string[] },
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
    for (const key of repairs.marketFailedKeys) args.outcome?.failedKeys.add(key);
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
import { reconcileAfterPrimarySave } from "~/services/translations/stale-translation-sync.server";
import { fetchShopLocales } from "~/services/sync-utils";

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
      findMany: vi.fn().mockResolvedValue(images[0] ? [{ id: images[0].id }] : []),
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
  repairs.marketFailedKeys.length = 0;
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

  it("mirrors the value Shopify STORED (the echo), not the one that was sent", async () => {
    const w = installAdmin({
      register: (v: any) => ({
        data: {
          translationsRegister: {
            userErrors: [],
            translations: v.translations.map((t: any) => ({ key: t.key, locale: t.locale, value: `${t.value} (stored)`, market: null })),
          },
        },
      }),
    });
    const db = makeDb();
    await saveForeign(w.admin, { title: "Hemd" });
    expect(db.contentTranslation.upsert.mock.calls[0][0].create.value).toBe("Hemd (stored)");
  });

  it("a register refused with userErrors fails the save (500) and mirrors nothing", async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [{ message: "Title is invalid" }], translations: [] } } }),
    });
    const db = makeDb();
    const r: any = await saveForeign(w.admin, { title: "Hemd" });

    expect(r.init?.status).toBe(500);
    expect(body(r)).toMatchObject({ success: false });
    expect(body(r).error).toContain("Title is invalid");
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it("a register Shopify accepted but did not echo is NOT mirrored and the save fails", async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const r: any = await saveForeign(w.admin, { title: "Hemd" });

    expect(body(r)).toMatchObject({ success: false });
    expect(body(r).error).toContain("did not confirm storing (title)");
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it("a PARTIAL echo mirrors only the confirmed key and names the unconfirmed FIELD for the page", async () => {
    const w = installAdmin({
      register: (v: any) => ({
        data: {
          translationsRegister: {
            userErrors: [],
            translations: v.translations.filter((t: any) => t.key === "title").map((t: any) => ({ key: t.key, locale: t.locale, value: t.value, market: null })),
          },
        },
      }),
    });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { title: "Hemd", handle: "hemd" }));

    expect(result.success).toBe(true);
    // FIELD keys, not Shopify keys: the page keeps them dirty and words the
    // message itself in the merchant's language. No raw English warning.
    expect(result.unconfirmedFields).toEqual(["handle"]);
    expect(result.warning).toBeUndefined();
    expect(db.contentTranslation.upsert.mock.calls.map((c: any) => c[0].create.key)).toEqual(["title"]);
  });

  it("an un-echoed key does not stop a digest-less key from being mirrored locally (digest null)", async () => {
    const w = installAdmin({
      productDigests: [{ key: "title", digest: "dg-title" }],
      register: () => ({ data: { translationsRegister: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const r: any = await saveForeign(w.admin, { title: "Hemd", handle: "hemd" });

    expect(body(r)).toMatchObject({ success: false });
    expect(db.contentTranslation.upsert.mock.calls.map((c: any) => [c[0].create.key, c[0].create.digest])).toEqual([["handle", null]]);
  });
});

describe("updateTranslatedProduct -- the verdict, aligned with updateContent", () => {
  it("a register that confirmed nothing fails the save even when a removal in it was confirmed", async () => {
    // Title set (not echoed) + SEO title cleared (removal confirmed). Answering
    // success here let the editor cache the unsaved title as saved.
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [], translations: [] } } }),
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [{ key: "meta_title", locale: "fr" }] } } }),
    });
    makeDb();
    const result = body(await saveForeign(w.admin, { title: "Hemd", seoTitle: "" }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("did not confirm storing (title)");
  });

  it("says out loud which fields were saved locally only (no digest)", async () => {
    const w = installAdmin({ productDigests: [{ key: "title", digest: "dg-title" }] });
    makeDb();
    const result = body(await saveForeign(w.admin, { title: "Hemd", handle: "hemd" }));

    expect(result.success).toBe(true);
    expect(result.warning).toContain("saved locally only");
    expect(result.warning).toContain("handle");
  });
});

// ---------------------------------------------------------------------------
describe("updateTranslatedProduct -- foreign remove + DB delete", () => {
  it("a cleared field is removed for that locale and the local row is deleted (with the shop)", async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { title: "" }));

    expect(w.of("register")).toHaveLength(0);
    expect(w.of("remove")[0].variables).toMatchObject({
      resourceId: PRODUCT, translationKeys: ["title"], locales: ["fr"], marketIds: null,
    });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toEqual({
      shop: SHOP, resourceId: PRODUCT, resourceType: "Product", locale: "fr", marketId: "", key: { in: ["title"] },
    });
    expect(w.of("reread")).toHaveLength(0);
    expect(result).toEqual({ success: true });
  });

  it("a market-scoped clear removes only that market's override", async () => {
    const w = installAdmin();
    const db = makeDb();
    await saveForeign(w.admin, { seoTitle: "", marketId: MARKET });

    expect(w.of("remove")[0].variables.marketIds).toEqual([MARKET]);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({ marketId: MARKET, key: { in: ["meta_title"] } });
  });

  it("a DB-only row Shopify never held (no echo) is cleared through the re-read", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
      // default re-read: the key carries nothing in this locale any more
    });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { title: "" }));

    expect(w.of("reread")).toHaveLength(1);
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  it("a removal Shopify did not confirm keeps the row and fails the save when nothing else landed", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [{ message: "refused" }], translations: [] } } }),
      reread: () => ({ data: { translatableResource: { translations: [{ key: "title", value: "Hemd", market: null }] } } }),
    });
    const db = makeDb();
    const r: any = await saveForeign(w.admin, { title: "" });

    expect(r.init?.status).toBe(500);
    expect(body(r)).toMatchObject({ success: false });
    expect(body(r).error).toContain("did not confirm removing the translation of (title)");
    expect(body(r).error).toContain("refused");
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("a partial clear keeps the unconfirmed row, warns and names the FIELD keys to keep dirty", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [{ key: "title", locale: "fr" }] } } }),
      reread: () => ({ data: { translatableResource: { translations: [{ key: "body_html", value: "<p>x</p>", market: null }] } } }),
    });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { title: "", descriptionHtml: "" }));

    expect(result.success).toBe(true);
    expect(result.warning).toContain("(body_html)");
    // The editor's field key, not the Shopify key and not the wire name.
    expect(result.unconfirmedClearedFields).toEqual(["description"]);
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where.key).toEqual({ in: ["title"] });
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
      where: { imageId: { in: ["img-1"] }, locale: "fr", marketId: "" },
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

  it("an alt register that was not echoed is NOT mirrored and the index fails", async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 0: "Alt fr" }) }));

    expect(result.failedAltTextIndices).toEqual([0]);
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
    expect(marked.filter((id) => id !== PRODUCT)).toHaveLength(0);
  });

  it("mirrors the alt Shopify STORED, under the market it was written for", async () => {
    const w = installAdmin({
      register: (v: any) => ({
        data: {
          translationsRegister: {
            userErrors: [],
            translations: v.translations.map((t: any) => ({ key: t.key, locale: t.locale, value: `${t.value}!`, market: t.marketId ? { id: t.marketId } : null })),
          },
        },
      }),
    });
    const db = makeDb();
    await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 0: "Alt" }), marketId: MARKET });

    const reg = w.of("register").find((c) => c.variables.resourceId === MEDIA)!;
    expect(reg.variables.translations[0]).toMatchObject({ marketId: MARKET });
    expect(db.productImageAltTranslation.upsert.mock.calls[0][0].create).toMatchObject({ altText: "Alt!", marketId: MARKET });
  });

  it("a cleared alt whose removal is not confirmed keeps the mirror row and fails the index", async () => {
    const w = installAdmin({
      remove: (v: any) =>
        v.resourceId === MEDIA
          ? { data: { translationsRemove: { userErrors: [{ message: "no" }], translations: [] } } }
          : { data: { translationsRemove: { userErrors: [], translations: [] } } },
      reread: () => ({ data: { translatableResource: { translations: [{ key: "alt", value: "old", market: null }] } } }),
    });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 0: "" }) }));

    expect(result.failedAltTextIndices).toEqual([0]);
    expect(db.productImageAltTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("a DB-only alt row (Shopify held nothing) is cleared through the re-read", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 0: "" }) }));

    expect(result.failedAltTextIndices).toBeUndefined();
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalledWith({ where: { imageId: { in: ["img-1"] }, locale: "fr", marketId: "" } });
  });

  it("resolves the cache row from (product, media) at write time, never from the row read earlier", async () => {
    const w = installAdmin();
    const db = makeDb();
    // The product sync recreated the row between the read and the write.
    db.productImage.findMany.mockResolvedValue([{ id: "img-recreated" }]);
    await saveForeign(w.admin, { imageAltTexts: JSON.stringify({ 0: "Alt fr" }) });

    expect(db.productImage.findMany.mock.calls[0][0].where).toEqual({ mediaId: MEDIA, product: { shop: SHOP } });
    expect(db.productImageAltTranslation.upsert.mock.calls[0][0].create.imageId).toBe("img-recreated");
  });
});

// ---------------------------------------------------------------------------
describe("updatePrimaryProduct -- primary-change purge", () => {
  it("removes the changed field's translations in every foreign locale, then deletes the confirmed local rows (with the shop)", async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    const rem = w.of("remove")[0].variables;
    expect(rem).toMatchObject({ resourceId: PRODUCT, translationKeys: ["title"], locales: ["fr", "it"] });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toEqual({
      shop: SHOP, resourceId: PRODUCT, resourceType: "Product", marketId: "", key: { in: ["title"] }, locale: { in: ["fr", "it"] },
    });
    // The market layer is purged beside it, through its own module.
    expect(repairs.market).toHaveLength(1);
    expect(repairs.market[0]).toMatchObject({ locales: ["fr", "it"], keys: ["title"] });
  });

  it("reports the fields whose MARKET overrides the purge cleared (the page hides market values only for these)", async () => {
    const w = installAdmin();
    makeDb();
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title", "vendor"]) }));
    expect(result.marketPurgedFields).toEqual(["title"]);
  });

  it("a key whose market removal was not confirmed is NOT reported as purged", async () => {
    repairs.marketFailedKeys.push("title");
    const w = installAdmin();
    makeDb();
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));
    expect(result.marketPurgedFields).toBeUndefined();
  });

  describe("auto-translate on: the repair purges the market layer itself and reports its keys", () => {
    beforeEach(() => {
      policy.autoTranslateExternalChanges = true;
      policy.purgeOnPrimaryChange = false;
      policy.purgeUnreconciledSurfaces = false;
      vi.mocked(fetchShopLocales).mockResolvedValue([
        { locale: "de", primary: true, published: true },
        { locale: "fr", primary: false, published: true },
      ] as any);
    });
    afterEach(() => {
      vi.mocked(fetchShopLocales).mockResolvedValue([] as any);
    });

    it("names the editor fields of the keys the repair confirmed purged", async () => {
      vi.mocked(reconcileAfterPrimarySave).mockResolvedValueOnce({ removed: 0, retranslating: 1, marketPurgedKeys: ["title"] } as any);
      const w = installAdmin();
      makeDb();
      const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title", "vendor"]) }));
      expect(result.marketPurgedFields).toEqual(["title"]);
    });

    it("names nothing when the repair reports no purged key", async () => {
      vi.mocked(reconcileAfterPrimarySave).mockResolvedValueOnce({ removed: 0, retranslating: 1 } as any);
      const w = installAdmin();
      makeDb();
      const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));
      expect(result.marketPurgedFields).toBeUndefined();
    });
  });

  it("with the purge off nothing is reported as purged", async () => {
    policy.purgeOnPrimaryChange = false;
    policy.purgeUnreconciledSurfaces = false;
    const w = installAdmin();
    makeDb();
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));
    expect(result.marketPurgedFields).toBeUndefined();
    expect(repairs.market).toHaveLength(0);
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

  it("deletes ONLY the confirmed pairs: a locale with a gap that the re-read finds still translated keeps its row", async () => {
    const w = installAdmin({
      // Only fr is echoed by the multi-locale call (and by nothing else).
      remove: (v: any) => ({
        data: {
          translationsRemove: {
            userErrors: [],
            translations: v.locales.includes("fr") ? [{ key: "title", locale: "fr" }] : [],
          },
        },
      }),
      reread: () => ({ data: { translatableResource: { translations: [{ key: "title", value: "Camicia", market: null }] } } }),
    });
    const db = makeDb();
    db.contentTranslation.findMany.mockResolvedValue([
      { locale: "fr", key: "title" },
      { locale: "it", key: "title" },
    ]);
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));

    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toEqual({
      shop: SHOP, resourceId: PRODUCT, resourceType: "Product", marketId: "",
      OR: [{ locale: "fr", key: { in: ["title"] } }],
    });
    // The gap locale was re-read once, on its own.
    expect(w.of("reread")).toHaveLength(1);
    expect(w.of("reread")[0].variables.locale).toBe("it");
    // A save that succeeded says what it could not clean up.
    expect(result.success).toBe(true);
    expect(result.warning).toContain("(title)");
    expect(result.warning).toContain("(it)");
  });

  it("a DB-only row Shopify never held (no echo) is purged through the gap re-read", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    db.contentTranslation.findMany.mockResolvedValue([{ locale: "fr", key: "title" }, { locale: "it", key: "title" }]);
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));

    expect(w.of("reread")).toHaveLength(2);
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({ shop: SHOP, key: { in: ["title"] }, locale: { in: ["fr", "it"] } });
    expect(result.warning).toBeUndefined();
  });

  it("with no local row there is nothing to delete and nothing to re-read for an unechoed pair", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));

    expect(w.of("reread")).toHaveLength(0);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
    expect(result.warning).toBeUndefined();
  });

  it("a removal answered with userErrors deletes nothing locally while the rows are still translated", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [{ message: "refused" }], translations: [] } } }),
      reread: () => ({ data: { translatableResource: { translations: [{ key: "title", value: "x", market: null }] } } }),
    });
    const db = makeDb();
    db.contentTranslation.findMany.mockResolvedValue([{ locale: "fr", key: "title" }, { locale: "it", key: "title" }]);
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));

    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.warning).toContain("did not confirm removing");
  });

  it("an error in the purge never fails the primary write that already succeeded: it is a warning", async () => {
    const w = installAdmin({ removeThrows: true });
    const db = makeDb();
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));

    expect(result.success).toBe(true);
    expect(result.warning).toContain("could not be removed");
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("a failed local-row lookup falls back to re-reading every gap", async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    db.contentTranslation.findMany.mockRejectedValue(new Error("db blink"));
    const result = body(await savePrimary(w.admin, { title: "Shirt", changedFields: JSON.stringify(["title"]) }));

    expect(w.of("reread")).toHaveLength(2);
    expect(result.success).toBe(true);
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
