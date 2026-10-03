/**
 * Theme content: a PRIMARY save reports the keys whose MARKET overrides the
 * purge confirmed removed (`marketPurgedKeys`) so the theme page can drop
 * exactly those market rows from its own cache. Confirmed keys only; a purge
 * that is off, failed or unconfirmed reports nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { policy, market, reconcile } = vi.hoisted(() => ({
  policy: {
    purgeOnPrimaryChange: true,
    purgeUnreconciledSurfaces: true,
    autoTranslateExternalChanges: false,
    autoTranslateHandles: false,
  },
  market: { failedKeys: [] as string[], throws: false, calls: [] as any[] },
  reconcile: { result: { removed: 0, retranslating: 0 } as any },
}));

vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: vi.fn(async () => policy),
  isPurgeOnPrimaryChangeEnabled: vi.fn(async () => policy.purgeUnreconciledSurfaces),
}));
vi.mock("~/services/theme-selection.server", () => ({
  resolveSelectedThemeId: vi.fn(async () => "gid://shopify/OnlineStoreTheme/1"),
}));
vi.mock("~/services/shopify-api-gateway.service", () => ({
  ShopifyApiGateway: class {
    constructor(public admin: unknown, public shop: string) {}
  },
}));
vi.mock("~/services/translations/market-layer-purge.server", () => ({
  purgeMarketOverrides: vi.fn(async (args: any) => {
    market.calls.push(args);
    if (market.throws) throw new Error("boom");
    for (const key of market.failedKeys) args.outcome?.failedKeys.add(key);
    return 0;
  }),
}));
vi.mock("~/services/translations/stale-translation-sync.server", () => ({
  themeTranslationMirror: vi.fn(() => ({})),
  reconcileAfterPrimarySave: vi.fn(async () => reconcile.result),
}));

import { handleUpdateContent } from "../../app/actions/templates/templates-update.action";

const KEY = "templates.404.title";
const RESOURCE = "gid://shopify/OnlineStoreThemeLocaleContent/1";

function makeCtx() {
  const admin = {
    graphql: vi.fn(async (query: string, opts?: { variables?: any }) => {
      if (query.includes("themeFilesUpsert")) {
        return {
          json: async () => ({
            data: {
              themeFilesUpsert: {
                upsertedThemeFiles: (opts?.variables?.files ?? []).map((f: any) => ({ filename: f.filename })),
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("files(")) {
        return {
          json: async () => ({
            data: {
              theme: {
                files: {
                  nodes: [
                    {
                      filename: "locales/de.default.json",
                      body: { content: JSON.stringify({ templates: { "404": { title: "Seite nicht gefunden" } } }) },
                    },
                  ],
                },
              },
            },
          }),
        };
      }
      if (query.includes("shopLocales")) {
        return {
          json: async () => ({
            data: {
              shopLocales: [
                { locale: "de", primary: true, published: true },
                { locale: "fr", primary: false, published: true },
              ],
            },
          }),
        };
      }
      // translationsRemove and the re-read: nothing echoed, nothing held.
      return {
        json: async () => ({
          data: {
            translationsRemove: { userErrors: [], translations: [] },
            translatableResource: { translations: [] },
          },
        }),
      };
    }),
  };
  const db = {
    aISettings: { findUnique: vi.fn(async () => null) },
    themeContent: { updateMany: vi.fn(async () => ({ count: 1 })) },
    themeTranslation: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
  };
  const formData = new FormData();
  formData.set("locale", "de");
  formData.set("primaryLocale", "de");
  formData.set(KEY, "Diese Seite gibt es nicht");
  formData.set("changedFields", JSON.stringify([KEY]));
  const group = {
    groupId: "g",
    resourceId: RESOURCE,
    translatableContent: [{ key: KEY, value: "Seite nicht gefunden", digest: "d" }],
  };
  return {
    admin,
    db,
    session: { shop: "s.myshopify.com" },
    formData,
    domain: "theme",
    groupId: "g",
    themeGroups: [group],
    firstGroup: group,
    resourceId: RESOURCE,
    keyToResourceId: new Map([[KEY, RESOURCE]]),
    keyToResourceType: new Map([[KEY, "ONLINE_STORE_THEME_LOCALE_CONTENT"]]),
    selectedThemeId: "gid://shopify/OnlineStoreTheme/1",
  } as never;
}

const save = async () => {
  const result = (await handleUpdateContent(makeCtx())) as any;
  return result?.data ?? result;
};

beforeEach(() => {
  policy.purgeOnPrimaryChange = true;
  policy.purgeUnreconciledSurfaces = true;
  policy.autoTranslateExternalChanges = false;
  market.failedKeys = [];
  market.throws = false;
  market.calls = [];
  reconcile.result = { removed: 0, retranslating: 0 };
});

describe("theme primary save reports its confirmed market purge", () => {
  it("names the key when the market purge confirmed", async () => {
    const body = await save();
    expect(body.success).toBe(true);
    expect(market.calls).toHaveLength(1);
    expect(body.marketPurgedKeys).toEqual([KEY]);
  });

  it("names nothing for a key whose market removal was not confirmed", async () => {
    market.failedKeys = [KEY];
    const body = await save();
    expect(body.marketPurgedKeys).toBeUndefined();
  });

  it("names nothing when the market purge threw", async () => {
    market.throws = true;
    const body = await save();
    expect(body.success).toBe(true);
    expect(body.marketPurgedKeys).toBeUndefined();
  });

  it("names nothing with the purge switched off (and the purge never runs)", async () => {
    policy.purgeUnreconciledSurfaces = false;
    policy.purgeOnPrimaryChange = false;
    const body = await save();
    expect(market.calls).toHaveLength(0);
    expect(body.marketPurgedKeys).toBeUndefined();
  });

  it("auto-translate on: takes the keys the repair reports as purged", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.purgeOnPrimaryChange = false;
    reconcile.result = { removed: 0, retranslating: 1, marketPurgedKeys: [KEY] };
    const body = await save();
    expect(market.calls).toHaveLength(0);
    expect(body.marketPurgedKeys).toEqual([KEY]);
  });
});
