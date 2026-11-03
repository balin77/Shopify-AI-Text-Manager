/**
 * The write path of the variant galleries: the main image is never stored in the
 * gallery metafield, and a variant that loses its main image gets the next image
 * of its gallery as the new one, in the same write. The real route action runs
 * against a scripted Shopify (graphql) and a fake database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const PRODUCT = "gid://shopify/Product/1";
const img = (n: number) => `gid://shopify/MediaImage/${n}`;
const vid = (n: number) => `gid://shopify/Video/${n}`;
const V1 = "gid://shopify/ProductVariant/1";
const V2 = "gid://shopify/ProductVariant/2";

type VariantState = { main: string | null; gallery: string[]; order?: string | null };
let variants: Record<string, VariantState>;
let productMedia: Record<string, string>; // gid -> mediaContentType
let calls: Array<{ name: string; variables: any }>;
let bulkErrors: Array<{ message: string }>;
let lookupFails: boolean;
const updateMany = vi.fn();

vi.mock("~/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      admin: {
        graphql: async (query: string, opts?: { variables?: any }) => {
          const name = /(query|mutation)\s+(\w+)/.exec(query)?.[2] ?? "?";
          calls.push({ name, variables: opts?.variables });
          const reply = (data: unknown) => ({ json: async () => data });
          if (name === "productMediaForGalleries") {
            if (lookupFails) return reply({ errors: [{ message: "boom" }] });
            return reply({
              data: {
                product: {
                  media: { nodes: Object.entries(productMedia).map(([id, mediaContentType]) => ({ id, mediaContentType })) },
                  variants: {
                    nodes: Object.entries(variants).map(([id, v]) => ({
                      id,
                      media: { nodes: v.main ? [{ id: v.main }] : [] },
                      gallery: { value: JSON.stringify(v.gallery) },
                      order: v.order ? { value: v.order } : null,
                    })),
                  },
                },
              },
            });
          }
          if (name === "productVariantsBulkUpdate") return reply({ data: { productVariantsBulkUpdate: { userErrors: bulkErrors } } });
          if (name === "metafieldsSet") return reply({ data: { metafieldsSet: { userErrors: [] } } });
          return reply({ data: {} });
        },
      },
      session: { shop: "s.myshopify.com" },
    }),
  },
}));
vi.mock("~/db.server", () => ({ db: { productVariant: { updateMany: (...a: unknown[]) => updateMany(...a) } } }));
vi.mock("~/routes/api.product-variants", () => ({ invalidateVariantDefsCache: vi.fn() }));

import { action } from "~/routes/api.update-variant-galleries";

async function post(body: Record<string, unknown>) {
  const request = new Request("http://localhost/api/update-variant-galleries", { method: "POST", body: JSON.stringify({ productId: PRODUCT, ...body }) });
  const res: any = await action({ request, params: {}, context: {} } as any);
  return res.data ?? res;
}
const bulk = () => calls.find((c) => c.name === "productVariantsBulkUpdate")?.variables.variants as any[] | undefined;
const galleryOf = (v: any) => JSON.parse(v.metafields.find((m: any) => m.key === "variant_gallery").value);
const orderWrites = () =>
  (calls.find((c) => c.name === "metafieldsSet")?.variables.metafields ?? []).filter((m: any) => m.key === "variant_gallery_order");

beforeEach(() => {
  calls = [];
  bulkErrors = [];
  lookupFails = false;
  updateMany.mockReset();
  productMedia = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [img(n), "IMAGE"]));
  variants = {
    [V1]: { main: img(1), gallery: [img(2), img(3)] },
    [V2]: { main: img(4), gallery: [img(5)] },
  };
});

describe("the main image is never stored in the gallery", () => {
  it("galleryOnly: a main image the client sent along is stripped, mediaId untouched", async () => {
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [img(1), img(2), img(3)], galleryOnly: true }] });
    expect(res.success).toBe(true);
    const v = bulk()![0];
    expect(galleryOf(v)).toEqual([img(2), img(3)]);
    expect("mediaId" in v).toBe(false);
  });

  it("a normal write: first file is the main image, the rest the gallery without a duplicate of it", async () => {
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(1), img(2), img(1), img(3)] }] });
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(1));
    expect(galleryOf(v)).toEqual([img(2), img(3)]);
  });
});

describe("the main image is removed: the next gallery image moves up in the same write", () => {
  it("delete of the medium (clear only): promoted from the stored gallery, and it leaves the metafield", async () => {
    // Shopify has already dropped the deleted medium from the variant.
    variants[V1].main = null;
    const res = await post({ clearVariantMainImages: [V1] });
    expect(res.success).toBe(true);
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(galleryOf(v)).toEqual([img(3)]);
    expect(updateMany).toHaveBeenCalledWith({ where: { shopifyGid: V1 }, data: { galleryJson: JSON.stringify([img(3)]) } });
  });

  it("main moved away on Save (clear + the editor gallery): same", async () => {
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3)] }], clearVariantMainImages: [V1] });
    expect(res.success).toBe(true);
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(galleryOf(v)).toEqual([img(3)]);
  });

  it("the old main is stripped even when the editor still sent it in the gallery", async () => {
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(1), img(2), img(3)] }], clearVariantMainImages: [V1] });
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(galleryOf(v)).toEqual([img(3)]);
  });

  it("nothing left in the gallery: the only case that ends with no main image", async () => {
    variants[V1].gallery = [];
    await post({ clearVariantMainImages: [V1] });
    const v = bulk()![0];
    expect(v.mediaId).toBeNull();
    expect(galleryOf(v)).toEqual([]);
  });

  it("only videos in the gallery: nothing can be a native image, the videos stay in the gallery", async () => {
    variants[V1].gallery = [vid(1), vid(2)];
    await post({ clearVariantMainImages: [V1] });
    const v = bulk()![0];
    expect(v.mediaId).toBeNull();
    expect(galleryOf(v)).toEqual([vid(1), vid(2)]);
  });

  it("a video first, an image behind it: the image moves up, the video stays", async () => {
    variants[V1].gallery = [vid(1), img(3)];
    await post({ clearVariantMainImages: [V1] });
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(3));
    expect(galleryOf(v)).toEqual([vid(1)]);
  });

  it("a file the product does not hold is skipped as a candidate (Shopify would refuse the whole save)", async () => {
    variants[V1].gallery = [img(99), img(3)];
    await post({ clearVariantMainImages: [V1] });
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(3));
    expect(galleryOf(v)).toEqual([img(99)]);
  });

  it("the visible order decides: the order JSON puts the third image first", async () => {
    variants[V1].order = JSON.stringify([
      { kind: "file", value: img(1) },
      { kind: "file", value: img(3) },
      { kind: "url", value: "https://youtu.be/x" },
      { kind: "file", value: img(2) },
    ]);
    await post({ clearVariantMainImages: [V1] });
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(3));
    expect(galleryOf(v)).toEqual([img(2)]);
    // The order stays consistent: new main first, the removed one gone.
    const order = JSON.parse(orderWrites()[0].value);
    expect(order).toEqual([
      { kind: "file", value: img(3) },
      { kind: "url", value: "https://youtu.be/x" },
      { kind: "file", value: img(2) },
    ]);
    expect(orderWrites()[0].ownerId).toBe(V1);
  });

  it("several variants lose their main image at once: each promotes its own next image", async () => {
    await post({ clearVariantMainImages: [V1, V2] });
    const [a, b] = bulk()!;
    expect([a.id, a.mediaId, galleryOf(a)]).toEqual([V1, img(2), [img(3)]]);
    expect([b.id, b.mediaId, galleryOf(b)]).toEqual([V2, img(5), []]);
  });

  it("Shopify refuses the promoted media: the save reports failure, nothing else is written, nothing is lost", async () => {
    bulkErrors = [{ message: "Media does not belong to the product" }];
    const res = await post({
      clearVariantMainImages: [V1],
      variantGalleryOrder: [{ variantId: V1, orderJson: JSON.stringify([{ kind: "file", value: img(2) }]) }],
    });
    expect(res.success).toBe(false);
    expect(res.errors.join(" ")).toContain("Media does not belong");
    // The promotion WAS attempted (and refused), in one write with the gallery change.
    expect(bulk()![0].mediaId).toBe(img(2));
    expect(updateMany).not.toHaveBeenCalled();
    expect(calls.some((c) => c.name === "metafieldsSet")).toBe(false);
  });

  it("without a lookup the rules still run on what the client sent", async () => {
    lookupFails = true;
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3)] }], clearVariantMainImages: [V1] });
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(galleryOf(v)).toEqual([img(3)]);
  });
});
