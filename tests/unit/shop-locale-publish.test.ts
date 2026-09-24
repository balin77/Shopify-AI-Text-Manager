/**
 * Settings → Shop-Sprachen: the one writer of a locale's `published` switch.
 * A change counts only when Shopify ECHOES it; the primary locale and unknown
 * locales are refused before anything is sent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const clearShopLocalesCache = vi.fn();
vi.mock("~/utils/shop-locales-cache.server", () => ({ clearShopLocalesCache }));

const { planLocalePublication, setShopLocalesPublished, planLocaleChanges, applyLocaleChanges, loadAvailableLocales } = await import(
  "~/services/shop-locale-publish.server"
);

const current = [
  { locale: "de", primary: true, published: true },
  { locale: "en", primary: false, published: true },
  { locale: "fr", primary: false, published: false },
];

function adminAnswering(bodies: Record<string, unknown>) {
  return {
    graphql: vi.fn(async (_q: string, opts?: { variables?: Record<string, unknown> }) => {
      const locale = String(opts?.variables?.locale);
      return { json: async () => bodies[locale] } as unknown as Response;
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("planLocalePublication", () => {
  it("keeps real changes, drops no-ops and refuses the primary and unknown locales", () => {
    const plan = planLocalePublication(current, [
      { locale: "fr", published: true },
      { locale: "en", published: true },
      { locale: "de", published: false },
      { locale: "xx", published: true },
    ]);
    expect(plan.changes).toEqual([{ locale: "fr", published: true }]);
    expect(plan.refused).toEqual([
      { locale: "de", error: "primaryLocale" },
      { locale: "xx", error: "unknownLocale" },
    ]);
  });
});

describe("setShopLocalesPublished", () => {
  it("confirms a change only on Shopify's echo, and clears the locale cache", async () => {
    const admin = adminAnswering({
      fr: { data: { shopLocaleUpdate: { shopLocale: { locale: "fr", published: true }, userErrors: [] } } },
    });
    const result = await setShopLocalesPublished(admin, "s.myshopify.com", [{ locale: "fr", published: true }]);
    expect(result).toEqual({ confirmed: [{ locale: "fr", published: true }], failed: [] });
    expect(admin.graphql.mock.calls[0][1]).toEqual({ variables: { locale: "fr", shopLocale: { published: true } } });
    expect(clearShopLocalesCache).toHaveBeenCalledWith("s.myshopify.com");
  });

  it("an empty userErrors WITHOUT the echoed state is not a success", async () => {
    const admin = adminAnswering({ fr: { data: { shopLocaleUpdate: { shopLocale: null, userErrors: [] } } } });
    const result = await setShopLocalesPublished(admin, "s", [{ locale: "fr", published: true }]);
    expect(result.confirmed).toEqual([]);
    expect(result.failed).toEqual([{ locale: "fr", error: "notConfirmed" }]);
    expect(clearShopLocalesCache).not.toHaveBeenCalled();
  });

  it("reports a schema-level refusal (e.g. the missing scope) in Shopify's words", async () => {
    const admin = adminAnswering({ en: { errors: [{ message: "Access denied for shopLocaleUpdate field." }] } });
    const result = await setShopLocalesPublished(admin, "s", [{ locale: "en", published: false }]);
    expect(result.failed).toEqual([{ locale: "en", error: "Access denied for shopLocaleUpdate field." }]);
  });

  it("reports userErrors per locale and still applies the others", async () => {
    const admin = adminAnswering({
      en: { data: { shopLocaleUpdate: { shopLocale: null, userErrors: [{ message: "nope" }] } } },
      fr: { data: { shopLocaleUpdate: { shopLocale: { locale: "fr", published: true }, userErrors: [] } } },
    });
    const result = await setShopLocalesPublished(admin, "s", [
      { locale: "en", published: false },
      { locale: "fr", published: true },
    ]);
    expect(result.failed).toEqual([{ locale: "en", error: "nope" }]);
    expect(result.confirmed).toEqual([{ locale: "fr", published: true }]);
  });
});

describe("planLocaleChanges — adding and removing", () => {
  const available = [
    { isoCode: "it", name: "Italian" },
    { isoCode: "fr", name: "French" },
  ];

  it("adds only what Shopify offers and the shop lacks; removes only known foreign locales", () => {
    const plan = planLocaleChanges(current, available, {
      publish: [],
      add: [
        { locale: "it", published: true },
        { locale: "fr", published: false },
        { locale: "xx", published: false },
      ],
      remove: ["de", "zz"],
    });
    expect(plan.add).toEqual([{ locale: "it", published: true }]);
    expect(plan.remove).toEqual([]);
    expect(plan.refused).toEqual(
      expect.arrayContaining([
        { locale: "fr", error: "alreadyEnabled" },
        { locale: "xx", error: "notAvailable" },
        { locale: "de", error: "primaryLocale" },
        { locale: "zz", error: "unknownLocale" },
      ]),
    );
  });

  it("an unreadable list of available languages refuses additions rather than guessing", () => {
    const plan = planLocaleChanges(current, null, { publish: [], add: [{ locale: "it", published: false }], remove: [] });
    expect(plan.add).toEqual([]);
    expect(plan.refused).toEqual([{ locale: "it", error: "availableLookupFailed" }]);
  });

  it("a locale being removed carries no publication change", () => {
    const plan = planLocaleChanges(current, available, {
      publish: [{ locale: "fr", published: true }],
      add: [],
      remove: ["fr"],
    });
    expect(plan.remove).toEqual(["fr"]);
    expect(plan.publish).toEqual([]);
  });
});

describe("applyLocaleChanges", () => {
  function db() {
    return {
      contentTranslation: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      themeTranslation: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      metaobjectTranslation: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      productImageAltTranslation: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    };
  }

  it("enables an added locale on its echo and publishes it when the draft asked for it", async () => {
    const admin = {
      graphql: vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
        const body = query.includes("shopLocaleEnable")
          ? { data: { shopLocaleEnable: { shopLocale: { locale: "it", published: false }, userErrors: [] } } }
          : { data: { shopLocaleUpdate: { shopLocale: { locale: opts?.variables?.locale, published: true }, userErrors: [] } } };
        return { json: async () => body } as unknown as Response;
      }),
    };
    const result = await applyLocaleChanges(admin, db() as never, "s", {
      add: [{ locale: "it", published: true }],
      remove: [],
      publish: [],
    });
    expect(result.added).toEqual(["it"]);
    expect(result.confirmed).toEqual([{ locale: "it", published: true }]);
    expect(result.failed).toEqual([]);
  });

  it("purges the local mirrors of a locale only after Shopify CONFIRMED its removal", async () => {
    const d = db();
    const admin = {
      graphql: vi.fn(async () =>
        ({ json: async () => ({ data: { shopLocaleDisable: { locale: "fr", userErrors: [] } } }) }) as unknown as Response,
      ),
    };
    const result = await applyLocaleChanges(admin, d as never, "s", { add: [], remove: ["fr"], publish: [] });
    expect(result.removed).toEqual(["fr"]);
    expect(d.contentTranslation.deleteMany).toHaveBeenCalledWith({ where: { shop: "s", locale: { in: ["fr"] } } });
    expect(d.productImageAltTranslation.deleteMany).toHaveBeenCalledWith({
      where: { locale: { in: ["fr"] }, image: { product: { shop: "s" } } },
    });
  });

  it("an unconfirmed removal deletes nothing locally", async () => {
    const d = db();
    const admin = {
      graphql: vi.fn(async () =>
        ({ json: async () => ({ data: { shopLocaleDisable: { locale: null, userErrors: [] } } }) }) as unknown as Response,
      ),
    };
    const result = await applyLocaleChanges(admin, d as never, "s", { add: [], remove: ["fr"], publish: [] });
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([{ locale: "fr", error: "notConfirmed" }]);
    expect(d.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("loadAvailableLocales answers null on a failed read, never an empty list", async () => {
    const admin = { graphql: vi.fn(async () => ({ json: async () => ({ errors: [{ message: "x" }] }) }) as unknown as Response) };
    expect(await loadAvailableLocales(admin)).toBeNull();
  });
});
