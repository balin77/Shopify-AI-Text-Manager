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
vi.mock("~/services/translations/verified-translations.server", async (importOriginal) => ({
  // The REAL local mirror helper (it only touches the db it is handed).
  mirrorProductMediaAlt: (
    (await importOriginal()) as typeof import("~/services/translations/verified-translations.server")
  ).mirrorProductMediaAlt,
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
      // Every cache row of the shop carrying the medium (one here).
      productImage: { findMany: vi.fn(async () => [{ id: "a" }]) },
      productImageAltTranslation: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => [{ locale: "en" }]),
      },
      contentTranslation: {
        findMany: vi.fn(async () => [] as any[]),
        deleteMany: vi.fn(async () => ({ count: 0 })),
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

  it("a MANAGED stand-down keeps the local rows of an image with no mediaId too", async () => {
    // The repair stood down (nothing deleted anywhere); deleting the
    // unaddressable image's rows first made this the one surface where it did.
    reconcileAfterPrimarySave.mockResolvedValueOnce({
      removed: 0,
      retranslating: 0,
      startFailed: true,
      managedStandDown: "budgetExceeded",
    } as never);
    const run = async () => {
      const { gateway, db } = deps();
      await repairChangedProductAlts({
        gateway: gateway as never,
        db: db as never,
        shop: "s",
        productId: "gid://shopify/Product/1",
        productTitle: "Box",
        changes: [
          { imageId: "a", mediaId: "gid://shopify/MediaImage/1", alt: "Eins" },
          { imageId: "b", mediaId: null },
        ],
        policy: { ...base, autoTranslateExternalChanges: true, purgeUnreconciledSurfaces: true } as never,
        foreignLocales: ["en"],
        primaryLocale: "de",
      });
      return db.productImageAltTranslation.deleteMany;
    };
    expect(await run()).not.toHaveBeenCalled();
    // …and without the stand-down the stored answer still applies.
    expect(await run()).toHaveBeenCalledWith({
      where: { imageId: { in: ["b"] }, marketId: "", locale: { in: ["en"] } },
    });
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
      where: { imageId: { in: ["a"] }, locale: "en", marketId: "" },
    });
  });

  it("a confirmed removal of a SHARED medium clears every product's row of it", async () => {
    const { gateway, db } = deps();
    db.productImage.findMany.mockResolvedValue([{ id: "a" }, { id: "row-of-other-product" }]);
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
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalledWith({
      where: { imageId: { in: ["a", "row-of-other-product"] }, locale: "en", marketId: "" },
    });
  });

  it("a locale held only on ANOTHER product's row of the medium is re-read too; one deleteMany clears all", async () => {
    const { gateway, db } = deps();
    db.productImage.findMany.mockResolvedValue([{ id: "a" }, { id: "row-of-other-product" }]);
    // The fold confirms only "en"; "fr" sits on the other product's row only.
    removeAndVerifyAcrossLocales.mockResolvedValueOnce({ confirmedPairs: new Set(["en\u0000alt"]), userErrors: [] });
    db.productImageAltTranslation.findMany.mockResolvedValue([{ locale: "en" }, { locale: "fr" }, { locale: "fr" }]);
    removeAndVerify.mockResolvedValueOnce({ confirmedKeys: new Set(["alt"]), userErrors: [] });
    await repairChangedProductAlts({
      gateway: gateway as never,
      db: db as never,
      shop: "s",
      productId: "p",
      productTitle: "Box",
      changes: [{ imageId: "a", mediaId: "gid://shopify/MediaImage/1" }],
      policy: { ...base, purgeUnreconciledSurfaces: true } as never,
      foreignLocales: ["en", "fr"],
      primaryLocale: "de",
    });
    // The local-row lookup spans every cache row of the medium in the shop.
    expect((db.productImageAltTranslation.findMany.mock.calls as unknown as [[{ where: unknown }]])[0][0].where).toMatchObject({
      image: { mediaId: "gid://shopify/MediaImage/1", product: { shop: "s" } },
    });
    expect(removeAndVerify).toHaveBeenCalledTimes(1);
    expect(removeAndVerify).toHaveBeenCalledWith(gateway, "gid://shopify/MediaImage/1", ["alt"], "fr", "");
    expect(db.productImage.findMany).toHaveBeenCalledTimes(1);
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalledWith({
      where: { imageId: { in: ["a", "row-of-other-product"] }, locale: { in: ["en", "fr"] }, marketId: "" },
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

  it("a locale held only by a leftover LIBRARY row is re-read, and its row goes on confirmation", async () => {
    const { gateway, db } = deps();
    db.productImageAltTranslation.findMany.mockResolvedValue([]);
    db.contentTranslation.findMany.mockResolvedValue([{ locale: "fr" }]);
    removeAndVerifyAcrossLocales.mockResolvedValueOnce({ confirmedPairs: new Set(), userErrors: [] });
    await repairChangedProductAlts({
      gateway: gateway as never,
      db: db as never,
      shop: "s",
      productId: "p",
      productTitle: "Box",
      changes: [{ imageId: "a", mediaId: "gid://shopify/MediaImage/1" }],
      policy: { ...base, purgeUnreconciledSurfaces: true } as never,
      foreignLocales: ["fr"],
      primaryLocale: "de",
    });
    expect(removeAndVerify).toHaveBeenCalledTimes(1);
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

  it("a spent repair budget starts NO run and follows the stored deletion answer", async () => {
    const { gateway, db } = deps();
    policy.purgeUnreconciledSurfaces = true;
    const take = vi.fn(() => false);
    const ids = await repairAltsAfterWrite({
      gateway: gateway as never,
      db: db as never,
      shop: "s",
      snapshot,
      written: [{ mediaId: "gid://shopify/MediaImage/1", alt: "neu" }],
      repairBudget: { take },
    });
    policy.purgeUnreconciledSurfaces = false;
    // One group per (product, medium): the per-image save's own run.
    expect(take).toHaveBeenCalledWith("productAlt", "p1", "gid://shopify/MediaImage/1");
    expect(reconcileAfterPrimarySave).not.toHaveBeenCalled();
    expect(ids).toEqual([]);
    // The stored answer applied instead: the stale alt translations were purged.
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalled();
  });

  it("a budget with room changes nothing", async () => {
    const { gateway, db } = deps();
    const take = vi.fn(() => true);
    const ids = await repairAltsAfterWrite({
      gateway: gateway as never,
      db: db as never,
      shop: "s",
      snapshot,
      written: [{ mediaId: "gid://shopify/MediaImage/1", alt: "neu" }],
      repairBudget: { take },
    });
    expect(ids).toEqual(["t1"]);
  });
});
