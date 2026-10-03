/**
 * Bulk editor image rows: an image with a ProductImage row AND leftover
 * ContentTranslation("MediaImage") alt rows (the old template apply created
 * the row) reads them as a per-layer FALLBACK -- product rows win, empty
 * values are ignored, and a covered alt is not reported as missing.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loggers: new Proxy({}, { get: () => vi.fn() }),
}));

const SHOP = "s.myshopify.com";
const BACKED = "gid://shopify/MediaImage/1";
const LIBRARY = "gid://shopify/MediaImage/900";
const KEY = (locale: string, market: string) => `${locale}|${market}|field.altText`;

function rows() {
  return [
    { id: BACKED, imageCacheId: "cache-1" },
    { id: LIBRARY },
  ] as any[];
}

function makeDb(opts: { product?: any[]; library?: any[] }) {
  return {
    productImageAltTranslation: { findMany: vi.fn(async () => opts.product ?? []) },
    contentTranslation: { findMany: vi.fn(async () => opts.library ?? []) },
  } as any;
}

describe("attachImageAltForeignValues", () => {
  it("falls back to library rows for a product-backed image, per layer", async () => {
    const { attachImageAltForeignValues } = await import("~/services/bulk-editor/load.server");
    const db = makeDb({
      product: [{ imageId: "cache-1", altText: "Produkt global", marketId: "" }],
      library: [
        { resourceId: BACKED, value: "Alt global", marketId: "" },
        { resourceId: BACKED, value: "Markt", marketId: "gid://shopify/Market/7" },
        { resourceId: LIBRARY, value: "Bibliothek", marketId: "" },
      ],
    });
    const r = rows();
    await attachImageAltForeignValues(db, SHOP, { locale: "de", marketId: "gid://shopify/Market/7" } as any, r);
    expect(r[0].foreignValues).toEqual({
      [KEY("de", "")]: "Produkt global",
      [KEY("de", "gid://shopify/Market/7")]: "Markt",
    });
    expect(r[1].foreignValues).toEqual({ [KEY("de", "")]: "Bibliothek" });
  });

  it("a backed image with only library rows shows them; empty ones are ignored", async () => {
    const { attachImageAltForeignValues } = await import("~/services/bulk-editor/load.server");
    const db = makeDb({
      library: [
        { resourceId: BACKED, value: "Kiste", marketId: "" },
        { resourceId: "gid://shopify/MediaImage/2", value: "  ", marketId: "" },
      ],
    });
    const r = [{ id: BACKED, imageCacheId: "cache-1" }, { id: "gid://shopify/MediaImage/2", imageCacheId: "cache-2" }] as any[];
    await attachImageAltForeignValues(db, SHOP, { locale: "de", marketId: "" } as any, r);
    expect(r[0].foreignValues).toEqual({ [KEY("de", "")]: "Kiste" });
    expect(r[1].foreignValues).toBeUndefined();
  });
});

describe("missing-translation checks", () => {
  it("the grid flags do not mark a fallback-covered alt as missing", async () => {
    const { attachMissingTranslationFlags } = await import("~/services/bulk-editor/load.server");
    const db = makeDb({ library: [{ resourceId: BACKED, locale: "de", value: "Kiste" }] });
    const r = [{ id: BACKED, imageCacheId: "cache-1" }] as any[];
    await attachMissingTranslationFlags(db, SHOP, { type: "image", foreignLocales: ["de", "fr"], locale: "", marketId: "" } as any, r);
    expect(r[0].untranslatedLocalesByColumnId["field.altText"]).toEqual(["fr"]);
  });

  it("the candidate scan reads the library store for backed rows too", async () => {
    const { loadTranslatedLocales } = await import("~/services/bulk-editor/missing-translations.server");
    const db = makeDb({ library: [{ resourceId: BACKED, locale: "de", value: "Kiste" }, { resourceId: BACKED, locale: "fr", value: "" }] });
    const map = await loadTranslatedLocales(
      db,
      SHOP,
      { type: "image", foreignLocales: ["de", "fr"] } as any,
      [{ id: BACKED, imageCacheId: "cache-1" }] as any[],
      ["alt"],
    );
    expect([...(map.get(BACKED)?.get("alt") ?? [])]).toEqual(["de"]);
  });
});
