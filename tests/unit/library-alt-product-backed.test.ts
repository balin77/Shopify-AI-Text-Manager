/**
 * A media-library file must stay a library file after an alt-text template
 * apply (no ProductImage row is created for it), and a file that ALREADY holds
 * both a ProductImage row and leftover library rows still shows its foreign
 * alts in the image manager. Writers retire the library rows of a
 * product-backed medium, so nothing shows that Shopify no longer has.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loggers: new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock("~/utils/translation-save-lock.server", () => ({
  markTranslationSaved: vi.fn(),
  isTranslationRecentlySaved: vi.fn().mockReturnValue(false),
}));

const SHOP = "s.myshopify.com";
const LIB = "gid://shopify/MediaImage/900";
const PROD = "gid://shopify/MediaImage/1";

function makeDb(opts: { productRows?: Array<{ id: string; mediaId: string }>; libUsage?: string | null }) {
  const productRows = opts.productRows ?? [];
  const self: any = {
    productImage: {
      findFirst: vi.fn(async ({ where }: any) => productRows.find((r) => r.mediaId === where.mediaId) ?? null),
      findMany: vi.fn(async ({ where }: any) => {
        const wanted: string[] = typeof where.mediaId === "string" ? [where.mediaId] : where.mediaId.in;
        return productRows.filter((r) => wanted.includes(r.mediaId));
      }),
      upsert: vi.fn(async () => ({ id: "new" })),
    },
    mediaLibraryImage: {
      findFirst: vi.fn(async ({ where }: any) =>
        opts.libUsage === undefined || where.id !== LIB ? null : { usageKind: opts.libUsage },
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    productImageAltTranslation: {
      findMany: vi.fn(async () => [] as any[]),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    contentTranslation: {
      findMany: vi.fn(async () => [] as any[]),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn: any) => fn(self)),
  };
  return self;
}

beforeEach(() => vi.clearAllMocks());

describe("persistAltText (alt-text template apply)", () => {
  it("a library file gets NO ProductImage row; foreign alt goes to the library mirror", async () => {
    const { persistAltText } = await import("~/services/image-alt-template-persist.server");
    const db = makeDb({ libUsage: "unknown" });
    await persistAltText(db, "p1", LIB, SHOP, "de", false, "Kiste", { graphql: vi.fn() } as any);
    expect(db.productImage.upsert).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
    const call = db.contentTranslation.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject({ resourceType: "MediaImage", resourceId: LIB, key: "alt", locale: "de", marketId: "", value: "Kiste" });
  });

  it("a library file's primary alt only updates the library cache", async () => {
    const { persistAltText } = await import("~/services/image-alt-template-persist.server");
    const db = makeDb({ libUsage: "unknown" });
    await persistAltText(db, "p1", LIB, SHOP, "en", true, "Box", { graphql: vi.fn() } as any);
    expect(db.productImage.upsert).not.toHaveBeenCalled();
    expect(db.mediaLibraryImage.updateMany).toHaveBeenCalledWith({ where: { shop: SHOP, id: LIB }, data: { altText: "Box" } });
  });

  it("a product medium (row exists) keeps the product path", async () => {
    const { persistAltText } = await import("~/services/image-alt-template-persist.server");
    const db = makeDb({ productRows: [{ id: "row-a", mediaId: PROD }], libUsage: undefined });
    await persistAltText(db, "p1", PROD, SHOP, "en", true, "Box", { graphql: vi.fn() } as any);
    expect(db.productImage.upsert).toHaveBeenCalled();
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it("a medium unknown to both caches keeps the product path", async () => {
    const { persistAltText } = await import("~/services/image-alt-template-persist.server");
    const db = makeDb({ libUsage: undefined });
    const admin = { graphql: vi.fn(async () => ({ json: async () => ({ data: { node: { image: { url: "https://cdn.shopify.com/x.jpg" } } } }) })) };
    await persistAltText(db, "p1", LIB, SHOP, "en", true, "Box", admin as any);
    expect(db.productImage.upsert).toHaveBeenCalled();
  });
});

describe("mirrorProductMediaAlt retires leftover library rows", () => {
  it("a write onto a product-backed medium deletes the library rows of that layer", async () => {
    const { mirrorProductMediaAlt } = await import("~/services/translations/verified-translations.server");
    const db = makeDb({ productRows: [{ id: "row-a", mediaId: PROD }] });
    const r = await mirrorProductMediaAlt(db, { shop: SHOP, mediaId: PROD, locale: "de", value: "Kiste", marketId: "" });
    expect(r).toBe("mirrored");
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledWith({
      where: { shop: SHOP, resourceType: "MediaImage", resourceId: PROD, key: "alt", locale: { in: ["de"] }, marketId: "" },
    });
  });

  it("a removal deletes them too, and an unknown image touches nothing", async () => {
    const { mirrorProductMediaAlt } = await import("~/services/translations/verified-translations.server");
    const db = makeDb({ productRows: [{ id: "row-a", mediaId: PROD }] });
    await mirrorProductMediaAlt(db, { shop: SHOP, mediaId: PROD, locale: ["de", "fr"], value: "" });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    const gone = makeDb({});
    expect(await mirrorProductMediaAlt(gone, { shop: SHOP, mediaId: PROD, locale: "de", value: "x" })).toBe("imageGone");
    expect(gone.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });
});

describe("loadImageAltTranslations read fallback", () => {
  async function load(db: any, marketId = "") {
    const { handleLoadImageAltTranslations } = await import("~/actions/content/alt-text.action");
    const fd = new FormData();
    fd.set("productId", "p1");
    fd.set("locale", "de");
    if (marketId) fd.set("marketId", marketId);
    fd.set("mediaIds", JSON.stringify([PROD]));
    const res: any = await handleLoadImageAltTranslations({ db, session: { shop: SHOP }, itemId: "p1" } as never, fd);
    return (res.data ?? res).altTexts as Record<string, string>;
  }

  it("a product-backed medium with only library rows shows them", async () => {
    const db = makeDb({ productRows: [{ id: "row-a", mediaId: PROD }] });
    db.contentTranslation.findMany.mockResolvedValue([{ resourceId: PROD, marketId: "", value: "Kiste" }]);
    expect((await load(db))[PROD]).toBe("Kiste");
  });

  it("product rows win over a library row of the same layer", async () => {
    const db = makeDb({ productRows: [{ id: "row-a", mediaId: PROD }] });
    db.productImageAltTranslation.findMany.mockResolvedValue([
      { altText: "Neu", marketId: "", image: { mediaId: PROD, productId: "p1" } },
    ]);
    db.contentTranslation.findMany.mockResolvedValue([{ resourceId: PROD, marketId: "", value: "Alt" }]);
    expect((await load(db))[PROD]).toBe("Neu");
  });

  it("an empty library value is no translation for a product-backed medium", async () => {
    const db = makeDb({ productRows: [{ id: "row-a", mediaId: PROD }] });
    db.contentTranslation.findMany.mockResolvedValue([{ resourceId: PROD, marketId: "", value: null }]);
    expect((await load(db))[PROD]).toBeUndefined();
  });
});
