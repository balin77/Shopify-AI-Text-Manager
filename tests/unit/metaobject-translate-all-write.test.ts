/**
 * Metaobject translate-all (translateMetaobjectEntries in translation.action.ts,
 * reached through handleTranslateAll) -- PLAN_TRANSLATION_WRITE_UNIFICATION Phase G.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const META = "gid://shopify/Metaobject/9";
const FIELD = `${META}#name`;

const translateProduct = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/translation.service", () => ({
  TranslationService: class {
    translateProduct = translateProduct;
  },
}));
vi.mock("~/services/tasks/resource-title.server", () => ({
  taskTitleOrFallback: vi.fn(async () => "T"),
}));
vi.mock("~/utils/ai-refusal-response.server", () => ({
  managedRefusalResponseFromError: vi.fn(() => null),
}));

import { handleTranslateAll } from "../../app/actions/content/translation.action";

const shopify = {
  echo: undefined as undefined | ((v: any) => { key: string; locale: string; value?: string }[]),
  userErrors: [] as { message: string }[],
  digest: "dN" as string | null,
  registers: [] as any[],
  throwOnRegister: false,
};

function makeAdmin() {
  return {
    graphql: vi.fn(async (query: string, opts?: { variables?: any }) => {
      const v = opts?.variables ?? {};
      if (query.includes("translationsRegister")) {
        if (shopify.throwOnRegister) throw new Error("boom");
        shopify.registers.push(v);
        const stored = shopify.echo ? shopify.echo(v) : v.translations.map((t: any) => ({ key: t.key, locale: t.locale, value: t.value }));
        return { json: async () => ({ data: { translationsRegister: { translations: stored, userErrors: shopify.userErrors } } }) };
      }
      if (query.includes("translatableContent")) {
        const content = shopify.digest ? [{ key: "name", digest: shopify.digest }] : [];
        return { json: async () => ({ data: { translatableResource: { translatableContent: content } } }) };
      }
      return { json: async () => ({ data: {} }) };
    }),
  };
}

function makeCtx() {
  const taskUpdates: any[] = [];
  const db: any = {
    task: {
      create: vi.fn(async () => ({ id: "task1" })),
      update: vi.fn(async (a: any) => {
        taskUpdates.push(a.data);
        return {};
      }),
    },
    metaobject: { findUnique: vi.fn(async () => ({ type: "vase" })) },
    metaobjectTranslation: { upsert: vi.fn(async (a: any) => a) },
  };
  const ctx = {
    admin: makeAdmin(),
    session: { shop: "s.myshopify.com" },
    contentConfig: { resourceType: "Metaobject", contentType: "metaobjects", fieldDefinitions: [] },
    db,
    aiInstructions: null,
    itemId: "metaobject_type_vase",
    shopifyContentService: {},
    provider: "anthropic",
    serviceConfig: {},
    seoTitleMaxChars: 70,
    seoLimits: {},
    translationMode: "exact",
  } as never;
  const formData = new FormData();
  formData.set(FIELD, "Hallo");
  formData.set("targetLocales", JSON.stringify(["en", "fr"]));
  return { ctx, formData, db, taskUpdates };
}

const body = (r: any) => r?.data ?? r;

beforeEach(() => {
  shopify.echo = undefined;
  shopify.userErrors = [];
  shopify.digest = "dN";
  shopify.registers = [];
  shopify.throwOnRegister = false;
  translateProduct.mockReset();
  translateProduct.mockResolvedValue({ en: { entry_0: "Hello" }, fr: { entry_0: "Salut" } });
});

describe("metaobject translate-all", () => {
  it("registers per entry and locale with the digest and mirrors on echo", async () => {
    const { ctx, formData, db } = makeCtx();
    const r = await handleTranslateAll(ctx, formData);
    expect(body(r)).toMatchObject({
      success: true,
      translations: { en: { [FIELD]: "Hello" }, fr: { [FIELD]: "Salut" } },
      failedLocales: [],
      rejectedFields: {},
    });
    expect(shopify.registers).toHaveLength(2);
    expect(shopify.registers[0].translations[0]).toMatchObject({ key: "name", locale: "en", translatableContentDigest: "dN" });
    expect(db.metaobjectTranslation.upsert).toHaveBeenCalledTimes(2);
    expect(db.metaobjectTranslation.upsert.mock.calls[0][0].create).toMatchObject({
      metaobjectId: META, type: "vase", key: "name", locale: "en", value: "Hello",
    });
  });

  it("does not register or mirror an entry whose field has no digest (nothing to translate)", async () => {
    shopify.digest = null;
    const { ctx, formData, db } = makeCtx();
    await handleTranslateAll(ctx, formData);
    expect(shopify.registers).toHaveLength(0);
    expect(db.metaobjectTranslation.upsert).not.toHaveBeenCalled();
  });

  it("userErrors / an unechoed register: nothing mirrored, entries reported as rejected", async () => {
    shopify.userErrors = [{ message: "nope" }];
    shopify.echo = () => [];
    const { ctx, formData, db, taskUpdates } = makeCtx();
    const r = await handleTranslateAll(ctx, formData);
    expect(body(r).success).toBe(true);
    expect(body(r).rejectedFields).toEqual({ en: [FIELD], fr: [FIELD] });
    expect(body(r).translations).toEqual({ en: {}, fr: {} });
    expect(db.metaobjectTranslation.upsert).not.toHaveBeenCalled();
    expect(taskUpdates.at(-1).status).toBe("completed_with_errors");
  });

  it("a partial echo mirrors only the confirmed locale, with the value Shopify stored", async () => {
    shopify.echo = (v) => (v.translations[0].locale === "fr" ? [{ key: "name", locale: "FR", value: "Stocke" }] : []);
    const { ctx, formData, db } = makeCtx();
    const r = await handleTranslateAll(ctx, formData);
    expect(body(r).rejectedFields).toEqual({ en: [FIELD] });
    expect(body(r).translations).toEqual({ en: {}, fr: { [FIELD]: "Stocke" } });
    expect(db.metaobjectTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(db.metaobjectTranslation.upsert.mock.calls[0][0].create).toMatchObject({ locale: "fr", value: "Stocke" });
  });

  it("a thrown register is a rejection, not a mirrored translation", async () => {
    shopify.throwOnRegister = true;
    const { ctx, formData, db } = makeCtx();
    const r = await handleTranslateAll(ctx, formData);
    expect(Object.keys(body(r).rejectedFields).sort()).toEqual(["en", "fr"]);
    expect(db.metaobjectTranslation.upsert).not.toHaveBeenCalled();
  });

  it("a confirmed write stays when only our mirror fails", async () => {
    const { ctx, formData, db } = makeCtx();
    db.metaobjectTranslation.upsert.mockRejectedValue(new Error("db down"));
    const r = await handleTranslateAll(ctx, formData);
    expect(body(r).rejectedFields).toEqual({});
    expect(body(r).translations).toEqual({ en: { [FIELD]: "Hello" }, fr: { [FIELD]: "Salut" } });
  });
});
