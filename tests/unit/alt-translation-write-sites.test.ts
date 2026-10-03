/**
 * Phase E (docs/plans/PLAN_TRANSLATION_WRITE_UNIFICATION.md) -- the alt-text
 * translation write sites, driven through a fake Shopify admin and a mocked db.
 *
 * Written as a CHARACTERISATION of the hand-rolled "digest -> register ->
 * userErrors" sequences BEFORE they move onto `registerMediaAltAndVerify`.
 * Cases marked CURRENT pin behaviour the migration deliberately changes (a
 * register Shopify accepted without storing anything was mirrored as success).
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

// The gateway only queues and retries; the fake admin is what matters here.
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

const { batch } = vi.hoisted(() => ({ batch: vi.fn() }));
vi.mock("~/routes/api-ai-handlers/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/routes/api-ai-handlers/shared")>()),
  createAIService: () => ({ translateAltTextsBatch: batch }),
}));

vi.mock("~/utils/alt-text-template", () => ({
  fillAltTextTemplate: (t: string) => t,
  resolveVariableValues: async () => ({}),
  createTranslationCache: () => ({}),
}));
vi.mock("~/services/translations/product-alt-repair.server", () => ({
  snapshotProductAlts: vi.fn(async () => new Map()),
  repairAltsAfterWrite: vi.fn(async () => []),
}));

const MEDIA = "gid://shopify/MediaImage/9";
const SHOP = "s.myshopify.com";

interface FakeOpts {
  /** digest for `alt`; null = resource answers without one; undefined = resource absent */
  digest?: string | null;
  /** locales Shopify accepts without storing (userErrors empty, nothing echoed) */
  silent?: string[];
  /** locales Shopify refuses with a userError */
  refuse?: string[];
  /** locale -> value Shopify echoes back instead of the one sent */
  stored?: Record<string, string>;
  /** translationsRemove echoes the key (true) or nothing (false) */
  removeEcho?: boolean;
  /** the re-read after an unechoed removal still shows the key */
  stillPresent?: boolean;
}

/** A fake Shopify answering the digest read and translationsRegister. */
function fakeAdmin(opts: FakeOpts = {}) {
  const digest = "digest" in opts ? opts.digest : "dg1";
  const registers: Array<{ resourceId: string; translations: Array<{ key: string; value: string; locale: string }> }> = [];
  const graphql = vi.fn(async (query: string, options?: { variables?: Record<string, any> }) => {
    const v = options?.variables ?? {};
    let body: unknown = { data: {} };
    if (query.includes("translationsRegister(")) {
      registers.push({ resourceId: v.resourceId, translations: v.translations });
      const t = v.translations[0];
      if (opts.refuse?.includes(t.locale)) {
        body = { data: { translationsRegister: { userErrors: [{ field: ["x"], message: "refused" }], translations: [] } } };
      } else if (opts.silent?.includes(t.locale)) {
        body = { data: { translationsRegister: { userErrors: [], translations: [] } } };
      } else {
        body = {
          data: {
            translationsRegister: {
              userErrors: [],
              translations: v.translations.map((x: any) => ({
                key: x.key,
                locale: x.locale,
                value: opts.stored?.[x.locale] ?? x.value,
                market: null,
              })),
            },
          },
        };
      }
    } else if (query.includes("translationsRemove(")) {
      body = {
        data: {
          translationsRemove: {
            userErrors: [],
            translations: opts.removeEcho ? v.locales.map((l: string) => ({ key: "alt", locale: l })) : [],
          },
        },
      };
    } else if (query.includes("translations(locale")) {
      // removal re-read: which keys still carry a translation
      body = {
        data: {
          translatableResource: {
            translations: opts.stillPresent ? [{ key: "alt", locale: v.locale, value: "x", outdated: false }] : [],
          },
        },
      };
    } else if (query.includes("translatableResource")) {
      body = {
        data: {
          translatableResource:
            digest === undefined
              ? null
              : { resourceId: v.resourceId ?? v.id, translatableContent: digest ? [{ key: "alt", digest, value: "x" }] : [] },
        },
      };
    }
    return { ok: true, status: 200, json: async () => body };
  });
  return { graphql, registers };
}

function makeDb() {
  const row = { id: "img-row", mediaId: MEDIA, productId: "p1", position: 0 };
  const db: any = {
    task: { create: vi.fn(async () => ({ id: "t1" })), update: vi.fn(async () => ({})) },
    product: { findUnique: vi.fn(async () => ({ id: "p1", title: "Box", images: [row] })) },
    productImage: {
      findFirst: vi.fn(async () => ({ id: row.id })),
      // The alt mirror resolves EVERY cache row of the shop carrying the medium.
      findMany: vi.fn(async () => [{ id: row.id }]),
      upsert: vi.fn(async () => ({ id: row.id })),
    },
    productImageAltTranslation: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as ReturnType<typeof makeDbType>;
}
// Only for the return type above.
declare function makeDbType(): any;

/** Every alt text written to ProductImageAltTranslation, whichever write verb. */
const altWrites = (db: any): string[] => [
  ...db.productImageAltTranslation.create.mock.calls.map((c: any) => c[0].data.altText),
  ...db.productImageAltTranslation.update.mock.calls.map((c: any) => c[0].data.altText),
  ...db.productImageAltTranslation.upsert.mock.calls.map((c: any) => (c[0].create ?? c[0]).altText),
];

beforeEach(() => {
  vi.clearAllMocks();
});

// -------------------------------------------------------------------------------
describe("alt-text.action handleTranslateAltTextToAllLocales (product path)", () => {
  async function run(admin: ReturnType<typeof fakeAdmin>, db: any) {
    const { handleTranslateAltTextToAllLocales } = await import("~/actions/content/alt-text.action");
    translateProduct.mockResolvedValue({
      de: { altText_0: "Kiste" },
      fr: { altText_0: "Boite" },
    });
    const fd = new FormData();
    fd.set("imageIndex", "0");
    fd.set("sourceAltText", "Box");
    fd.set("targetLocales", JSON.stringify(["de", "fr"]));
    const res: any = await handleTranslateAltTextToAllLocales(
      {
        admin: admin as never,
        session: { shop: SHOP } as never,
        contentConfig: { resourceType: "Product", contentType: "products" } as never,
        db: db as never,
        itemId: "p1",
        provider: "claude",
        serviceConfig: {},
        shopifyContentService: {} as never,
        aiSettings: null,
      } as never,
      fd,
    );
    return res.data ?? res;
  }

  it("echoed locales are mirrored, claimed and reported saved", async () => {
    const db = makeDb();
    const res = await run(fakeAdmin(), db);
    expect(res.savedLocales).toEqual(["de", "fr"]);
    expect(res.failedLocales).toEqual([]);
    expect(altWrites(db)).toEqual(["Kiste", "Boite"]);
    expect(markTranslationSaved).toHaveBeenCalledWith(MEDIA);
  });

  it("a refused locale is failed and not mirrored", async () => {
    const db = makeDb();
    const res = await run(fakeAdmin({ refuse: ["fr"] }), db);
    expect(res.savedLocales).toEqual(["de"]);
    expect(res.failedLocales).toEqual(["fr"]);
    expect(altWrites(db)).toEqual(["Kiste"]);
  });

  it("no digest: every locale failed, nothing mirrored, nothing sent", async () => {
    const admin = fakeAdmin({ digest: null });
    const db = makeDb();
    const res = await run(admin, db);
    expect(res.failedLocales).toEqual(["de", "fr"]);
    expect(altWrites(db)).toEqual([]);
    expect(admin.registers).toEqual([]);
  });

  it("a register accepted without storing (nothing echoed) is failed, not mirrored, not claimed for that locale", async () => {
    const db = makeDb();
    const res = await run(fakeAdmin({ silent: ["fr"] }), db);
    expect(res.savedLocales).toEqual(["de"]);
    expect(res.failedLocales).toEqual(["fr"]);
    expect(altWrites(db)).toEqual(["Kiste"]);
  });

  it("mirrors the value Shopify STORED, resolved by (productId, mediaId) now", async () => {
    const admin = fakeAdmin({ stored: { de: "Kiste (normalisiert)" } });
    const db = makeDb();
    await run(admin, db);
    expect(altWrites(db)[0]).toBe("Kiste (normalisiert)");
    expect(db.productImage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { mediaId: MEDIA, product: { shop: SHOP } } }),
    );
  });

  it("an image deleted by a concurrent sync is not mirrored under a guessed id", async () => {
    const db = makeDb();
    db.productImage.findFirst.mockResolvedValue(null);
    db.productImage.findMany.mockResolvedValue([]);
    const res = await run(fakeAdmin(), db);
    expect(altWrites(db)).toEqual([]);
    expect(res.failedLocales).toEqual([]);
  });
});

// -------------------------------------------------------------------------------
describe("alt-text.action handleSaveImageAltText (foreign locale)", () => {
  async function run(admin: ReturnType<typeof fakeAdmin>, db: any, altText = "Kiste") {
    const { handleSaveImageAltText } = await import("~/actions/content/alt-text.action");
    const fd = new FormData();
    fd.set("mediaId", MEDIA);
    fd.set("altText", altText);
    fd.set("locale", "de");
    fd.set("primaryLocale", "en");
    const res: any = await handleSaveImageAltText(
      { admin: admin as never, db: db as never, session: { shop: SHOP } as never } as never,
      fd,
    );
    return { body: res.data ?? res, status: res.init?.status };
  }

  it("echoed: mirrored under the cache row and claimed", async () => {
    const db = makeDb();
    const { body } = await run(fakeAdmin(), db);
    expect(body.success).toBe(true);
    expect(db.productImageAltTranslation.upsert).toHaveBeenCalled();
    expect(markTranslationSaved).toHaveBeenCalledWith(MEDIA);
  });

  it("no digest: 400, nothing mirrored, no claim", async () => {
    const db = makeDb();
    const { body, status } = await run(fakeAdmin({ digest: null }), db);
    expect(body.success).toBe(false);
    expect(status).toBe(400);
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
    expect(markTranslationSaved).not.toHaveBeenCalled();
  });

  it("refused: success false, not mirrored", async () => {
    const db = makeDb();
    const { body } = await run(fakeAdmin({ refuse: ["de"] }), db);
    expect(body.success).toBe(false);
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
  });

  it("accepted-but-unechoed is NOT a save: success false, not mirrored, no claim", async () => {
    const db = makeDb();
    const { body } = await run(fakeAdmin({ silent: ["de"] }), db);
    expect(body.success).toBe(false);
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
    expect(markTranslationSaved).not.toHaveBeenCalled();
  });

  it("a transport failure answers 500 and mirrors nothing", async () => {
    const admin = fakeAdmin();
    admin.graphql.mockRejectedValueOnce(new Error("boom"));
    const db = makeDb();
    const { body, status } = await run(admin, db);
    expect(body.success).toBe(false);
    expect(status).toBe(500);
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
  });

  it("clearing removes the translation (echo or re-read) and deletes the GLOBAL row only on confirmation", async () => {
    const db = makeDb();
    const { body } = await run(fakeAdmin({ removeEcho: true }), db, "");
    expect(body.success).toBe(true);
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalledWith({
      where: { imageId: { in: ["img-row"] }, locale: "de", marketId: "" },
    });
  });

  it("a medium SHARED by products A and B: a confirmed clear on A removes B's row too", async () => {
    const db = makeDb();
    db.productImage.findMany.mockResolvedValue([{ id: "row-of-A" }, { id: "row-of-B" }]);
    const { body } = await run(fakeAdmin({ removeEcho: true }), db, "");
    expect(body.success).toBe(true);
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalledWith({
      where: { imageId: { in: ["row-of-A", "row-of-B"] }, locale: "de", marketId: "" },
    });
  });

  it("a medium SHARED by products A and B: a confirmed write updates BOTH rows", async () => {
    const db = makeDb();
    db.productImage.findMany.mockResolvedValue([{ id: "row-of-A" }, { id: "row-of-B" }]);
    const { body } = await run(fakeAdmin(), db);
    expect(body.success).toBe(true);
    const ids = db.productImageAltTranslation.upsert.mock.calls.map(
      (c: any) => c[0].where.imageId_locale_marketId.imageId,
    );
    expect(ids).toEqual(["row-of-A", "row-of-B"]);
  });

  it("clearing: an unconfirmed removal keeps the local row", async () => {
    const db = makeDb();
    const { body } = await run(fakeAdmin({ removeEcho: false, stillPresent: true }), db, "");
    expect(body.success).toBe(false);
    expect(db.productImageAltTranslation.deleteMany).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------
describe("api-ai alt-text handlers (product path)", () => {
  const PID = "gid://shopify/Product/1";
  function ctx(admin: ReturnType<typeof fakeAdmin>, db: any, form: Record<string, string>) {
    const formData = new FormData();
    for (const [k, v] of Object.entries(form)) formData.set(k, v);
    return {
      session: { shop: SHOP },
      admin,
      db,
      settings: null,
      formData,
      contentType: "products",
      itemId: PID,
    } as never;
  }

  describe("handleTranslateAltTextToAllLocales", () => {
    async function run(admin: ReturnType<typeof fakeAdmin>, db: any) {
      const { handleTranslateAltTextToAllLocales } = await import("~/routes/api-ai-handlers/alt-text.handler");
      batch.mockResolvedValue({ "0": { de: "Kiste", fr: "Boite" } });
      const res: any = await handleTranslateAltTextToAllLocales(
        ctx(admin, db, {
          imageIndex: "0",
          sourceAltText: "Box",
          targetLocales: JSON.stringify(["de", "fr"]),
          primaryLocale: "en",
          productId: PID,
        }),
      );
      return res.data ?? res;
    }

    it("echoed locales are mirrored and claimed", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin(), db);
      expect(res.failedLocales).toEqual([]);
      expect(altWrites(db)).toEqual(["Kiste", "Boite"]);
      expect(markTranslationSaved).toHaveBeenCalledWith(MEDIA);
    });

    it("refused locale is failed, not mirrored", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin({ refuse: ["fr"] }), db);
      expect(res.failedLocales).toEqual(["fr"]);
      expect(altWrites(db)).toEqual(["Kiste"]);
    });

    it("no digest: all locales failed", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin({ digest: null }), db);
      expect(res.failedLocales).toEqual(["de", "fr"]);
      expect(altWrites(db)).toEqual([]);
    });

    it("accepted-but-unechoed is failed and not mirrored", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin({ silent: ["fr"] }), db);
      expect(res.savedLocales).toEqual(["de"]);
      expect(res.failedLocales).toEqual(["fr"]);
      expect(altWrites(db)).toEqual(["Kiste"]);
    });
  });

  describe("handleTranslateAllAltTextsToAllLocales", () => {
    async function run(admin: ReturnType<typeof fakeAdmin>, db: any) {
      const { handleTranslateAllAltTextsToAllLocales } = await import("~/routes/api-ai-handlers/alt-text.handler");
      batch.mockResolvedValue({ "0": { de: "Kiste", fr: "Boite" } });
      const res: any = await handleTranslateAllAltTextsToAllLocales(
        ctx(admin, db, {
          altTextsData: JSON.stringify({ "0": "Box" }),
          targetLocales: JSON.stringify(["de", "fr"]),
          primaryLocale: "en",
          productId: PID,
        }),
      );
      return res.data ?? res;
    }

    it("echoed: savedCount counts mirrored, claim made", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin(), db);
      expect(res.savedCount).toBe(2);
      expect(res.failedImages).toEqual([]);
      expect(markTranslationSaved).toHaveBeenCalledWith(MEDIA);
    });

    it("refused locale marks the image failed", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin({ refuse: ["fr"] }), db);
      expect(res.savedCount).toBe(1);
      expect(res.failedImages).toEqual([0]);
    });

    it("no digest: image failed", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin({ digest: null }), db);
      expect(res.failedImages).toEqual([0]);
      expect(res.savedCount).toBe(0);
    });

    it("accepted-but-unechoed is not saved: the image is reported failed", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin({ silent: ["fr"] }), db);
      expect(res.savedCount).toBe(1);
      expect(res.failedImages).toEqual([0]);
      expect(altWrites(db)).toEqual(["Kiste"]);
    });
  });

  describe("handleTranslateAllAltTextsForLocale", () => {
    async function run(admin: ReturnType<typeof fakeAdmin>, db: any) {
      const { handleTranslateAllAltTextsForLocale } = await import("~/routes/api-ai-handlers/alt-text.handler");
      batch.mockResolvedValue({ "0": { de: "Kiste" } });
      const res: any = await handleTranslateAllAltTextsForLocale(
        ctx(admin, db, {
          altTextsData: JSON.stringify({ "0": "Box" }),
          targetLocale: "de",
          primaryLocale: "en",
          productId: PID,
        }),
      );
      return res.data ?? res;
    }

    it("echoed: saved and claimed", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin(), db);
      expect(res.savedCount).toBe(1);
      expect(markTranslationSaved).toHaveBeenCalledWith(MEDIA);
    });

    it("refused: failed image, not mirrored", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin({ refuse: ["de"] }), db);
      expect(res.failedImages).toEqual([0]);
      expect(altWrites(db)).toEqual([]);
    });

    it("no digest: failed image", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin({ digest: null }), db);
      expect(res.failedImages).toEqual([0]);
    });

    it("accepted-but-unechoed is not saved: failed image, not mirrored, no claim", async () => {
      const db = makeDb();
      const res = await run(fakeAdmin({ silent: ["de"] }), db);
      expect(res.savedCount).toBe(0);
      expect(res.failedImages).toEqual([0]);
      expect(altWrites(db)).toEqual([]);
      expect(markTranslationSaved).not.toHaveBeenCalled();
    });
  });
});

// -------------------------------------------------------------------------------
describe("api.apply-alt-text-templates action (foreign locale)", () => {
  async function run(admin: ReturnType<typeof fakeAdmin>, db: any) {
    vi.doMock("../../app/shopify.server", () => ({
      authenticate: { admin: vi.fn(async () => ({ admin, session: { shop: SHOP } })) },
    }));
    vi.doMock("../../app/db.server", () => ({
      db: Object.assign(db, {
        altTextTemplate: {
          findMany: vi.fn(async () => [{ position: 1, template: "Kiste {color}", locale: "de" }]),
        },
      }),
    }));
    vi.resetModules();
    const { action } = await import("../../app/routes/api.apply-alt-text-templates");
    const res: any = await action({
      request: new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          productId: "p1",
          locale: "de",
          primaryLocale: "en",
          scope: "all",
          variants: [{ title: "V", mainImageGid: MEDIA, galleryFileGids: [], selectedOptions: [] }],
        }),
      }),
    } as never);
    return res.data ?? res;
  }

  it("echoed: applied, mirrored through the (productId, mediaId) upsert, claimed", async () => {
    const db = makeDb();
    const res = await run(fakeAdmin(), db);
    expect(res).toMatchObject({ success: true, applied: 1 });
    expect(db.productImage.upsert).toHaveBeenCalled();
    expect(db.productImageAltTranslation.upsert).toHaveBeenCalled();
    expect(markTranslationSaved).toHaveBeenCalledWith(MEDIA);
  });

  it("no digest: reported as an error, not mirrored", async () => {
    const db = makeDb();
    const res = await run(fakeAdmin({ digest: null }), db);
    expect(res.success).toBe(false);
    expect(res.applied).toBe(0);
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
  });

  it("refused: reported as an error, not mirrored", async () => {
    const db = makeDb();
    const res = await run(fakeAdmin({ refuse: ["de"] }), db);
    expect(res.applied).toBe(0);
    expect(res.errors?.[0]).toContain("refused");
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
  });

  it("accepted-but-unechoed is an error, not applied, not mirrored, not claimed", async () => {
    const db = makeDb();
    const res = await run(fakeAdmin({ silent: ["de"] }), db);
    expect(res.applied).toBe(0);
    expect(res.errors?.[0]).toContain("did not store");
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
    expect(markTranslationSaved).not.toHaveBeenCalled();
  });

  it("mirrors the value Shopify stored", async () => {
    const db = makeDb();
    await run(fakeAdmin({ stored: { de: "Kiste (normalisiert)" } }), db);
    expect(db.productImageAltTranslation.upsert.mock.calls[0][0].create.altText).toBe("Kiste (normalisiert)");
  });

  it("inside the transaction only THIS product's row is mirrored; the shared medium's other rows after commit", async () => {
    const db = makeDb();
    // A distinct transaction client, so the two phases can be told apart.
    const tx: any = {
      productImage: {
        findMany: vi.fn(async () => [{ id: "img-row" }]),
        upsert: vi.fn(async () => ({ id: "img-row" })),
      },
      productImageAltTranslation: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({})) },
    };
    db.$transaction = vi.fn(async (fn: (t: unknown) => unknown) => fn(tx));
    db.productImage.findMany = vi.fn(async () => [{ id: "img-row" }, { id: "row-of-B" }]);
    const res = await run(fakeAdmin(), db);
    expect(res).toMatchObject({ success: true, applied: 1 });
    // In the transaction: narrowed to p1's own row.
    expect(tx.productImage.findMany.mock.calls[0][0].where).toMatchObject({ mediaId: MEDIA, productId: "p1" });
    expect(tx.productImageAltTranslation.upsert).toHaveBeenCalledTimes(1);
    // After commit, with the global client: every product's row of the medium.
    expect(db.productImage.findMany.mock.calls[0][0].where.productId).toBeUndefined();
    const ids = db.productImageAltTranslation.upsert.mock.calls.map(
      (c: any) => c[0].where.imageId_locale_marketId.imageId,
    );
    expect(ids).toEqual(["img-row", "row-of-B"]);
  });
});

// -------------------------------------------------------------------------------
describe("mirrorProductMediaAlt", () => {
  function mirrorDb(rows: string[]) {
    return {
      productImage: { findMany: vi.fn(async () => rows.map((id) => ({ id }))) },
      productImageAltTranslation: {
        upsert: vi.fn(async () => ({})),
        deleteMany: vi.fn(async () => ({ count: rows.length })),
      },
    } as any;
  }

  it("a LIST of locales costs one lookup and one deleteMany", async () => {
    const { mirrorProductMediaAlt } = await import("../../app/services/translations/verified-translations.server");
    const db = mirrorDb(["a", "b"]);
    const r = await mirrorProductMediaAlt(db, { shop: SHOP, mediaId: MEDIA, locale: ["de", "fr", "de"], value: "" });
    expect(r).toBe("mirrored");
    expect(db.productImage.findMany).toHaveBeenCalledTimes(1);
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.productImageAltTranslation.deleteMany.mock.calls[0][0].where).toEqual({
      imageId: { in: ["a", "b"] },
      locale: { in: ["de", "fr"] },
      marketId: "",
    });
  });

  it("outside a transaction a row deleted by a concurrent sync (P2003) is skipped, the others written", async () => {
    const { mirrorProductMediaAlt } = await import("../../app/services/translations/verified-translations.server");
    const db = mirrorDb(["gone", "b"]);
    db.productImageAltTranslation.upsert = vi.fn(async (args: any) => {
      if (args.where.imageId_locale_marketId.imageId === "gone") throw Object.assign(new Error("fk"), { code: "P2003" });
      return {};
    });
    const r = await mirrorProductMediaAlt(db, { shop: SHOP, mediaId: MEDIA, locale: "de", value: "Kiste" });
    expect(r).toBe("mirrored");
    expect(db.productImageAltTranslation.upsert).toHaveBeenCalledTimes(2);
  });

  it("inTransaction: narrowed to the caller's product and a P2003 is RE-THROWN (the tx is already aborted)", async () => {
    const { mirrorProductMediaAlt } = await import("../../app/services/translations/verified-translations.server");
    const db = mirrorDb(["mine"]);
    db.productImageAltTranslation.upsert = vi.fn(async () => {
      throw Object.assign(new Error("fk"), { code: "P2003" });
    });
    await expect(
      mirrorProductMediaAlt(db, { shop: SHOP, mediaId: MEDIA, locale: "de", value: "Kiste", productId: "p1", inTransaction: true }),
    ).rejects.toThrow("fk");
    expect(db.productImage.findMany.mock.calls[0][0].where).toMatchObject({ productId: "p1" });
  });

  it("inTransaction without a productId refuses rather than touching other products' rows", async () => {
    const { mirrorProductMediaAlt } = await import("../../app/services/translations/verified-translations.server");
    await expect(
      mirrorProductMediaAlt(mirrorDb(["a"]), { shop: SHOP, mediaId: MEDIA, locale: "de", value: "x", inTransaction: true }),
    ).rejects.toThrow(/requires productId/);
  });
});

// -------------------------------------------------------------------------------
describe("registerMediaAltAndVerify / removeMediaAltAndVerify", () => {
  it("echoed: confirmed with the stored value and the digest used", async () => {
    const { registerMediaAltAndVerify } = await import("../../app/services/translations/verified-translations.server");
    const admin = fakeAdmin({ stored: { de: "Kiste!" } });
    const r = await registerMediaAltAndVerify(admin, MEDIA, "de", "Kiste");
    expect(r).toMatchObject({ confirmed: true, storedValue: "Kiste!", digest: "dg1", noDigest: false });
    expect(admin.registers[0].translations[0]).toMatchObject({ key: "alt", locale: "de", translatableContentDigest: "dg1" });
  });

  it("unechoed: not confirmed, no stored value", async () => {
    const { registerMediaAltAndVerify } = await import("../../app/services/translations/verified-translations.server");
    const r = await registerMediaAltAndVerify(fakeAdmin({ silent: ["de"] }), MEDIA, "de", "Kiste");
    expect(r).toMatchObject({ confirmed: false, noDigest: false });
    expect(r.storedValue).toBeUndefined();
  });

  it("no digest: nothing is sent", async () => {
    const { registerMediaAltAndVerify } = await import("../../app/services/translations/verified-translations.server");
    const admin = fakeAdmin({ digest: null });
    const r = await registerMediaAltAndVerify(admin, MEDIA, "de", "Kiste");
    expect(r).toMatchObject({ confirmed: false, noDigest: true });
    expect(admin.registers).toEqual([]);
  });

  it("an absent resource throws instead of reading as 'no digest'", async () => {
    const { registerMediaAltAndVerify } = await import("../../app/services/translations/verified-translations.server");
    await expect(registerMediaAltAndVerify(fakeAdmin({ digest: undefined }), MEDIA, "de", "Kiste")).rejects.toThrow(
      /not found/,
    );
  });

  it("removal: confirmed by echo, or by the re-read; a still-present key is not confirmed", async () => {
    const { removeMediaAltAndVerify } = await import("../../app/services/translations/verified-translations.server");
    expect((await removeMediaAltAndVerify(fakeAdmin({ removeEcho: true }), MEDIA, "de")).confirmed).toBe(true);
    expect((await removeMediaAltAndVerify(fakeAdmin({ removeEcho: false }), MEDIA, "de")).confirmed).toBe(true);
    expect((await removeMediaAltAndVerify(fakeAdmin({ removeEcho: false, stillPresent: true }), MEDIA, "de")).confirmed).toBe(
      false,
    );
  });
});
