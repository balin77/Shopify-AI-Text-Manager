/**
 * /api/ai translate-field-to-all-locales writes (PLAN_TRANSLATION_WRITE_UNIFICATION
 * Phase G). Characterises the content, metaobject and theme registers of the
 * batch (short field) and sequential (long field) paths against a mocked admin
 * and db.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const aiMock = {
  translateShortFieldsBatch: vi.fn(),
  translateFieldsToLocalesChunked: vi.fn(),
  translateSlugBatch: vi.fn(),
  translateSlug: vi.fn(),
  translateContent: vi.fn(),
};
vi.mock("~/services/ai/ai-credentials.server", () => ({
  aiServiceFor: () => ({ service: aiMock }),
}));
vi.mock("~/services/tasks/resource-title.server", () => ({
  resolveTaskResourceTitle: vi.fn(async () => "Title"),
}));
vi.mock("~/services/theme-selection.server", () => ({
  resolveSelectedThemeId: vi.fn(async () => null),
}));

const markSaved = vi.hoisted(() => vi.fn());
vi.mock("~/utils/translation-save-lock.server", async (orig) => ({
  ...(await orig<typeof import("~/utils/translation-save-lock.server")>()),
  markTranslationSaved: markSaved,
}));

import { handleTranslateFieldToAllLocales } from "../../app/routes/api-ai-handlers/text-translation.handler";

const PRODUCT = "gid://shopify/Product/1";
const META = "gid://shopify/Metaobject/9";
const THEME_RES = "gid://shopify/OnlineStoreThemeJsonTemplate/1?theme_id=11";
const THEME_KEY = "section.index.json.hero.title";

const shopify = {
  /** undefined = echo what was sent; otherwise decides the echo per call */
  echo: undefined as undefined | ((v: any) => { key: string; locale: string; value?: string }[]),
  userErrors: [] as { message: string }[],
  digests: {} as Record<string, string>,
  registers: [] as any[],
};

function makeAdmin() {
  return {
    graphql: vi.fn(async (query: string, opts?: { variables?: any }) => {
      const v = opts?.variables ?? {};
      if (query.includes("translationsRegister")) {
        shopify.registers.push(v);
        const stored = shopify.echo ? shopify.echo(v) : v.translations.map((t: any) => ({ key: t.key, locale: t.locale, value: t.value }));
        return { json: async () => ({ data: { translationsRegister: { translations: stored, userErrors: shopify.userErrors } } }) };
      }
      if (query.includes("translatableContent")) {
        const content = Object.entries(shopify.digests).map(([key, digest]) => ({ key, digest }));
        return { json: async () => ({ data: { translatableResource: { translatableContent: content } } }) };
      }
      return { json: async () => ({ data: {} }) };
    }),
  };
}

function makeDb(over: { themeRows?: any[] } = {}) {
  const taskUpdates: any[] = [];
  const db: any = {
    task: {
      create: vi.fn(async () => ({ id: "task1" })),
      update: vi.fn(async (a: any) => {
        taskUpdates.push(a.data);
        return {};
      }),
    },
    contentTranslation: { upsert: vi.fn(async (a: any) => a) },
    metaobjectTranslation: { upsert: vi.fn(async (a: any) => a) },
    themeTranslation: { upsert: vi.fn(async (a: any) => a) },
    themeContent: { findMany: vi.fn(async () => over.themeRows ?? []) },
  };
  return { db, taskUpdates };
}

function makeCtx(
  contentType: string,
  itemId: string,
  form: Record<string, string>,
  dbOver: { themeRows?: any[] } = {},
) {
  const { db, taskUpdates } = makeDb(dbOver);
  const admin = makeAdmin();
  const formData = new FormData();
  for (const [k, v] of Object.entries(form)) formData.set(k, v);
  const ctx = {
    session: { shop: "s.myshopify.com", accessToken: "t" },
    admin,
    db,
    formData,
    settings: null,
    contentType,
    itemId,
  } as never;
  return { ctx, db, admin, taskUpdates };
}

const body = (r: any) => r?.data ?? r;
const status = (r: any) => r?.init?.status ?? 200;
const LOCALES = JSON.stringify(["en", "fr"]);

beforeEach(() => {
  shopify.echo = undefined;
  shopify.userErrors = [];
  shopify.digests = { title: "dT", body_html: "dB", [THEME_KEY]: "dTheme", name: "dN" };
  shopify.registers = [];
  markSaved.mockReset();
  for (const fn of Object.values(aiMock)) fn.mockReset();
});

describe("batch path (short field) on a content type", () => {
  const form = { fieldType: "title", sourceText: "Hallo", targetLocales: LOCALES, primaryLocale: "de" };
  const ai = () => aiMock.translateShortFieldsBatch.mockResolvedValue({ en: { title: "Hello" }, fr: { title: "Salut" } });

  it("registers with the digest and mirrors both locales when Shopify echoes", async () => {
    ai();
    const { ctx, db } = makeCtx("products", PRODUCT, form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(body(r)).toMatchObject({ success: true, translations: { en: "Hello", fr: "Salut" }, rejectedFields: {} });
    expect(shopify.registers).toHaveLength(2);
    expect(shopify.registers[0].translations[0]).toMatchObject({ key: "title", locale: "en", translatableContentDigest: "dT" });
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(2);
    expect(db.contentTranslation.upsert.mock.calls[0][0].create).toMatchObject({
      resourceId: PRODUCT, resourceType: "Product", key: "title", locale: "en", value: "Hello", digest: "dT",
    });
  });

  it("rejects the locale on userErrors and mirrors nothing for it", async () => {
    ai();
    shopify.userErrors = [{ message: "nope" }];
    shopify.echo = () => [];
    const { ctx, db } = makeCtx("products", PRODUCT, form);
    await handleTranslateFieldToAllLocales(ctx);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it("an unechoed register is NOT mirrored; the stored value of an echoed one is", async () => {
    ai();
    shopify.echo = (v) => (v.translations[0].locale === "en" ? [{ key: "title", locale: "en", value: "Stored" }] : []);
    const { ctx, db } = makeCtx("products", PRODUCT, form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(body(r).translations).toEqual({ en: "Stored" });
    expect(body(r).rejectedFields).toEqual({ fr: ["title"] });
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.upsert.mock.calls[0][0].create).toMatchObject({ locale: "en", value: "Stored" });
  });

  it("skips Shopify and the mirror when there is no digest", async () => {
    ai();
    shopify.digests = {};
    const { ctx, db } = makeCtx("products", PRODUCT, form);
    await handleTranslateFieldToAllLocales(ctx);
    expect(shopify.registers).toHaveLength(0);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });
});

describe("sequential path (long field) on a content type", () => {
  const form = { fieldType: "description", sourceText: "Hallo", targetLocales: LOCALES, primaryLocale: "de" };
  const ai = () => aiMock.translateFieldsToLocalesChunked.mockResolvedValue({ en: { description: "Hello" }, fr: { description: "Salut" } });

  it("registers body_html with its digest and mirrors on echo", async () => {
    ai();
    const { ctx, db } = makeCtx("products", PRODUCT, form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(body(r)).toMatchObject({ success: true, translations: { en: "Hello", fr: "Salut" } });
    expect(shopify.registers[0].translations[0]).toMatchObject({ key: "body_html", translatableContentDigest: "dB" });
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(2);
    expect(db.contentTranslation.upsert.mock.calls[0][0].create.digest).toBe("dB");
  });

  it("rejects on userErrors: no mirror, locales reported", async () => {
    ai();
    shopify.userErrors = [{ message: "nope" }];
    shopify.echo = () => [];
    const { ctx, db } = makeCtx("products", PRODUCT, form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
    expect(Object.keys(body(r).rejectedFields).sort()).toEqual(["en", "fr"]);
  });

  it("a register that echoes nothing (no userErrors) is NOT mirrored and fails the call", async () => {
    ai();
    shopify.echo = () => [];
    const { ctx, db, taskUpdates } = makeCtx("products", PRODUCT, form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
    expect(body(r).success).toBe(false);
    expect(status(r)).toBe(502);
    expect(Object.keys(body(r).rejectedFields).sort()).toEqual(["en", "fr"]);
    expect(taskUpdates.at(-1).status).toBe("failed");
  });

  it("a partial echo mirrors only the echoed locale, drops the other from the answer and warns", async () => {
    ai();
    shopify.echo = (v) => (v.translations[0].locale === "en" ? [{ key: "body_html", locale: "EN", value: "Stored" }] : []);
    const { ctx, db, taskUpdates } = makeCtx("products", PRODUCT, form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(body(r).success).toBe(true);
    expect(body(r).translations).toEqual({ en: "Stored" });
    expect(body(r).rejectedFields).toEqual({ fr: ["description"] });
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
    const arg = db.contentTranslation.upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({ locale: "en", value: "Stored", digest: "dB" });
    expect(taskUpdates.at(-1).status).toBe("completed_with_errors");
  });

  it("a thrown register is a rejection, not a silent skip", async () => {
    ai();
    shopify.echo = () => {
      throw new Error("boom");
    };
    const { ctx, db } = makeCtx("products", PRODUCT, form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
    expect(body(r).success).toBe(false);
  });
});

describe("sequential path on a metaobject field", () => {
  const FIELD = `${META}#name`;
  const form = { fieldType: FIELD, sourceText: "Hallo", targetLocales: LOCALES, primaryLocale: "de" };
  const ai = () => aiMock.translateFieldsToLocalesChunked.mockResolvedValue({ en: { [FIELD]: "Hello" }, fr: { [FIELD]: "Salut" } });

  it("registers by field key and mirrors MetaobjectTranslation on echo", async () => {
    ai();
    const { ctx, db } = makeCtx("metaobjects", "metaobject_type_vase", form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(body(r).success).toBe(true);
    expect(shopify.registers[0]).toMatchObject({ resourceId: META });
    expect(shopify.registers[0].translations[0]).toMatchObject({ key: "name", translatableContentDigest: "dN" });
    expect(db.metaobjectTranslation.upsert).toHaveBeenCalledTimes(2);
    expect(db.metaobjectTranslation.upsert.mock.calls[0][0].create).toMatchObject({
      metaobjectId: META, type: "vase", key: "name", locale: "en", value: "Hello",
    });
  });

  it("an unechoed register is NOT mirrored and fails the call", async () => {
    ai();
    shopify.echo = () => [];
    const { ctx, db } = makeCtx("metaobjects", "metaobject_type_vase", form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(db.metaobjectTranslation.upsert).not.toHaveBeenCalled();
    expect(body(r).success).toBe(false);
  });

  it("mirrors the value Shopify stored and only for the echoed locale", async () => {
    ai();
    shopify.echo = (v) => (v.translations[0].locale === "fr" ? [{ key: "name", locale: "fr", value: "Stocke" }] : []);
    const { ctx, db } = makeCtx("metaobjects", "metaobject_type_vase", form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(body(r).translations).toEqual({ fr: "Stocke" });
    expect(db.metaobjectTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(db.metaobjectTranslation.upsert.mock.calls[0][0].create).toMatchObject({ locale: "fr", value: "Stocke" });
  });
});

describe("sequential path on theme content", () => {
  const form = { fieldType: THEME_KEY, sourceText: "Hallo", targetLocales: LOCALES, primaryLocale: "de" };
  const themeRows = [
    { resourceId: THEME_RES, domain: "theme", translatableContent: [{ key: THEME_KEY, value: "Hallo", digest: "dTheme" }] },
  ];
  const ai = () => aiMock.translateFieldsToLocalesChunked.mockResolvedValue({ en: { [THEME_KEY]: "Hello" }, fr: { [THEME_KEY]: "Salut" } });

  it("registers and mirrors ThemeTranslation on echo", async () => {
    ai();
    const { ctx, db } = makeCtx("templates", "group_g", form, { themeRows });
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(body(r).success).toBe(true);
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(2);
  });

  it("an unechoed register is NOT mirrored and fails the call", async () => {
    ai();
    shopify.echo = () => [];
    const { ctx, db } = makeCtx("templates", "group_g", form, { themeRows });
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(db.themeTranslation.upsert).not.toHaveBeenCalled();
    expect(body(r).success).toBe(false);
  });
});

describe("phase G review fixes", () => {
  const form = { fieldType: "title", sourceText: "Hallo", targetLocales: LOCALES, primaryLocale: "de" };

  it("batch yields nothing, sequential confirms: success with the confirmed translations", async () => {
    aiMock.translateShortFieldsBatch.mockResolvedValue({});
    aiMock.translateFieldsToLocalesChunked.mockResolvedValue({ en: { title: "Hello" }, fr: { title: "Salut" } });
    const { ctx } = makeCtx("products", PRODUCT, form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(status(r)).toBe(200);
    expect(body(r)).toMatchObject({ success: true, translations: { en: "Hello", fr: "Salut" } });
    expect(body(r).rejectedFields ?? {}).toEqual({});
  });

  it("claims the resource only on a confirmed write", async () => {
    aiMock.translateShortFieldsBatch.mockResolvedValue({ en: { title: "Hello" }, fr: { title: "Salut" } });
    shopify.echo = () => [];
    const a = makeCtx("products", PRODUCT, form);
    await handleTranslateFieldToAllLocales(a.ctx);
    expect(markSaved).not.toHaveBeenCalled();

    shopify.echo = undefined;
    const b = makeCtx("products", PRODUCT, form);
    await handleTranslateFieldToAllLocales(b.ctx);
    expect(markSaved).toHaveBeenCalledWith(PRODUCT);
  });

  it("every failed locale yields the localized error code", async () => {
    aiMock.translateShortFieldsBatch.mockResolvedValue({ en: { title: "Hello" }, fr: { title: "Salut" } });
    shopify.echo = () => [];
    const { ctx } = makeCtx("products", PRODUCT, form);
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(status(r)).toBe(502);
    expect(body(r).error).toBe("translateStoreFailedAll");
  });
});
