/**
 * After a plan downgrade replacements keep serving on the storefront, so Load
 * and Remove stay open on every plan; only a NEW replacement (Set) is gated.
 * A named market whose lookup came back empty is "could not read", not
 * "not an active market".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const read = vi.fn();
const remove = vi.fn();
const set = vi.fn();
vi.mock("../../app/services/localized-media/localized-media.server", () => ({
  readProductLocalizedMedia: read,
  removeLocalizedImage: remove,
  setLocalizedMedia: set,
}));
vi.mock("../../app/utils/shop-locales-cache.server", () => ({
  getCachedShopLocales: vi.fn(async () => [{ locale: "en", primary: true }, { locale: "de", primary: false }]),
}));
const loadMarkets = vi.fn();
vi.mock("../../src/services/shopify-content.service", () => ({
  ShopifyContentService: class {
    loadMarkets = loadMarkets;
  },
}));

const { handleLocalizedMediaAction } = await import("../../app/actions/product/localized-media.action");

const PRODUCT = "gid://shopify/Product/1";
const MEDIA = "gid://shopify/MediaImage/2";

function ctx(plan: string) {
  return {
    admin: { graphql: vi.fn() },
    session: { shop: "t.myshopify.com" },
    contentConfig: { resourceType: "Product" },
    aiSettings: { subscriptionPlan: plan },
  } as never;
}
function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const status = (r: unknown) => (r as { init?: { status?: number } }).init?.status ?? 200;
const body = (r: unknown) => (r as { data: Record<string, unknown> }).data;

beforeEach(() => {
  read.mockReset();
  remove.mockReset();
  set.mockReset();
  loadMarkets.mockReset();
});

describe("localized media actions below the plan", () => {
  it("still loads and removes on a Free plan", async () => {
    read.mockResolvedValue({ ok: true, entries: [], media: [], hasMetafield: false, foreignValue: true });
    const loaded = await handleLocalizedMediaAction(ctx("free"), form({ productId: PRODUCT }), "localizedMediaLoad");
    expect(status(loaded)).toBe(200);
    // The foreign-value flag reaches the client so it can say so.
    expect(body(loaded)).toMatchObject({ ok: true, foreignValue: true });

    remove.mockResolvedValue({ ok: true, entries: [], media: [] });
    const removed = await handleLocalizedMediaAction(
      ctx("free"),
      form({ productId: PRODUCT, sourceMediaId: MEDIA, locale: "de", marketId: "" }),
      "localizedMediaRemove",
    );
    expect(status(removed)).toBe(200);
    expect(remove).toHaveBeenCalled();
  });

  it("refuses a new replacement on a Free plan", async () => {
    const r = await handleLocalizedMediaAction(
      ctx("free"),
      form({ productId: PRODUCT, sourceMediaId: MEDIA, locale: "de", fileId: "gid://shopify/MediaImage/3" }),
      "localizedMediaSet",
    );
    expect(status(r)).toBe(403);
    expect(body(r)).toMatchObject({ code: "gated" });
    expect(set).not.toHaveBeenCalled();
  });

  it("answers readFailed when a named market's lookup came back empty", async () => {
    loadMarkets.mockResolvedValue({ markets: [] });
    const r = await handleLocalizedMediaAction(
      ctx("pro"),
      form({ productId: PRODUCT, sourceMediaId: MEDIA, locale: "de", marketId: "gid://shopify/Market/9", fileId: "gid://shopify/MediaImage/3" }),
      "localizedMediaSet",
    );
    expect(status(r)).toBe(502);
    expect(body(r)).toMatchObject({ ok: false, code: "readFailed" });
    expect(set).not.toHaveBeenCalled();
  });
});
