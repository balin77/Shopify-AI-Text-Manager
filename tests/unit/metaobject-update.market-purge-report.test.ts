/**
 * Metaobjects: a PRIMARY save reports the editor field keys (`<GID>#<field key>`)
 * whose MARKET overrides its purge confirmed removed (`marketPurgedFields`), so
 * the page hides market values only for them. A key whose removal was not
 * confirmed, a purge that is off and a purge that threw report nothing.
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

vi.mock("~/utils/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  loggers: { translation: vi.fn(), seo: vi.fn() },
}));
vi.mock("~/utils/translation-save-lock.server", () => ({
  markTranslationSaved: vi.fn(),
  isTranslationRecentlySaved: vi.fn().mockReturnValue(false),
}));
vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: vi.fn(async () => policy),
}));
vi.mock("~/services/shopify-api-gateway.service", () => ({
  ShopifyApiGateway: class {
    constructor(public admin: any, public shop: string) {}
    graphql(query: string, options?: any) {
      return this.admin.graphql(query, options);
    }
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
  metaobjectTranslationMirror: vi.fn(() => ({})),
  reconcileAfterPrimarySave: vi.fn(async () => reconcile.result),
}));
vi.mock("~/services/translations/verified-translations.server", () => ({
  LOCALE_KEY_SEP: "\u0000",
  removeAndVerifyAcrossLocales: vi.fn(async () => ({ confirmedPairs: new Set<string>(), userErrors: [] })),
  registerAndVerify: vi.fn(),
  removeAndVerify: vi.fn(),
  fetchDigestsForResource: vi.fn(),
}));
vi.mock("~/services/metaobject-write.server", () => ({
  writeMetaobjectFields: vi.fn(async (args: any) => ({
    cachedType: "t",
    confirmedRefs: args.writes.map((w: any) => w.ref),
    confirmedKeys: args.writes.map((w: any) => w.key),
    failures: [],
  })),
}));
vi.mock("../../app/graphql/content.queries", () => ({
  GET_SHOP_LOCALES: "query shopLocales { shopLocales { locale primary published } }",
}));

import { handleMetaobjectUpdate } from "../../app/actions/content/metaobject-update.action";

const A = "gid://shopify/Metaobject/1";
const B = "gid://shopify/Metaobject/2";

function makeCtx() {
  const admin = {
    graphql: vi.fn(async () => ({
      json: async () => ({
        data: {
          shopLocales: [
            { locale: "de", primary: true, published: true },
            { locale: "fr", primary: false, published: true },
          ],
        },
      }),
    })),
  };
  const row = (id: string) => ({
    id,
    type: "t",
    fields: [
      { key: "title", value: "alt", type: "single_line_text_field" },
      { key: "label", value: "alt", type: "single_line_text_field" },
    ],
  });
  const db = {
    metaobject: { findMany: vi.fn(async () => [row(A), row(B)]) },
    metaobjectDefinition: { findMany: vi.fn(async () => []) },
    metaobjectTranslation: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) },
  };
  return { admin, db, session: { shop: "s.myshopify.com" } } as never;
}

async function save(fields: string[]) {
  const form = new FormData();
  const keys: string[] = [];
  for (const f of fields) {
    form.set(f, "neu");
    keys.push(f);
  }
  form.set("changedFields", JSON.stringify(keys));
  const result = (await handleMetaobjectUpdate(makeCtx(), form, {
    locale: "de",
    primaryLocale: "de",
    marketId: "",
  })) as any;
  return result?.data ?? result;
}

beforeEach(() => {
  policy.purgeOnPrimaryChange = true;
  policy.purgeUnreconciledSurfaces = true;
  policy.autoTranslateExternalChanges = false;
  market.failedKeys = [];
  market.throws = false;
  market.calls = [];
  reconcile.result = { removed: 0, retranslating: 0 };
});

describe("metaobject primary save reports its confirmed market purge", () => {
  it("names the compound field key of every entry whose purge confirmed", async () => {
    const body = await save([`${A}#title`, `${B}#title`]);
    expect(body.success).toBe(true);
    expect([...body.marketPurgedFields].sort()).toEqual([`${A}#title`, `${B}#title`].sort());
  });

  it("leaves out a field key whose market removal was not confirmed", async () => {
    market.failedKeys = ["title"];
    const body = await save([`${A}#title`, `${A}#label`]);
    expect(body.marketPurgedFields).toEqual([`${A}#label`]);
  });

  it("names nothing when the market purge threw", async () => {
    market.throws = true;
    const body = await save([`${A}#title`]);
    expect(body.success).toBe(true);
    expect(body.marketPurgedFields).toBeUndefined();
  });

  it("names nothing with the purge switched off", async () => {
    policy.purgeUnreconciledSurfaces = false;
    const body = await save([`${A}#title`]);
    expect(market.calls).toHaveLength(0);
    expect(body.marketPurgedFields).toBeUndefined();
  });

  it("auto-translate on: names the entries whose key the repair reports purged", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.purgeOnPrimaryChange = false;
    reconcile.result = { removed: 0, retranslating: 2, marketPurgedKeys: ["title"] };
    const body = await save([`${A}#title`, `${A}#label`]);
    expect(market.calls).toHaveLength(0);
    expect(body.marketPurgedFields).toEqual([`${A}#title`]);
  });
});
