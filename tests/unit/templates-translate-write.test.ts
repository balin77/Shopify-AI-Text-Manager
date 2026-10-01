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

  it("CURRENT: an unechoed register with no userErrors is mirrored anyway", async () => {
    shopify.registerStores = () => [];
    const { ctx, db } = makeCtx({ formEntries: form });
    const r = await handleTranslateField(ctx);
    expect(body(r).success).toBe(true);
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("handleTranslateFieldToAllLocales", () => {
  const form = { fieldType: KEY, sourceText: "Hallo", targetLocales: JSON.stringify(["en", "fr"]), primaryLocale: "de" };

  it("CURRENT: unechoed locales are mirrored with no userErrors", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello" }, fr: { [KEY]: "Salut" } });
    shopify.registerStores = () => [];
    const { ctx, db } = makeCtx({ formEntries: form });
    const r = await handleTranslateFieldToAllLocales(ctx);
    expect(body(r).success).toBe(true);
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(2);
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

  it("CURRENT: unechoed key is mirrored and the task completes", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello" } });
    shopify.registerStores = () => [];
    const { ctx, db, taskUpdates } = makeCtx({ formEntries: form });
    await handleTranslateAll(ctx, "translateAll");
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(taskUpdates.at(-1).status).toBe("completed");
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

  it("CURRENT: an unechoed clear keeps the row and fails, even for a DB-only row (dead end)", async () => {
    shopify.removeEchoes = false;
    const { ctx, db } = makeCtx({ formEntries: { ...base, [KEY]: "", changedFields: JSON.stringify([KEY]) } });
    await expect(handleUpdateContent(ctx)).rejects.toThrow(/did not remove/);
    expect(db.themeTranslation.deleteMany).not.toHaveBeenCalled();
    expect(shopify.rereads).toBe(0);
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

  it("CURRENT: local rows are deleted even when the Shopify removal echoed nothing", async () => {
    shopify.removeEchoes = false;
    const { ctx, db } = makeCtx({ formEntries: form });
    await handleUpdateContent(ctx);
    expect(db.themeTranslation.deleteMany).toHaveBeenCalledTimes(1);
  });
});
