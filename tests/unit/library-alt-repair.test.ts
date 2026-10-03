/**
 * A changed PRIMARY alt of a media-library image (a file with no ProductImage
 * row) deletes its foreign alt translations: echo-verified on Shopify, market
 * layer through purgeMarketOverrides, local ContentTranslation("MediaImage")
 * rows only for confirmed removals, and only where the merchant has not
 * switched the deletion off.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const isPurgeOnPrimaryChangeEnabled = vi.fn(async () => true);
vi.mock("~/services/translations/translation-change-policy.server", () => ({ isPurgeOnPrimaryChangeEnabled }));
const fetchShopLocales = vi.fn(async () => [
  { locale: "de", primary: true, published: true },
  { locale: "en", primary: false, published: true },
  { locale: "fr", primary: false, published: false },
]);
vi.mock("~/services/sync-utils", () => ({ fetchShopLocales }));
const purgeMarketOverrides = vi.fn(async () => 0);
vi.mock("~/services/translations/market-layer-purge.server", () => ({ purgeMarketOverrides }));
vi.mock("~/services/translations/stale-translation-sync.server", () => ({
  contentTranslationMirror: vi.fn(() => ({ kind: "content-mirror" })),
}));
const removeAndVerifyAcrossLocales = vi.fn(async (_g: unknown, _id: string, _k: string[], locales: string[]) => ({
  confirmedPairs: new Set(locales.map((l) => `${l}\u0000alt`)),
  userErrors: [],
}));
const removeAndVerify = vi.fn(async () => ({ confirmedKeys: new Set<string>(), userErrors: [] }));
vi.mock("~/services/translations/verified-translations.server", () => ({
  removeAndVerify,
  removeAndVerifyAcrossLocales,
  LOCALE_KEY_SEP: "\u0000",
}));

const { snapshotLibraryAlts, purgeLibraryAltTranslationsAfterWrite } = await import(
  "~/services/translations/library-alt-repair.server"
);

const MEDIA = "gid://shopify/MediaImage/9";

function makeDb(opts: { libraryRows?: Array<{ id: string; altText: string | null; usageKind?: string }>; productRows?: Array<{ mediaId: string }>; local?: string[] } = {}) {
  return {
    mediaLibraryImage: { findMany: vi.fn(async () => opts.libraryRows ?? [{ id: MEDIA, altText: "old alt" }]) },
    productImage: { findMany: vi.fn(async () => opts.productRows ?? []) },
    contentTranslation: {
      findMany: vi.fn(async () => (opts.local ?? ["en"]).map((locale) => ({ locale }))),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
}
const gateway = { graphql: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  isPurgeOnPrimaryChangeEnabled.mockResolvedValue(true);
  removeAndVerify.mockResolvedValue({ confirmedKeys: new Set<string>(), userErrors: [] });
});

describe("snapshotLibraryAlts", () => {
  it("reads library images and leaves product media to the product repair", async () => {
    const db = makeDb({
      libraryRows: [
        { id: MEDIA, altText: "old alt" },
        { id: "gid://shopify/MediaImage/10", altText: "x" },
      ],
      productRows: [{ mediaId: "gid://shopify/MediaImage/10" }],
    });
    const snap = await snapshotLibraryAlts(db as never, "s", [MEDIA, "gid://shopify/MediaImage/10"]);
    expect([...snap.keys()]).toEqual([MEDIA]);
    expect(snap.get(MEDIA)?.altText).toBe("old alt");
  });

  it("a cache row that says usageKind product is not provably a library file: left alone", async () => {
    const db = makeDb({ libraryRows: [{ id: MEDIA, altText: "old alt", usageKind: "product" } as never] });
    expect((await snapshotLibraryAlts(db as never, "s", [MEDIA])).size).toBe(0);
  });

  it("a failed read is an empty snapshot", async () => {
    const db = makeDb();
    db.mediaLibraryImage.findMany.mockRejectedValueOnce(new Error("db"));
    expect((await snapshotLibraryAlts(db as never, "s", [MEDIA])).size).toBe(0);
  });
});

describe("purgeLibraryAltTranslationsAfterWrite", () => {
  const snapshot = new Map([[MEDIA, { altText: "old alt" }]]);

  it("a changed alt: echo-verified removal in every foreign locale, market layer, confirmed local rows deleted", async () => {
    const db = makeDb();
    const purged = await purgeLibraryAltTranslationsAfterWrite({
      gateway: gateway as never, db: db as never, shop: "s", snapshot, written: [{ mediaId: MEDIA, alt: "new alt" }],
    });
    expect(purged).toEqual([MEDIA]);
    expect(isPurgeOnPrimaryChangeEnabled).toHaveBeenCalledWith("s", db, { reconciled: false });
    // unpublished locales are foreign locales too
    expect(removeAndVerifyAcrossLocales).toHaveBeenCalledWith(gateway, MEDIA, ["alt"], ["en", "fr"], "");
    expect(purgeMarketOverrides).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: [{ resourceId: MEDIA, resourceType: "MediaImage" }],
        locales: ["en", "fr"],
        keys: ["alt"],
      }),
    );
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledWith({
      where: { shop: "s", resourceType: "MediaImage", resourceId: MEDIA, key: "alt", marketId: "", locale: { in: ["en", "fr"] } },
    });
  });

  it("only market overrides removed: the media is still reported so the client re-reads", async () => {
    purgeMarketOverrides.mockResolvedValueOnce(2);
    removeAndVerifyAcrossLocales.mockResolvedValueOnce({ confirmedPairs: new Set(), userErrors: [] });
    const db = makeDb({ local: [] });
    const purged = await purgeLibraryAltTranslationsAfterWrite({
      gateway: gateway as never, db: db as never, shop: "s", snapshot, written: [{ mediaId: MEDIA, alt: "new alt" }],
    });
    expect(purged).toEqual([MEDIA]);
  });

  it("an unchanged alt (trimmed) deletes nothing and asks nothing", async () => {
    const db = makeDb();
    const purged = await purgeLibraryAltTranslationsAfterWrite({
      gateway: gateway as never, db: db as never, shop: "s", snapshot, written: [{ mediaId: MEDIA, alt: "  old alt " }],
    });
    expect(purged).toEqual([]);
    expect(isPurgeOnPrimaryChangeEnabled).not.toHaveBeenCalled();
    expect(removeAndVerifyAcrossLocales).not.toHaveBeenCalled();
  });

  it("an image the cache did not know has no 'before': nothing is deleted", async () => {
    const db = makeDb();
    const purged = await purgeLibraryAltTranslationsAfterWrite({
      gateway: gateway as never, db: db as never, shop: "s", snapshot: new Map(), written: [{ mediaId: MEDIA, alt: "new" }],
    });
    expect(purged).toEqual([]);
    expect(removeAndVerifyAcrossLocales).not.toHaveBeenCalled();
  });

  it("the merchant switched deletion off: the translations are kept", async () => {
    isPurgeOnPrimaryChangeEnabled.mockResolvedValue(false);
    const db = makeDb();
    const purged = await purgeLibraryAltTranslationsAfterWrite({
      gateway: gateway as never, db: db as never, shop: "s", snapshot, written: [{ mediaId: MEDIA, alt: "new alt" }],
    });
    expect(purged).toEqual([]);
    expect(removeAndVerifyAcrossLocales).not.toHaveBeenCalled();
    expect(purgeMarketOverrides).not.toHaveBeenCalled();
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("a removal Shopify did not echo keeps the local row (re-read decides)", async () => {
    removeAndVerifyAcrossLocales.mockResolvedValueOnce({ confirmedPairs: new Set(), userErrors: [] });
    const db = makeDb({ local: ["en"] });
    const purged = await purgeLibraryAltTranslationsAfterWrite({
      gateway: gateway as never, db: db as never, shop: "s", snapshot, written: [{ mediaId: MEDIA, alt: "new alt" }],
    });
    expect(removeAndVerify).toHaveBeenCalledTimes(1);
    expect(removeAndVerify).toHaveBeenCalledWith(gateway, MEDIA, ["alt"], "en", "");
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
    expect(purged).toEqual([]);
  });

  it("a locale confirmed only by the re-read is deleted locally, the others stay", async () => {
    removeAndVerifyAcrossLocales.mockResolvedValueOnce({ confirmedPairs: new Set(), userErrors: [] });
    removeAndVerify.mockResolvedValueOnce({ confirmedKeys: new Set(["alt"]), userErrors: [] });
    const db = makeDb({ local: ["en"] });
    const purged = await purgeLibraryAltTranslationsAfterWrite({
      gateway: gateway as never, db: db as never, shop: "s", snapshot, written: [{ mediaId: MEDIA, alt: "new alt" }],
    });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ locale: { in: ["en"] }, marketId: "" }),
    });
    expect(purged).toEqual([MEDIA]);
  });

  it("never throws: a failing Shopify call is logged and the local rows stay", async () => {
    removeAndVerifyAcrossLocales.mockRejectedValueOnce(new Error("throttled"));
    const db = makeDb();
    await expect(
      purgeLibraryAltTranslationsAfterWrite({
        gateway: gateway as never, db: db as never, shop: "s", snapshot, written: [{ mediaId: MEDIA, alt: "new alt" }],
      }),
    ).resolves.toEqual([]);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("a single-language shop (or failed locale lookup) sends nothing", async () => {
    fetchShopLocales.mockResolvedValueOnce([{ locale: "de", primary: true, published: true }]);
    const db = makeDb();
    const purged = await purgeLibraryAltTranslationsAfterWrite({
      gateway: gateway as never, db: db as never, shop: "s", snapshot, written: [{ mediaId: MEDIA, alt: "new alt" }],
    });
    expect(purged).toEqual([]);
    expect(removeAndVerifyAcrossLocales).not.toHaveBeenCalled();
  });
});
