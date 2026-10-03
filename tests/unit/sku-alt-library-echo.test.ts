/**
 * The SKU generator's fileUpdate counts as written only when Shopify ECHOES the
 * file with the sent alt: cache mirrors, product repair and the library purge
 * ride on that alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileUpdateEchoConfirms } from "~/utils/file-update-echo.server";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const purge = vi.fn(async () => [] as string[]);
const snapshotLibraryAlts = vi.fn(async () => new Map());
vi.mock("~/services/translations/library-alt-repair.server", () => ({
  snapshotLibraryAlts,
  purgeLibraryAltTranslationsAfterWrite: purge,
}));
const repairAltsAfterWrite = vi.fn(async () => [] as string[]);
vi.mock("~/services/translations/product-alt-repair.server", () => ({
  snapshotProductAlts: vi.fn(async () => new Map()),
  repairAltsAfterWrite,
}));

const { handleGenerateAltTextFromSku } = await import("~/actions/content/alt-text.action");

const MEDIA = "gid://shopify/MediaImage/9";

function ctxWith(payload: unknown) {
  const db = {
    productVariant: { findMany: vi.fn(async () => [{ sku: "A1", galleryJson: JSON.stringify([MEDIA]) }]) },
    productImage: { updateMany: vi.fn(async () => ({ count: 0 })) },
    mediaLibraryImage: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const admin = { graphql: vi.fn(async () => ({ json: async () => payload })) };
  return { db, admin, ctx: { db, admin, session: { shop: "s" } } };
}
function form() {
  const fd = new FormData();
  fd.append("mediaId", MEDIA);
  fd.append("productId", "gid://shopify/Product/1");
  return fd;
}

beforeEach(() => vi.clearAllMocks());

describe("fileUpdateEchoConfirms", () => {
  it("needs the echoed entry with the sent alt", () => {
    expect(fileUpdateEchoConfirms([{ id: MEDIA, alt: "A1" }], MEDIA, "A1")).toBe(true);
    expect(fileUpdateEchoConfirms([{ id: MEDIA, alt: " A1 " }], MEDIA, "A1")).toBe(true);
    expect(fileUpdateEchoConfirms([{ id: MEDIA, alt: "other" }], MEDIA, "A1")).toBe(false);
    expect(fileUpdateEchoConfirms([], MEDIA, "A1")).toBe(false);
    expect(fileUpdateEchoConfirms(null, MEDIA, "A1")).toBe(false);
  });
});

describe("handleGenerateAltTextFromSku", () => {
  it("null payload: no mirror, no repair, no purge", async () => {
    const { db, ctx } = ctxWith({ data: { fileUpdate: null } });
    const res = (await handleGenerateAltTextFromSku(ctx as never, form())) as unknown as { init?: { status?: number } };
    expect(res.init?.status).toBe(502);
    expect(db.mediaLibraryImage.updateMany).not.toHaveBeenCalled();
    expect(db.productImage.updateMany).not.toHaveBeenCalled();
    expect(repairAltsAfterWrite).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
  });

  it("echoed write: mirrors the library cache and runs the purge", async () => {
    const { db, ctx } = ctxWith({
      data: { fileUpdate: { files: [{ id: MEDIA, alt: "A1" }], userErrors: [] } },
    });
    await handleGenerateAltTextFromSku(ctx as never, form());
    expect(db.mediaLibraryImage.updateMany).toHaveBeenCalledWith({
      where: { shop: "s", id: MEDIA },
      data: { altText: "A1" },
    });
    expect(purge).toHaveBeenCalledWith(expect.objectContaining({ written: [{ mediaId: MEDIA, alt: "A1" }] }));
  });
});
