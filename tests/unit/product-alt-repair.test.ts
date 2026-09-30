/**
 * The ONE implementation behind both alt-text save paths: re-translate the
 * changed alts with auto-translate on (filling locales that never held one),
 * otherwise follow the merchant's stored deletion answer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const reconcileAfterPrimarySave = vi.fn(async () => ({ removed: 0, retranslating: 2, taskId: "t1" }));
vi.mock("~/services/translations/stale-translation-sync.server", () => ({
  reconcileAfterPrimarySave,
  productImageAltMirror: vi.fn(() => ({ kind: "mirror" })),
}));
const purgeMarketOverrides = vi.fn(async () => undefined);
vi.mock("~/services/translations/market-layer-purge.server", () => ({ purgeMarketOverrides }));

const policy = { purgeOnPrimaryChange: false, purgeUnreconciledSurfaces: false, autoTranslateExternalChanges: true };
vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: vi.fn(async () => policy),
}));
vi.mock("~/services/sync-utils", () => ({
  fetchShopLocales: vi.fn(async () => [
    { locale: "de", primary: true, published: true },
    { locale: "en", primary: false, published: true },
    { locale: "fr", primary: false, published: false },
  ]),
}));
const removeAndVerifyAcrossLocales = vi.fn(async (_g: unknown, _id: string, _k: string[], locales: string[]) => ({
  confirmedPairs: new Set(locales.map((l) => `${l}\u0000alt`)),
  userErrors: [],
}));
const removeAndVerify = vi.fn(async () => ({ confirmedKeys: new Set<string>(), userErrors: [] }));
vi.mock("~/services/bulk-editor/translations.server", () => ({
  removeAndVerify,
  removeAndVerifyAcrossLocales,
  LOCALE_KEY_SEP: "\u0000",
}));

const { repairChangedProductAlts, altRepairRetranslates, repairAltsAfterWrite } = await import(
  "~/services/translations/product-alt-repair.server"
);

const base = { purgeOnPrimaryChange: false, purgeUnreconciledSurfaces: false, autoTranslateExternalChanges: false };

function deps() {
  return {
    gateway: {
      graphql: vi.fn(async () => ({
        json: async () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
      })),
    },
    db: {
      productImageAltTranslation: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => [{ locale: "en" }]),
      },
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("repairChangedProductAlts", () => {
  it("auto-translate on: one repair over every changed medium, into every foreign locale", async () => {
    const { gateway, db } = deps();
    const result = await repairChangedProductAlts({
      gateway: gateway as never,
      db: db as never,
      shop: "s",
      productId: "gid://shopify/Product/1",
      productTitle: "Box",
      changes: [
        { imageId: "a", mediaId: "gid://shopify/MediaImage/1", alt: "Eins" },
        { imageId: "b", mediaId: null },
      ],
      policy: { ...base, autoTranslateExternalChanges: true } as never,
      foreignLocales: ["en", "fr"],
      primaryLocale: "de",
    });
    expect(result).toEqual({ taskId: "t1" });
    const call = (reconcileAfterPrimarySave.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call).toMatchObject({
      resourceId: "gid://shopify/Product/1",
      foreignLocales: ["en", "fr"],
      changed: [{ resourceId: "gid://shopify/MediaImage/1", resourceType: "MediaImage", key: "alt", expectedValue: "Eins" }],
      translateAs: { kind: "values", sourceLocale: "de" },
    });
    // Nothing deleted: auto-translate supersedes the purge.
    expect(gateway.graphql).not.toHaveBeenCalled();
  });

  it("auto-translate off + deletion on: removes on Shopify and locally, global layer", async () => {
    const { gateway, db } = deps();
    await repairChangedProductAlts({
      gateway: gateway as never,
      db: db as never,
      shop: "s",
      productId: "p",
      productTitle: "Box",
      changes: [{ imageId: "a", mediaId: "gid://shopify/MediaImage/1" }],
      policy: { ...base, purgeUnreconciledSurfaces: true } as never,
      foreignLocales: ["en"],
      primaryLocale: "de",
    });
    expect(reconcileAfterPrimarySave).not.toHaveBeenCalled();
    expect(purgeMarketOverrides).toHaveBeenCalledTimes(1);
    expect(removeAndVerifyAcrossLocales).toHaveBeenCalledWith(gateway, "gid://shopify/MediaImage/1", ["alt"], ["en"], "");
    // Echo-confirmed ⇒ the local row goes.
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalledWith({
      where: { imageId: "a", marketId: "", locale: { in: ["en"] } },
    });
  });

  it("both switches off: nothing happens", async () => {
    const { gateway, db } = deps();
    await repairChangedProductAlts({
      gateway: gateway as never,
      db: db as never,
      shop: "s",
      productId: "p",
      productTitle: "Box",
      changes: [{ imageId: "a", mediaId: "gid://shopify/MediaImage/1" }],
      policy: base as never,
      foreignLocales: ["en"],
      primaryLocale: "de",
    });
    expect(reconcileAfterPrimarySave).not.toHaveBeenCalled();
    expect(gateway.graphql).not.toHaveBeenCalled();
    expect(db.productImageAltTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("an UNCONFIRMED removal keeps the local row", async () => {
    const { gateway, db } = deps();
    removeAndVerifyAcrossLocales.mockResolvedValueOnce({ confirmedPairs: new Set(), userErrors: [] });
    await repairChangedProductAlts({
      gateway: gateway as never,
      db: db as never,
      shop: "s",
      productId: "p",
      productTitle: "Box",
      changes: [{ imageId: "a", mediaId: "gid://shopify/MediaImage/1" }],
      policy: { ...base, purgeUnreconciledSurfaces: true } as never,
      foreignLocales: ["en"],
      primaryLocale: "de",
    });
    expect(removeAndVerify).toHaveBeenCalledTimes(1);
    expect(db.productImageAltTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("without a primary locale nothing can be translated FROM", () => {
    expect(altRepairRetranslates({ ...base, autoTranslateExternalChanges: true } as never, ["en"], "")).toBe(false);
  });
});

describe("repairAltsAfterWrite — the per-image paths", () => {
  const snapshot = new Map([
    ["gid://shopify/MediaImage/1", { imageId: "a", productId: "p1", altText: "alt", productTitle: "One" }],
    ["gid://shopify/MediaImage/2", { imageId: "b", productId: "p1", altText: null, productTitle: "One" }],
    ["gid://shopify/MediaImage/3", { imageId: "c", productId: "p2", altText: "same", productTitle: "Two" }],
  ]);

  it("repairs only CHANGED alts, one run per product, unpublished locales included", async () => {
    const { gateway, db } = deps();
    const ids = await repairAltsAfterWrite({
      gateway: gateway as never,
      db: db as never,
      shop: "s",
      snapshot,
      written: [
        { mediaId: "gid://shopify/MediaImage/1", alt: "neu" },
        { mediaId: "gid://shopify/MediaImage/2", alt: "auch neu" },
        { mediaId: "gid://shopify/MediaImage/3", alt: " same " },
      ],
    });
    expect(ids).toEqual(["t1"]);
    expect(reconcileAfterPrimarySave).toHaveBeenCalledTimes(1);
    const call = (reconcileAfterPrimarySave.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call).toMatchObject({ resourceId: "p1", foreignLocales: ["en", "fr"], lockId: "p1#altText" });
  });

  it("a single-image save takes a PER-MEDIUM lock — image 2 must not abort image 1's run", async () => {
    const { gateway, db } = deps();
    await repairAltsAfterWrite({
      gateway: gateway as never,
      db: db as never,
      shop: "s",
      snapshot,
      written: [{ mediaId: "gid://shopify/MediaImage/1", alt: "neu" }],
    });
    const call = (reconcileAfterPrimarySave.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call.lockId).toBe("p1#altText:gid://shopify/MediaImage/1");
  });
});
