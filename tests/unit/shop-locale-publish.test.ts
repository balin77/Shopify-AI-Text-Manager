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

const {
  planLocalePublication,
  setShopLocalesPublished,
  planLocaleChanges,
  applyLocaleChanges,
  loadAvailableLocales,
  loadMarketWebPresences,
  planMarketAssignments,
  setLocaleMarkets,
} = await import(
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
      autoTranslateRetry: {
        findMany: vi.fn(async () => [
          { id: "r1", pairs: [{ key: "title", locale: "fr" }] },
          { id: "r2", pairs: [{ key: "title", locale: "fr" }, { key: "title", locale: "en" }] },
          { id: "r3", pairs: [{ key: "title", locale: "en" }] },
        ]),
        delete: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
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
    // Retry rows owed only to the removed language go; mixed rows keep the rest.
    expect(d.autoTranslateRetry.delete).toHaveBeenCalledWith({ where: { id: "r1" } });
    expect(d.autoTranslateRetry.update).toHaveBeenCalledWith({
      where: { id: "r2" },
      data: { pairs: [{ key: "title", locale: "en" }] },
    });
    expect(d.autoTranslateRetry.update).toHaveBeenCalledTimes(1);
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

describe("market web presences — which markets show a language", () => {
  const marketsBody = (nlOn: string[] = []) => ({
    data: {
      markets: {
        edges: [
          {
            node: {
              name: "Schweiz",
              status: "ACTIVE",
              webPresences: {
                edges: [
                  {
                    node: {
                      id: "wp1",
                      defaultLocale: { locale: "de" },
                      alternateLocales: [{ locale: "en" }, ...(nlOn.includes("wp1") ? [{ locale: "nl" }] : [])],
                    },
                  },
                ],
              },
            },
          },
          // Shares the primary presence: one checkbox, two names.
          {
            node: {
              name: "Liechtenstein",
              status: "ACTIVE",
              webPresences: { edges: [{ node: { id: "wp1", defaultLocale: { locale: "de" }, alternateLocales: [] } }] },
            },
          },
          {
            node: {
              name: "Frankreich",
              status: "ACTIVE",
              webPresences: {
                edges: [
                  {
                    node: {
                      id: "wp2",
                      defaultLocale: { locale: "fr" },
                      alternateLocales: nlOn.includes("wp2") ? [{ locale: "nl" }] : [],
                    },
                  },
                ],
              },
            },
          },
          {
            node: {
              name: "Entwurf",
              status: "DRAFT",
              webPresences: {
                edges: [{ node: { id: "wp3", defaultLocale: { locale: "de" }, alternateLocales: [{ locale: "en" }] } }],
              },
            },
          },
        ],
      },
    },
  });
  const reading = (body: unknown) => ({
    graphql: vi.fn(async () => ({ json: async () => body }) as unknown as Response),
  });

  it("groups a SHARED presence under every active market and marks inactive ones", async () => {
    const presences = await loadMarketWebPresences(reading(marketsBody()));
    expect(presences).toEqual([
      { id: "wp1", marketNames: ["Schweiz", "Liechtenstein"], active: true, defaultLocale: "de", locales: ["de", "en"] },
      { id: "wp2", marketNames: ["Frankreich"], active: true, defaultLocale: "fr", locales: ["fr"] },
      { id: "wp3", marketNames: [], active: false, defaultLocale: "de", locales: ["de", "en"] },
    ]);
  });

  it("a failed read is null, never 'in no market'", async () => {
    expect(await loadMarketWebPresences(reading({ errors: [{ message: "Access denied" }] }))).toBeNull();
  });

  const shop = [
    { locale: "de", primary: true },
    { locale: "en", primary: false },
    { locale: "fr", primary: false },
  ];

  it("keeps a presence's DEFAULT language and an inactive market's presence in the set it sends", async () => {
    const presences = (await loadMarketWebPresences(reading(marketsBody())))!;
    const plan = planMarketAssignments(shop, presences, [
      { locale: "en", webPresenceIds: [] },
      { locale: "fr", webPresenceIds: ["wp1"] },
    ]);
    expect(plan.changes).toEqual([
      // en off the active presence, but the draft market's copy stays.
      { locale: "en", webPresenceIds: ["wp3"] },
      // fr is wp2's default — ticked or not, it stays.
      { locale: "fr", webPresenceIds: ["wp1", "wp2"] },
    ]);
  });

  it("refuses unknown ids, the primary and unknown locales; drops a no-op; accepts a locale being added", async () => {
    const presences = (await loadMarketWebPresences(reading(marketsBody())))!;
    const plan = planMarketAssignments(
      shop,
      presences,
      [
        { locale: "en", webPresenceIds: ["wp1"] },
        { locale: "fr", webPresenceIds: ["nope"] },
        { locale: "de", webPresenceIds: ["wp2"] },
        { locale: "xx", webPresenceIds: ["wp1"] },
        { locale: "nl", webPresenceIds: ["wp2"] },
        { locale: "en", webPresenceIds: ["wp3"] },
      ],
      { adding: ["nl"] },
    );
    expect(plan.changes).toEqual([{ locale: "nl", webPresenceIds: ["wp2"] }]);
    expect(plan.refused).toEqual([
      { locale: "fr", error: "unknownMarket" },
      { locale: "de", error: "primaryLocale" },
      { locale: "xx", error: "unknownLocale" },
    ]);
  });

  it("an unreadable market list refuses every assignment", () => {
    expect(planMarketAssignments(shop, null, [{ locale: "en", webPresenceIds: [] }]).refused).toEqual([
      { locale: "en", error: "marketsUnreadable" },
    ]);
  });

  function writingThenReading(after: unknown, mutation: unknown = null) {
    return {
      graphql: vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
        const body = query.includes("shopLocaleUpdate")
          ? mutation ?? { data: { shopLocaleUpdate: { shopLocale: { locale: opts?.variables?.locale }, userErrors: [] } } }
          : after;
        return { json: async () => body } as unknown as Response;
      }),
    };
  }

  it("confirms only what a RE-READ shows, never the echo", async () => {
    const admin = writingThenReading(marketsBody(["wp2"]));
    const result = await setLocaleMarkets(admin, [{ locale: "nl", webPresenceIds: ["wp2"] }]);
    expect(result).toEqual({ confirmed: [{ locale: "nl", webPresenceIds: ["wp2"] }], failed: [] });
    expect(admin.graphql.mock.calls[0][1]).toEqual({
      variables: { locale: "nl", shopLocale: { marketWebPresenceIds: ["wp2"] } },
    });
  });

  it("an echoed write the re-read does not show is notConfirmed (e.g. add-only semantics)", async () => {
    const result = await setLocaleMarkets(writingThenReading(marketsBody(["wp1", "wp2"])), [
      { locale: "nl", webPresenceIds: ["wp2"] },
    ]);
    expect(result.failed).toEqual([{ locale: "nl", error: "notConfirmed" }]);
  });

  it("a failed re-read is 'unverified', and a schema refusal is reported in Shopify's words", async () => {
    expect(
      (await setLocaleMarkets(writingThenReading({ errors: [{}] }), [{ locale: "nl", webPresenceIds: ["wp2"] }]))
        .failed,
    ).toEqual([{ locale: "nl", error: "marketsUnverified" }]);
    const refused = await setLocaleMarkets(
      writingThenReading(marketsBody(), { errors: [{ message: "Field 'marketWebPresenceIds' is not defined" }] }),
      [{ locale: "nl", webPresenceIds: ["wp2"] }],
    );
    expect(refused.failed).toEqual([{ locale: "nl", error: "Field 'marketWebPresenceIds' is not defined" }]);
  });

  it("applyLocaleChanges does not assign markets to a language whose addition failed", async () => {
    const admin = {
      graphql: vi.fn(async (query: string) => {
        const body = query.includes("shopLocaleEnable")
          ? { data: { shopLocaleEnable: { shopLocale: null, userErrors: [{ message: "nope" }] } } }
          : { data: {} };
        return { json: async () => body } as unknown as Response;
      }),
    };
    const result = await applyLocaleChanges(admin, {} as never, "s", {
      add: [{ locale: "nl", published: true }],
      remove: [],
      publish: [],
      markets: [{ locale: "nl", webPresenceIds: ["wp2"] }],
    });
    expect(result.failed).toEqual([{ locale: "nl", error: "nope" }]);
    expect(admin.graphql.mock.calls.some(([q]) => String(q).includes("appShopLocaleMarkets"))).toBe(false);
  });
});
