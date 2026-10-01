/**
 * Theme translation writes (PLAN_TRANSLATION_WRITE_UNIFICATION Phase F).
 *
 * Characterises the CURRENT behaviour of translate-field, translate-to-all,
 * translate-all and handleUpdateContent's foreign register / foreign clear /
 * primary-change purge, against a mocked Shopify admin and a mocked db.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RES = "gid://shopify/OnlineStoreThemeJsonTemplate/1?theme_id=11";
const KEY = "section.index.json.hero.title";

vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: vi.fn(async () => ({
    purgeOnPrimaryChange: true,
    purgeUnreconciledSurfaces: true,
    autoTranslateExternalChanges: false,
    autoTranslateHandles: false,
  })),
  isPurgeOnPrimaryChangeEnabled: vi.fn(async () => true),
}));
vi.mock("~/services/theme-selection.server", () => ({
  resolveSelectedThemeId: vi.fn(async () => "gid://shopify/OnlineStoreTheme/11"),
}));
vi.mock("~/services/translations/market-layer-purge.server", () => ({
  purgeMarketOverrides: vi.fn(async () => undefined),
}));
vi.mock("~/utils/ai-refusal-response.server", () => ({
  aiRefusalFor: vi.fn(async () => null),
  managedRefusalResponseFromError: vi.fn(() => null),
}));
const translateChunked = vi.fn();
vi.mock("~/services/ai/ai-credentials.server", () => ({
  aiServiceFor: () => ({
    service: {
      translateContent: vi.fn(async (text: string, _p: string, l: string) => `${l}:${text}`),
      translateFieldsToLocalesChunked: (...a: unknown[]) => translateChunked(...a),
    },
  }),
}));
const markSaved = vi.fn();
vi.mock("~/utils/translation-save-lock.server", () => ({
  markTranslationSaved: (id: string) => markSaved(id),
  isTranslationRecentlySaved: () => false,
  translationSavedAt: () => null,
}));

import { handleTranslateField, handleTranslateFieldToAllLocales } from "../../app/actions/templates/templates-translate-field.action";
import { handleTranslateAll } from "../../app/actions/templates/templates-translate-all.action";
import { handleUpdateContent } from "../../app/actions/templates/templates-update.action";

/** What the fake Shopify does. Tests mutate it. */
const shopify = {
  registerStores: (_v: any): { key: string; locale: string; value?: string }[] | null => null,
  registerUserErrors: [] as { message: string }[],
  removeEchoes: true,
  removeUserErrors: [] as { message: string }[],
  /** locale -> keys still carrying a translation (for the re-read) */
  present: {} as Record<string, string[]>,
  registers: [] as any[],
  removes: [] as any[],
  rereads: 0,
};

function makeAdmin() {
  return {
    graphql: vi.fn(async (query: string, opts?: { variables?: any }) => {
      const v = opts?.variables ?? {};
      if (query.includes("translationsRegister")) {
        shopify.registers.push(v);
        const stored = shopify.registerStores(v) ?? v.translations.map((t: any) => ({ key: t.key, locale: t.locale, value: t.value }));
        return { json: async () => ({ data: { translationsRegister: { translations: stored, userErrors: shopify.registerUserErrors } } }) };
      }
      if (query.includes("translationsRemove")) {
        shopify.removes.push(v);
        const echoed = shopify.removeEchoes
          ? v.translationKeys.flatMap((key: string) => v.locales.map((locale: string) => ({ key, locale })))
          : [];
        return { json: async () => ({ data: { translationsRemove: { translations: echoed, userErrors: shopify.removeUserErrors } } }) };
      }
      if (query.includes("verifyTranslationRemoval")) {
        shopify.rereads++;
        const keys = shopify.present[v.locale] ?? [];
        return {
          json: async () => ({
            data: { translatableResource: { translations: keys.map((key) => ({ key, value: "x", market: null })) } },
          }),
        };
      }
      if (query.includes("shopLocales")) {
        return {
          json: async () => ({
            data: {
              shopLocales: [
                { locale: "de", primary: true, published: true },
                { locale: "en", primary: false, published: true },
                { locale: "fr", primary: false, published: true },
              ],
            },
          }),
        };
      }
      if (query.includes("translatableContent")) {
        return { json: async () => ({ data: { translatableResource: { translatableContent: [{ key: KEY, digest: "live" }] } } }) };
      }
      if (query.includes("themeFilesUpsert")) {
        return {
          json: async () => ({
            data: { themeFilesUpsert: { upsertedThemeFiles: (v.files ?? []).map((f: any) => ({ filename: f.filename })), userErrors: [] } },
          }),
        };
      }
      if (query.includes("files(")) {
        return {
          json: async () => ({
            data: {
              theme: {
                files: {
                  nodes: [{ filename: "templates/index.json", body: { content: JSON.stringify({ sections: { hero: { settings: { title: "Alt" } } } }) } }],
                },
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    }),
  };
}

function makeDb(rows: any[] = []) {
  const taskUpdates: any[] = [];
  const db: any = {
    aISettings: { findUnique: vi.fn(async () => ({ themeRichtextMode: "autofix" })) },
    task: {
      create: vi.fn(async () => ({ id: "task1" })),
      update: vi.fn(async (a: any) => {
        taskUpdates.push(a.data);
        return {};
      }),
    },
    themeContent: { updateMany: vi.fn(async () => ({ count: 1 })) },
    themeTranslation: {
      upsert: vi.fn(async (a: any) => a),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => rows),
    },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  };
  return { db, taskUpdates };
}

function makeCtx(over: { formEntries?: Record<string, string>; rows?: any[] } = {}) {
  const { db, taskUpdates } = makeDb(over.rows);
  const admin = makeAdmin();
  const formData = new FormData();
  for (const [k, val] of Object.entries(over.formEntries ?? {})) formData.set(k, val);
  const group = {
    groupId: "g",
    groupName: "Hero",
    resourceId: RES,
    translatableContent: [{ key: KEY, value: "Alt", digest: "d1" }],
  };
  const ctx = {
    admin,
    db,
    session: { shop: "s.myshopify.com" },
    formData,
    domain: "theme",
    groupId: "g",
    themeGroups: [group],
    firstGroup: group,
    resourceId: RES,
    keyToResourceId: new Map([[KEY, RES]]),
    keyToResourceType: new Map([[KEY, "ONLINE_STORE_THEME_JSON_TEMPLATE"]]),
    selectedThemeId: "gid://shopify/OnlineStoreTheme/11",
  } as never;
  return { ctx, db, admin, taskUpdates };
}

const body = (r: any) => r?.data ?? r;
const status = (r: any) => r?.init?.status ?? 200;

beforeEach(() => {
  shopify.registerStores = () => null;
  shopify.registerUserErrors = [];
  shopify.removeEchoes = true;
  shopify.removeUserErrors = [];
  shopify.present = {};
  shopify.registers = [];
  shopify.removes = [];
  shopify.rereads = 0;
  markSaved.mockClear();
  translateChunked.mockReset();
});

describe("handleTranslateField", () => {
  const form = { fieldType: KEY, sourceText: "Hallo", targetLocale: "en", primaryLocale: "de" };

  it("registers and mirrors the translation when Shopify accepts it", async () => {
    const { ctx, db } = makeCtx({ formEntries: form });
    const r = await handleTranslateField(ctx);
    expect(body(r)).toMatchObject({ success: true, translatedValue: "en:Hallo" });
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(1);
    const arg = db.themeTranslation.upsert.mock.calls[0][0];
    expect(arg.where.shop_resourceId_groupId_key_locale_themeId_marketId).toMatchObject({
      resourceId: RES, groupId: "g", key: KEY, locale: "en", themeId: "gid://shopify/OnlineStoreTheme/11", marketId: "",
    });
    expect(arg.create).toMatchObject({ value: "en:Hallo", domain: "theme", themeId: "gid://shopify/OnlineStoreTheme/11" });
  });

  it("fails and mirrors nothing on userErrors", async () => {
    shopify.registerUserErrors = [{ message: "nope" }];
    shopify.registerStores = () => [];
    const { ctx, db, taskUpdates } = makeCtx({ formEntries: form });
    const r = await handleTranslateField(ctx);
    expect(status(r)).toBe(500);
    expect(db.themeTranslation.upsert).not.toHaveBeenCalled();
    expect(taskUpdates.at(-1).status).toBe("failed");
  });

  it("an unechoed register with no userErrors is NOT mirrored and fails the task", async () => {
    shopify.registerStores = () => [];
    const { ctx, db, taskUpdates } = makeCtx({ formEntries: form });
    const r = await handleTranslateField(ctx);
    expect(status(r)).toBe(500);
    expect(db.themeTranslation.upsert).not.toHaveBeenCalled();
    expect(taskUpdates.at(-1).status).toBe("failed");
    expect(markSaved).not.toHaveBeenCalled();
  });

  it("claims the theme lock and mirrors the value Shopify stored, only after the echo", async () => {
    shopify.registerStores = (v) => [{ key: KEY, locale: "EN", value: "stored" }];
    const { ctx, db } = makeCtx({ formEntries: form });
    const r = await handleTranslateField(ctx);
    expect(body(r)).toMatchObject({ success: true, translatedValue: "stored" });
    expect(db.themeTranslation.upsert.mock.calls[0][0].create.value).toBe("stored");
    expect(markSaved).toHaveBeenCalledWith(RES);
  });
});

describe("handleTranslateFieldToAllLocales", () => {
  const form = { fieldType: KEY, sourceText: "Hallo", targetLocales: JSON.stringify(["en", "fr"]), primaryLocale: "de" };

  it("mirrors only the locales Shopify echoed and reports the rest", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello" }, fr: { [KEY]: "Salut" } });
    shopify.registerStores = (v) => (v.translations[0].locale === "en" ? null : []);
    const { ctx, db, taskUpdates } = makeCtx({ formEntries: form });
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(body(r).success).toBe(true);
    expect(body(r).failedLocales).toEqual(["fr"]);
    expect(Object.keys(body(r).translations)).toEqual(["en"]);
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(db.themeTranslation.upsert.mock.calls[0][0].create.locale).toBe("en");
    expect(taskUpdates.at(-1).status).toBe("completed_with_errors");
    expect(markSaved).toHaveBeenCalledWith(RES);
  });

  it("fails when no locale is confirmed: nothing mirrored, no lock claimed", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello" }, fr: { [KEY]: "Salut" } });
    shopify.registerStores = () => [];
    const { ctx, db } = makeCtx({ formEntries: form });
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(status(r)).toBe(500);
    expect(db.themeTranslation.upsert).not.toHaveBeenCalled();
    expect(markSaved).not.toHaveBeenCalled();
  });
});

describe("handleTranslateAll", () => {
  const form = { targetLocales: JSON.stringify(["en"]), targetLocale: "en", primaryLocale: "de" };

  it("registers per resource+locale and mirrors", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello" } });
    const { ctx, db, taskUpdates } = makeCtx({ formEntries: form });
    const r = await handleTranslateAll(ctx, "translateAll");
    expect(body(r).success).toBe(true);
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(taskUpdates.at(-1).status).toBe("completed");
  });

  it("an unechoed key is not mirrored and the run fails (nothing confirmed)", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello" } });
    shopify.registerStores = () => [];
    const { ctx, db, taskUpdates } = makeCtx({ formEntries: form });
    const r = await handleTranslateAll(ctx, "translateAll");
    expect(status(r)).toBe(500);
    expect(db.themeTranslation.upsert).not.toHaveBeenCalled();
    expect(taskUpdates.at(-1).status).toBe("failed");
    expect(markSaved).not.toHaveBeenCalled();
  });

  it("a partial echo mirrors the confirmed locale only: completed_with_errors + failures", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello" }, fr: { [KEY]: "Salut" } });
    shopify.registerStores = (v) => (v.translations[0].locale === "en" ? null : []);
    const { ctx, db, taskUpdates } = makeCtx({
      formEntries: { ...form, targetLocales: JSON.stringify(["en", "fr"]) },
    });
    const r = await handleTranslateAll(ctx, "translateAll");
    expect(body(r).success).toBe(true);
    expect(body(r).failures).toHaveLength(1);
    expect(body(r).translations.fr).toEqual({});
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(taskUpdates.at(-1).status).toBe("completed_with_errors");
    expect(markSaved).toHaveBeenCalledWith(RES);
  });
});

describe("handleUpdateContent - foreign locale", () => {
  const base = { locale: "en", primaryLocale: "de" };

  it("mirrors an echoed register", async () => {
    const { ctx, db } = makeCtx({ formEntries: { ...base, [KEY]: "Hello", changedFields: JSON.stringify([KEY]) } });
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(markSaved).toHaveBeenCalledWith(RES);
  });

  it("does not mirror a key Shopify did not echo and reports failure", async () => {
    shopify.registerStores = () => [];
    const { ctx, db } = makeCtx({ formEntries: { ...base, [KEY]: "Hello", changedFields: JSON.stringify([KEY]) } });
    await expect(handleUpdateContent(ctx)).rejects.toThrow(/did not store/);
    expect(db.themeTranslation.upsert).not.toHaveBeenCalled();
  });

  it("deletes the local row of an echoed clear", async () => {
    const { ctx, db } = makeCtx({ formEntries: { ...base, [KEY]: "", changedFields: JSON.stringify([KEY]) } });
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(db.themeTranslation.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("an unechoed clear of a DB-only row is confirmed by the re-read and the row is deleted", async () => {
    shopify.removeEchoes = false;
    shopify.present = { en: [] };
    const { ctx, db } = makeCtx({ formEntries: { ...base, [KEY]: "", changedFields: JSON.stringify([KEY]) } });
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(shopify.rereads).toBe(1);
    expect(db.themeTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(markSaved).not.toHaveBeenCalled();
  });

  it("an unechoed clear that Shopify still serves keeps the row and fails", async () => {
    shopify.removeEchoes = false;
    shopify.present = { en: [KEY] };
    const { ctx, db } = makeCtx({ formEntries: { ...base, [KEY]: "", changedFields: JSON.stringify([KEY]) } });
    await expect(handleUpdateContent(ctx)).rejects.toThrow(/did not remove/);
    expect(db.themeTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("matches the register echo case-insensitively on the locale", async () => {
    shopify.registerStores = () => [{ key: KEY, locale: "EN", value: "Hello" }];
    const { ctx, db } = makeCtx({ formEntries: { ...base, [KEY]: "Hello", changedFields: JSON.stringify([KEY]) } });
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("handleUpdateContent - primary change purge", () => {
  const form = { locale: "de", primaryLocale: "de", [KEY]: "Neu", changedFields: JSON.stringify([KEY]) };

  it("removes on Shopify and deletes the local rows", async () => {
    const { ctx, db } = makeCtx({ formEntries: form });
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(shopify.removes).toHaveLength(1);
    expect([...shopify.removes[0].locales].sort()).toEqual(["en", "fr"]);
    expect(db.themeTranslation.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("deletes ONLY confirmed (resource, key, locale) rows", async () => {
    const { ctx, db } = makeCtx({ formEntries: form });
    await handleUpdateContent(ctx);
    const where = db.themeTranslation.deleteMany.mock.calls[0][0].where;
    expect(where.marketId).toBe("");
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { resourceId: RES, key: KEY, locale: "en" },
        { resourceId: RES, key: KEY, locale: "fr" },
      ]),
    );
  });

  it("keeps rows Shopify still serves (unconfirmed) and warns, without failing the write", async () => {
    shopify.removeEchoes = false;
    shopify.present = { en: [KEY], fr: [KEY] };
    const rows = [
      { resourceId: RES, key: KEY, locale: "en" },
      { resourceId: RES, key: KEY, locale: "fr" },
    ];
    const { ctx, db } = makeCtx({ formEntries: form, rows });
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(body(r).warnings).toEqual(["translationPurgeUnconfirmed"]);
    expect(db.themeTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("clears a DB-only row through the re-read, but keeps the one Shopify still serves", async () => {
    shopify.removeEchoes = false;
    shopify.present = { en: [], fr: [KEY] };
    const rows = [
      { resourceId: RES, key: KEY, locale: "en" },
      { resourceId: RES, key: KEY, locale: "fr" },
    ];
    const { ctx, db } = makeCtx({ formEntries: form, rows });
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(db.themeTranslation.deleteMany.mock.calls[0][0].where.OR).toEqual([
      { resourceId: RES, key: KEY, locale: "en" },
    ]);
    expect(body(r).unconfirmedPurge).toEqual([RES]);
  });

  it("a throwing removal never fails the primary write and deletes nothing", async () => {
    const { ctx, db, admin } = makeCtx({ formEntries: form });
    const orig = admin.graphql.getMockImplementation()!;
    admin.graphql.mockImplementation(async (q: string, o?: any) => {
      if (q.includes("translationsRemove")) throw new Error("boom");
      return orig(q, o);
    });
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(db.themeTranslation.deleteMany).not.toHaveBeenCalled();
  });
});
