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

import { handleTranslateFieldToAllLocales } from "../../app/actions/templates/templates-translate-field.action";
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
  /** `${locale}|${marketId}` -> keys; wins over `present` when it has the entry */
  presentByMarket: {} as Record<string, string[]>,
  rereadVars: [] as any[],
  failLocales: false,
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
        shopify.rereadVars.push(v);
        const keys = shopify.presentByMarket[`${v.locale}|${v.marketId ?? ""}`] ?? shopify.present[v.locale] ?? [];
        return {
          json: async () => ({
            data: { translatableResource: { translations: keys.map((key) => ({ key, value: "x", market: null })) } },
          }),
        };
      }
      if (query.includes("shopLocales")) {
        if (shopify.failLocales) throw new Error("locales down");
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

function makeCtx(over: { formEntries?: Record<string, string>; rows?: any[]; content?: any[] } = {}) {
  const { db, taskUpdates } = makeDb(over.rows);
  const admin = makeAdmin();
  const formData = new FormData();
  for (const [k, val] of Object.entries(over.formEntries ?? {})) formData.set(k, val);
  const group = {
    groupId: "g",
    groupName: "Hero",
    resourceId: RES,
    translatableContent: over.content ?? [{ key: KEY, value: "Alt", digest: "d1" }],
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
  shopify.presentByMarket = {};
  shopify.rereadVars = [];
  shopify.failLocales = false;
  shopify.registers = [];
  shopify.removes = [];
  shopify.rereads = 0;
  markSaved.mockClear();
  translateChunked.mockReset();
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

  it("routes a CookieBanner resource through the unstable endpoint, not the stable register", async () => {
    const CB = "gid://shopify/CookieBanner/1";
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello" } });
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      json: async () => ({ data: { translationsRegister: { userErrors: [], translations: [{ key: KEY, locale: "en" }] } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { ctx, db } = makeCtx({ formEntries: form });
      (ctx as any).session = { shop: "s.myshopify.com", accessToken: "tok" };
      (ctx as any).keyToResourceId = new Map([[KEY, CB]]);
      (ctx as any).themeGroups[0].resourceId = CB;
      (ctx as any).resourceId = CB;
      const r = await handleTranslateAll(ctx, "translateAll");
      expect(body(r).success).toBe(true);
      expect(body(r).rejectedFields).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("/admin/api/unstable/");
      expect(shopify.registers).toEqual([]);
      expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
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

describe("handleTranslateAll - digest-less keys and client report shape", () => {
  const KEY2 = "section.index.json.hero.sub";
  const form = { targetLocales: JSON.stringify(["en"]), targetLocale: "en", primaryLocale: "de" };
  const content = [
    { key: KEY, value: "Alt", digest: "d1" },
    { key: KEY2, value: "Sub" },
  ];

  it("a digest-less key is neither returned as a translation nor mirrored, and is reported", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello", [KEY2]: "Sub-en" } });
    const { ctx, db, taskUpdates } = makeCtx({ formEntries: form, content });
    const r = await handleTranslateAll(ctx, "translateAll");
    expect(body(r).success).toBe(true);
    expect(body(r).translations.en).toEqual({ [KEY]: "Hello" });
    expect(body(r).rejectedFields).toEqual({ en: [KEY2] });
    expect(body(r).failedLocales).toBeUndefined();
    expect(db.themeTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(taskUpdates.at(-1).status).toBe("completed_with_errors");
    expect(taskUpdates.at(-1).error).toContain("digest");
  });

  it("unconfirmed keys are reported per locale and a wholly unconfirmed locale is failedLocales", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello" }, fr: { [KEY]: "Salut" } });
    shopify.registerStores = (v) => (v.translations[0].locale === "en" ? null : []);
    const { ctx } = makeCtx({ formEntries: { ...form, targetLocales: JSON.stringify(["en", "fr"]) } });
    const r = await handleTranslateAll(ctx, "translateAll");
    expect(body(r).rejectedFields).toEqual({ fr: [KEY] });
    expect(body(r).failedLocales).toEqual(["fr"]);
  });

  it("every key digest-less: fails with a real reason, not an empty one", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY2]: "Sub-en" } });
    const { ctx, db, taskUpdates } = makeCtx({ formEntries: form, content: [{ key: KEY2, value: "Sub" }] });
    const r = await handleTranslateAll(ctx, "translateAll");
    expect(status(r)).toBe(500);
    expect(body(r).error).not.toMatch(/all translations: $/);
    expect(body(r).error).toContain("digest");
    expect(db.themeTranslation.upsert).not.toHaveBeenCalled();
    expect(taskUpdates.at(-1).status).toBe("failed");
  });

  it("translateAllForLocale reports digest-less keys the same way", async () => {
    translateChunked.mockResolvedValue({ en: { [KEY]: "Hello", [KEY2]: "Sub-en" } });
    const { ctx } = makeCtx({ formEntries: form, content });
    const r = await handleTranslateAll(ctx, "translateAllForLocale");
    expect(body(r).translations).toEqual({ [KEY]: "Hello" });
    expect(body(r).targetLocale).toBe("en");
    expect(body(r).rejectedFields).toEqual({ en: [KEY2] });
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

  it("echoed clear deletes scoped by resourceId, locale and marketId", async () => {
    const { ctx, db } = makeCtx({ formEntries: { ...base, [KEY]: "", changedFields: JSON.stringify([KEY]) } });
    await handleUpdateContent(ctx);
    const where = db.themeTranslation.deleteMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ groupId: "g", locale: "en", domain: "theme", marketId: "" });
    expect(where.OR).toEqual([{ resourceId: RES, key: KEY }]);
  });

  it("a market-scoped unechoed clear re-reads THAT market and deletes only that market's row", async () => {
    const MARKET = "gid://shopify/Market/5";
    shopify.removeEchoes = false;
    // the global layer still carries the key; only the market layer is empty
    shopify.present = { en: [KEY] };
    shopify.presentByMarket = { [`en|${MARKET}`]: [] };
    const { ctx, db } = makeCtx({
      formEntries: { ...base, marketId: MARKET, [KEY]: "", changedFields: JSON.stringify([KEY]) },
    });
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(shopify.rereadVars.map((v) => v.marketId)).toEqual([MARKET]);
    expect(db.themeTranslation.deleteMany.mock.calls[0][0].where.marketId).toBe(MARKET);
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

  it("an unknown shop-locale list keeps every row and warns", async () => {
    shopify.failLocales = true;
    const { ctx, db } = makeCtx({ formEntries: form });
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(shopify.removes).toHaveLength(0);
    expect(db.themeTranslation.deleteMany).not.toHaveBeenCalled();
    expect(body(r).warnings).toEqual(["translationPurgeUnconfirmed"]);
    expect(body(r).unconfirmedPurge).toEqual(["locales"]);
    expect(body(r).unconfirmedPurgeKeys).toEqual([KEY]);
  });

  it("zero foreign locales: local delete is scoped by the changed resource ids", async () => {
    const { ctx, db, admin } = makeCtx({ formEntries: form });
    const orig = admin.graphql.getMockImplementation()!;
    admin.graphql.mockImplementation(async (q: string, o?: any) => {
      if (q.includes("shopLocales")) {
        return { json: async () => ({ data: { shopLocales: [{ locale: "de", primary: true, published: true }] } }) };
      }
      return orig(q, o);
    });
    await handleUpdateContent(ctx);
    expect(shopify.removes).toHaveLength(0);
    const where = db.themeTranslation.deleteMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ groupId: "g", domain: "theme", marketId: "", resourceId: { in: [RES] } });
  });

  it("a failed local-row read re-reads every gap (unknown rows are not 'no rows')", async () => {
    shopify.removeEchoes = false;
    shopify.present = { en: [], fr: [] };
    const { ctx, db } = makeCtx({ formEntries: form });
    db.themeTranslation.findMany.mockRejectedValue(new Error("db down"));
    const r = await handleUpdateContent(ctx);
    expect(body(r).success).toBe(true);
    expect(shopify.rereads).toBe(2);
    expect(db.themeTranslation.deleteMany.mock.calls[0][0].where.OR).toEqual(
      expect.arrayContaining([
        { resourceId: RES, key: KEY, locale: "en" },
        { resourceId: RES, key: KEY, locale: "fr" },
      ]),
    );
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
    expect(body(r).warnings).toEqual(["translationPurgeUnconfirmed"]);
    expect(body(r).unconfirmedPurge).toEqual([RES]);
    expect(body(r).unconfirmedPurgeKeys).toEqual([KEY]);
  });
});
