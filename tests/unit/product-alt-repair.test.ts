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

const { repairChangedProductAlts, altRepairRetranslates } = await import(
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
    db: { productImageAltTranslation: { deleteMany: vi.fn(async () => ({ count: 1 })) } },
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
    expect(gateway.graphql).toHaveBeenCalledTimes(1);
    expect(db.productImageAltTranslation.deleteMany).toHaveBeenCalledWith({
      where: { imageId: { in: ["a"] }, marketId: "", locale: { in: ["en"] } },
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

  it("without a primary locale nothing can be translated FROM", () => {
    expect(altRepairRetranslates({ ...base, autoTranslateExternalChanges: true } as never, ["en"], "")).toBe(false);
  });
});
