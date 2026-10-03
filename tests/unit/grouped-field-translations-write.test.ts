/**
 * api.grouped-field-translations `update` intent: the re-sync of one product
 * type translation over every product that shares the source value
 * (PLAN_TRANSLATION_WRITE_UNIFICATION Phase G).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const shopify = {
  echo: undefined as undefined | ((v: any) => { key: string; locale: string; value?: string }[]),
  userErrors: [] as { message: string }[],
  /** product id -> digest for product_type; absent = no digest */
  digests: {} as Record<string, string>,
  registers: [] as any[],
};

const admin = {
  graphql: vi.fn(async (query: string, opts?: { variables?: any }) => {
    const v = opts?.variables ?? {};
    if (query.includes("translationsRegister")) {
      shopify.registers.push(v);
      const stored = shopify.echo ? shopify.echo(v) : v.translations.map((t: any) => ({ key: t.key, locale: t.locale, value: t.value }));
      return { json: async () => ({ data: { translationsRegister: { translations: stored, userErrors: shopify.userErrors } } }) };
    }
    if (query.includes("translatableContent")) {
      const digest = shopify.digests[v.resourceId];
      const content = digest ? [{ key: "product_type", digest }] : [];
      return { json: async () => ({ data: { translatableResource: { resourceId: v.resourceId, translatableContent: content } } }) };
    }
    return { json: async () => ({ data: {} }) };
  }),
};

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ admin, session: { shop: "s.myshopify.com" } })) },
}));

const products = [{ id: "gid://shopify/Product/1" }, { id: "gid://shopify/Product/2" }];
vi.mock("../../src/services/grouped-field-translation.service", () => ({
  GroupedFieldTranslationService: class {
    findProductsUsingSourceValue = vi.fn(async () => products);
  },
}));

const markSaved = vi.fn();
vi.mock("~/utils/translation-save-lock.server", () => ({
  markTranslationSaved: (id: string) => markSaved(id),
  isTranslationRecentlySaved: () => false,
  translationSavedAt: () => null,
}));

const dbMock = vi.hoisted(() => ({
  groupedFieldTranslation: {
    findFirst: vi.fn(async () => ({
      id: "e1", fieldKey: "productType", sourceValue: "Vase", sourceValueNorm: "vase", targetLocale: "fr",
    })),
    update: vi.fn(async () => ({})),
  },
  task: { create: vi.fn(async () => ({ id: "task1" })), update: vi.fn(async (_a: any) => ({})) },
  contentTranslation: { upsert: vi.fn(async (a: any) => a) },
}));
vi.mock("../../app/db.server", () => ({ db: dbMock }));

import { action } from "../../app/routes/api.grouped-field-translations";

const body = (r: any) => r?.data ?? r;
const call = () =>
  action({
    request: new Request("http://x/api/grouped-field-translations", {
      method: "POST",
      body: JSON.stringify({ intent: "update", id: "e1", translatedValue: " Vase FR " }),
    }),
    params: {},
    context: {},
  } as never);

beforeEach(() => {
  shopify.echo = undefined;
  shopify.userErrors = [];
  shopify.digests = { "gid://shopify/Product/1": "d1", "gid://shopify/Product/2": "d2" };
  shopify.registers = [];
  markSaved.mockClear();
  dbMock.contentTranslation.upsert.mockClear();
  dbMock.task.update.mockClear();
});

describe("grouped-field update re-sync", () => {
  it("registers per product with its digest and mirrors on success, keeping the {ok} shape", async () => {
    const r = await call();
    expect(body(r)).toMatchObject({ ok: true, taskId: "task1", synced: 2, failed: 0, total: 2 });
    expect(shopify.registers).toHaveLength(2);
    expect(shopify.registers[0].translations[0]).toMatchObject({
      key: "product_type", value: "Vase FR", locale: "fr", translatableContentDigest: "d1",
    });
    expect(dbMock.contentTranslation.upsert).toHaveBeenCalledTimes(2);
    expect(dbMock.contentTranslation.upsert.mock.calls[0][0].create).toMatchObject({
      resourceType: "Product", key: "product_type", locale: "fr", value: "Vase FR", digest: "d1",
    });
  });

  it("counts a product without a digest as failed and does not register it", async () => {
    shopify.digests = { "gid://shopify/Product/1": "d1" };
    const r = await call();
    expect(body(r)).toMatchObject({ ok: true, synced: 1, failed: 1 });
    expect(shopify.registers).toHaveLength(1);
  });

  it("counts userErrors as failed and mirrors nothing", async () => {
    shopify.userErrors = [{ message: "nope" }];
    shopify.echo = () => [];
    const r = await call();
    expect(body(r)).toMatchObject({ synced: 0, failed: 2 });
    expect(dbMock.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it("an unechoed register (no userErrors) is NOT mirrored, is counted failed and claims no lock", async () => {
    shopify.echo = () => [];
    const r = await call();
    expect(body(r)).toMatchObject({ ok: true, synced: 0, failed: 2 });
    expect(dbMock.contentTranslation.upsert).not.toHaveBeenCalled();
    expect(markSaved).not.toHaveBeenCalled();
    expect(dbMock.task.update.mock.calls.at(-1)![0].data.status).toBe("completed_with_errors");
  });

  it("a partial echo mirrors and claims only the confirmed product", async () => {
    shopify.echo = (v) =>
      v.resourceId === "gid://shopify/Product/1" ? [{ key: "product_type", locale: "FR", value: "Stored" }] : [];
    const r = await call();
    expect(body(r)).toMatchObject({ synced: 1, failed: 1 });
    expect(dbMock.contentTranslation.upsert).toHaveBeenCalledTimes(1);
    const arg = dbMock.contentTranslation.upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({ resourceId: "gid://shopify/Product/1", locale: "fr", value: "Stored", digest: "d1" });
    expect(markSaved.mock.calls).toEqual([["gid://shopify/Product/1"]]);
  });

  it("claims the translation-save lock of every confirmed product", async () => {
    await call();
    expect(markSaved.mock.calls.map((c) => c[0])).toEqual(["gid://shopify/Product/1", "gid://shopify/Product/2"]);
  });

  it("a mirror failure after a confirmed write still counts the product as synced", async () => {
    dbMock.contentTranslation.upsert.mockRejectedValue(new Error("db down"));
    try {
      const r = await call();
      expect(body(r)).toMatchObject({ ok: true, synced: 2, failed: 0 });
    } finally {
      dbMock.contentTranslation.upsert.mockImplementation(async (a: any) => a);
    }
  });
});
